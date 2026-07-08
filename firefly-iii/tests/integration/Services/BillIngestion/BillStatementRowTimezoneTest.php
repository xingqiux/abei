<?php

declare(strict_types=1);

namespace Tests\integration\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\Account;
use FireflyIII\Models\AccountType;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\Services\BillIngestion\BillStatementRowImportService;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\integration\TestCase;

/**
 * Regression tests for the single-conversion timezone convention (issue #14),
 * documented in docs/bill-statement-timezone-convention.md.
 *
 * These run under whatever app timezone the suite is configured with (the
 * default test harness tz is Europe/Amsterdam, i.e. NOT Asia/Shanghai). That
 * is deliberate: it proves BillStatementLocalDateTimeCast pins the bill
 * statement local-time columns to Asia/Shanghai regardless of app.timezone,
 * so the same DB row always resolves to the same absolute instant. Without the
 * cast (plain 'datetime'), the round-trip below drifts by the offset between
 * the ambient app tz and Asia/Shanghai.
 *
 * @internal
 */
final class BillStatementRowTimezoneTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The bill statement local-time columns must round-trip to the SAME
     * absolute instant no matter what app.timezone the reader runs under.
     */
    public function testOccurredAtRoundTripsToSameInstantRegardlessOfAppTimezone(): void
    {
        // Guard: the point of this test only holds when the ambient tz differs
        // from Asia/Shanghai. The harness default (Europe/Amsterdam) satisfies
        // this; skip loudly if someone forces TZ=Asia/Shanghai.
        self::assertNotSame(
            'Asia/Shanghai',
            config('app.timezone'),
            'This regression test must run under a non-Asia/Shanghai app timezone to be meaningful.'
        );

        $user  = $this->makeUser('tz-roundtrip@test.com');
        $task  = $this->makeTask($user, 'alipay');
        $realBeijing = Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai');

        $row = $this->makeRow($user, $task, [
            'occurred_at'  => $realBeijing->clone(),
            'firefly_date' => $realBeijing->clone(),
            'amount'       => '21.00',
            'description'  => '1点点',
        ]);
        $row->refresh();

        // Same absolute instant (05:35 UTC), whatever the app tz is.
        self::assertSame(
            '2026-06-23 05:35:00',
            $row->occurred_at->clone()->setTimezone('UTC')->toDateTimeString()
        );
        self::assertSame(
            '2026-06-23 05:35:00',
            $row->firefly_date->clone()->setTimezone('UTC')->toDateTimeString()
        );
        // ...and the correct Beijing wall clock when viewed in Asia/Shanghai.
        self::assertSame(
            '2026-06-23 13:35',
            $row->occurred_at->clone()->setTimezone('Asia/Shanghai')->format('Y-m-d H:i')
        );
    }

    /**
     * The three real duplicate scenarios from issue #14: a statement row must
     * import into a Firefly transaction whose date resolves to the correct
     * Beijing time, with no +8h / +16h drift.
     *
     */
    #[DataProvider('realScenarioProvider')]
    public function testStatementRowImportsWithCorrectBeijingTime(
        string $beijingTime,
        string $amount,
        string $description,
    ): void {
        $user    = $this->makeUser("scenario-{$description}@test.com");
        $this->makeAssetAccount($user, '招商银行');
        $task    = $this->makeTask($user, 'alipay');
        $occurred = Carbon::parse($beijingTime, 'Asia/Shanghai');

        $row = $this->makeRow($user, $task, [
            'occurred_at'         => $occurred->clone(),
            'firefly_date'        => $occurred->clone(),
            'amount'              => $amount,
            'firefly_amount'      => $amount,
            'description'         => $description,
            'firefly_description' => $description,
            'source_name'         => '招商银行',
            'destination_name'    => $description,
        ]);

        $service = app(BillStatementRowImportService::class);
        $result  = $service->importTaskRows($user, $task->id, [$row->id], true);

        self::assertSame(1, $result['summary']['imported'], 'row should import cleanly');

        $row->refresh();
        self::assertNotNull($row->transaction_group_id);

        $journal = $row->transactionGroup->transactionJournals()->first()->fresh();
        // No drift: the stored transaction resolves to the exact Beijing time.
        self::assertSame(
            $occurred->clone()->setTimezone('Asia/Shanghai')->format('Y-m-d H:i'),
            $journal->date->clone()->setTimezone('Asia/Shanghai')->format('Y-m-d H:i'),
            'transaction date drifted from the real Beijing time'
        );
        self::assertSame(
            $occurred->clone()->setTimezone('UTC')->toDateTimeString(),
            $journal->date->clone()->setTimezone('UTC')->toDateTimeString(),
            'transaction instant drifted from the real time'
        );
    }

    /**
     * @return array<string, array{string, string, string}>
     */
    public static function realScenarioProvider(): array
    {
        return [
            '1点点'   => ['2026-06-23 13:35:00', '21.00', '1点点'],
            '柠季'    => ['2026-06-23 13:01:00', '16.40', '柠季'],
            '海王星辰' => ['2026-06-23 10:07:00', '33.34', '海王星辰'],
        ];
    }

    private function makeUser(string $email): User
    {
        $group = UserGroup::create(['title' => $email]);
        $role  = UserRole::where('title', 'owner')->first();
        $user  = User::create(['email' => $email, 'password' => 'password', 'user_group_id' => $group->id]);
        GroupMembership::create(['user_id' => $user->id, 'user_group_id' => $group->id, 'user_role_id' => $role->id]);

        return $user;
    }

    private function makeAssetAccount(User $user, string $name): Account
    {
        $accountType = AccountType::where('type', 'Asset account')->firstOrFail();

        return Account::query()->create([
            'user_id'         => $user->id,
            'user_group_id'   => $user->user_group_id,
            'account_type_id' => $accountType->id,
            'name'            => $name,
            'active'          => true,
            'encrypted'       => false,
            'order'           => 0,
        ]);
    }

    private function makeTask(User $user, string $source): BillTask
    {
        return BillTask::query()->create([
            'user_id'     => $user->id,
            'source'      => $source,
            'status'      => 'parsed',
            'received_at' => Carbon::now('Asia/Shanghai'),
            'summary'     => 'tz regression',
        ]);
    }

    /**
     * @param array<string, mixed> $overrides
     */
    private function makeRow(User $user, BillTask $task, array $overrides): BillStatementRow
    {
        $artifact = BillArtifact::query()->create([
            'bill_task_id' => $task->id,
            'kind'         => 'zip',
            'filename'     => 'x.zip',
            'encrypted'    => false,
        ]);
        $import = BillStatementImport::query()->create([
            'user_id'           => $user->id,
            'bill_task_id'      => $task->id,
            'bill_artifact_id'  => $artifact->id,
            'source'            => $task->source,
            'profile_id'        => $task->source . '-statement',
            'original_filename' => 'x.csv',
            'archived_filename' => 'x.csv',
            'row_count'         => 1,
            'status'            => 'parsed',
        ]);

        return BillStatementRow::query()->create(array_merge([
            'user_id'                  => $user->id,
            'bill_task_id'             => $task->id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => 1,
            'status'                   => 'pending',
            'direction'                => '支出',
            'payment_method'           => '招商银行储蓄卡',
            'counterparty'             => '淘宝闪购',
            'firefly_type'             => 'withdrawal',
            'duplicate_state'          => 'unique',
            'raw_data'                 => [],
            'editable_data'            => [],
        ], $overrides));
    }
}
