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
use FireflyIII\Services\BillIngestion\BillStatementRowSummaryService;
use FireflyIII\Services\BillIngestion\CrossSourceDuplicateMatcher;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Collection;
use Tests\integration\TestCase;

/**
 * Cross-source deduplication (issue #14): a candidate statement row must be
 * matched against EXISTING Firefly transactions from other sources using loose
 * multi-field similarity (amount + asset account + merchant + ±24h window),
 * even when there is no shared order id -- the 1点点 / 柠季 / 海王星辰 scenario
 * where a manual/OCR entry and an Alipay-email import describe one purchase.
 *
 * @internal
 */
final class CrossSourceDuplicateMatcherTest extends TestCase
{
    use RefreshDatabase;

    public function testMatchesManualRowAgainstExistingAlipayTransactionSameMerchant(): void
    {
        $user = $this->makeUser('cross-1@test.com');
        $this->makeAssetAccount($user, '招商银行');

        // Existing Firefly transaction, as if imported earlier from the Alipay
        // email: 招商银行 -> 淘宝闪购, description "1点点", -21.00, 13:35.
        $this->importExistingTransaction($user, [
            'firefly_amount'      => '21.00',
            'firefly_description' => '1点点',
            'source_name'         => '招商银行',
            'destination_name'    => '淘宝闪购',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
        ]);

        // New pending manual/OCR row for the SAME purchase, no order id, the
        // merchant captured directly as "1点点".
        $manual = $this->makePendingRow($user, [
            'firefly_amount'      => '21.00',
            'firefly_description' => '1点点',
            'destination_name'    => '1点点',
            'source_name'         => '招商银行',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
        ]);

        $matches = $this->match($user, $manual);

        self::assertCount(1, $matches);
        self::assertSame('high', $matches[0]['confidence']);
        self::assertSame('skip', $matches[0]['suggestion']);
        self::assertContains('amount', $matches[0]['matched_on']);
        self::assertContains('account', $matches[0]['matched_on']);
        self::assertContains('merchant_exact', $matches[0]['matched_on']);
        self::assertContains('same_day', $matches[0]['matched_on']);
    }

    public function testMatchesWhenExistingDescriptionContainsMerchantAsSubstring(): void
    {
        $user = $this->makeUser('cross-2@test.com');
        $this->makeAssetAccount($user, '招商银行');
        $this->importExistingTransaction($user, [
            'firefly_amount'      => '16.40',
            'firefly_description' => '淘宝闪购 柠季',
            'source_name'         => '招商银行',
            'destination_name'    => '淘宝闪购',
            'occurred_at'         => Carbon::parse('2026-06-23 13:01:00', 'Asia/Shanghai'),
        ]);
        $manual = $this->makePendingRow($user, [
            'firefly_amount'      => '16.40',
            'firefly_description' => '柠季',
            'destination_name'    => '柠季',
            'source_name'         => '招商银行',
            'occurred_at'         => Carbon::parse('2026-06-23 13:01:00', 'Asia/Shanghai'),
        ]);

        $matches = $this->match($user, $manual);

        self::assertCount(1, $matches);
        self::assertSame('medium', $matches[0]['confidence']);
        self::assertSame('review', $matches[0]['suggestion']);
        self::assertContains('merchant_similar', $matches[0]['matched_on']);
    }

    public function testMatchesViaOrderIdWhenDescriptionEmbedsIt(): void
    {
        $user = $this->makeUser('cross-3@test.com');
        $this->makeAssetAccount($user, '招商银行');
        // Existing transaction whose description embeds the order number but a
        // DIFFERENT merchant text than the candidate.
        $this->importExistingTransaction($user, [
            'firefly_amount'      => '33.34',
            'firefly_description' => '订单 TB20260623X00107 海王星辰',
            'source_name'         => '招商银行',
            'destination_name'    => '海王星辰',
            'occurred_at'         => Carbon::parse('2026-06-23 10:07:00', 'Asia/Shanghai'),
        ]);
        $manual = $this->makePendingRow($user, [
            'firefly_amount'      => '33.34',
            'firefly_description' => '奥利司他',
            'destination_name'    => '奥利司他胶囊',
            'source_name'         => '招商银行',
            'merchant_order_no'   => 'TB20260623X00107',
            'occurred_at'         => Carbon::parse('2026-06-23 10:07:00', 'Asia/Shanghai'),
        ]);

        $matches = $this->match($user, $manual);

        self::assertCount(1, $matches);
        self::assertSame('high', $matches[0]['confidence']);
        self::assertContains('order_id', $matches[0]['matched_on']);
    }

    /**
     * @dataProvider noMatchProvider
     *
     * @param array<string, mixed> $manualOverrides
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('noMatchProvider')]
    public function testDoesNotMatchWhenKeyFieldsDiffer(array $manualOverrides): void
    {
        $user = $this->makeUser('cross-nomatch-' . md5(serialize($manualOverrides)) . '@test.com');
        $this->makeAssetAccount($user, '招商银行');
        $this->makeAssetAccount($user, '工商银行');
        $this->importExistingTransaction($user, [
            'firefly_amount'      => '21.00',
            'firefly_description' => '1点点',
            'source_name'         => '招商银行',
            'destination_name'    => '淘宝闪购',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
        ]);
        $manual = $this->makePendingRow($user, array_merge([
            'firefly_amount'      => '21.00',
            'firefly_description' => '1点点',
            'destination_name'    => '1点点',
            'source_name'         => '招商银行',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
        ], $manualOverrides));

        self::assertSame([], $this->match($user, $manual));
    }

    /**
     * @return array<string, array{array<string, mixed>}>
     */
    public static function noMatchProvider(): array
    {
        return [
            'different amount'       => [['firefly_amount' => '99.99']],
            'different asset account'=> [['source_name' => '工商银行']],
            'outside time window'    => [['occurred_at' => Carbon::parse('2026-06-25 13:35:00', 'Asia/Shanghai')]],
            'unrelated merchant'     => [['firefly_description' => '中石化加油', 'destination_name' => '中石化']],
        ];
    }

    public function testReviewPayloadSurfacesCrossSourceMatches(): void
    {
        $user = $this->makeUser('cross-review@test.com');
        $this->makeAssetAccount($user, '招商银行');
        $this->importExistingTransaction($user, [
            'firefly_amount'      => '21.00',
            'firefly_description' => '1点点',
            'source_name'         => '招商银行',
            'destination_name'    => '淘宝闪购',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
        ]);
        $task = $this->makeTask($user, 'manual');
        $row  = $this->makeRow($user, $task, [
            'status'              => 'pending',
            'firefly_amount'      => '21.00',
            'firefly_description' => '1点点',
            'destination_name'    => '1点点',
            'source_name'         => '招商银行',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
        ]);

        $review = app(BillStatementRowSummaryService::class)->reviewTaskRows($user, $task->id);

        self::assertArrayHasKey('cross_source_candidates', $review);
        self::assertCount(1, $review['cross_source_candidates']);
        $candidate = $review['cross_source_candidates'][0];
        self::assertSame((string) $row->id, $candidate['row_id']);
        self::assertNotEmpty($candidate['cross_source_matches']);
        self::assertSame('high', $candidate['cross_source_matches'][0]['confidence']);
    }

    /**
     * @return list<array<string,mixed>>
     */
    private function match(User $user, BillStatementRow $row): array
    {
        $matcher = app(CrossSourceDuplicateMatcher::class);

        return $matcher->matchRows($user, new Collection([$row]))[$row->id] ?? [];
    }

    /**
     * @param array<string, mixed> $overrides
     */
    private function importExistingTransaction(User $user, array $overrides): void
    {
        $task = $this->makeTask($user, 'alipay');
        $row  = $this->makeRow($user, $task, array_merge(['status' => 'pending'], $overrides));
        $service = app(BillStatementRowImportService::class);
        $result  = $service->importTaskRows($user, $task->id, [$row->id], true);
        self::assertSame(1, $result['summary']['imported'], 'existing transaction fixture failed to import');
    }

    /**
     * @param array<string, mixed> $overrides
     */
    private function makePendingRow(User $user, array $overrides): BillStatementRow
    {
        $task = $this->makeTask($user, 'manual');

        return $this->makeRow($user, $task, array_merge(['status' => 'pending'], $overrides));
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
        return Account::query()->create([
            'user_id'         => $user->id,
            'user_group_id'   => $user->user_group_id,
            'account_type_id' => AccountType::where('type', 'Asset account')->firstOrFail()->id,
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
            'summary'     => 'cross-source test',
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

        $occurred = $overrides['occurred_at'] ?? Carbon::now('Asia/Shanghai');

        return BillStatementRow::query()->create(array_merge([
            'user_id'                  => $user->id,
            'bill_task_id'             => $task->id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => 1,
            'status'                   => 'pending',
            'direction'                => '支出',
            'amount'                   => $overrides['firefly_amount'] ?? '0.00',
            'payment_method'           => '招商银行储蓄卡',
            'counterparty'             => $overrides['destination_name'] ?? '淘宝闪购',
            'firefly_type'             => 'withdrawal',
            'firefly_date'             => $occurred,
            'duplicate_state'          => 'unique',
            'raw_data'                 => [],
            'editable_data'            => [],
        ], $overrides));
    }
}
