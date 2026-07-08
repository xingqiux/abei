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
use FireflyIII\Services\BillIngestion\BalanceChainVerifier;
use FireflyIII\Services\BillIngestion\BillStatementRowImportService;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Collection;
use Tests\integration\TestCase;

/**
 * Balance-chain verification (issue #14, section 4): for bank-card asset
 * accounts whose statement rows carry a running balance (metadata.balance),
 * confirm-import must reconcile
 *   current Firefly balance + net effect of selected rows = statement balance
 * and warn (advisory) when it does not close.
 *
 * @internal
 */
final class BalanceChainVerifierTest extends TestCase
{
    use RefreshDatabase;

    public function testReportsClosingChainWhenStatementBalanceMatches(): void
    {
        $user = $this->makeUser('balance-ok@test.com');
        $this->makeAssetAccount($user, '招商银行');
        // Prior transaction gives the account a starting Firefly balance of 1000.
        $this->seedStartingBalance($user, '1000.00', Carbon::parse('2026-06-01 10:00:00', 'Asia/Shanghai'));

        // Pending CMB withdrawal of 21.00 whose statement balance is 979.00.
        $row = $this->makePendingBankRow($user, [
            'firefly_amount' => '21.00',
            'balance'        => '979.00',
        ]);

        $result = app(BalanceChainVerifier::class)->verifyBalance($user, new Collection([$row]));

        self::assertArrayHasKey('招商银行', $result);
        $chain = $result['招商银行'];
        self::assertTrue($chain['closes']);
        self::assertSame('-21.00', $chain['net_effect']);
        self::assertSame('979.00', $chain['expected_after']);
        self::assertSame('979.00', $chain['statement_balance']);
        self::assertNull($chain['difference']);
    }

    public function testReportsBrokenChainWithDifferenceWhenBalanceDoesNotClose(): void
    {
        $user = $this->makeUser('balance-bad@test.com');
        $this->makeAssetAccount($user, '招商银行');
        $this->seedStartingBalance($user, '1000.00', Carbon::parse('2026-06-01 10:00:00', 'Asia/Shanghai'));

        // Statement says 900.00 but current(1000) + net(-21) = 979.00 -> off by 79.
        $row = $this->makePendingBankRow($user, [
            'firefly_amount' => '21.00',
            'balance'        => '900.00',
        ]);

        $result = app(BalanceChainVerifier::class)->verifyBalance($user, new Collection([$row]));

        self::assertArrayHasKey('招商银行', $result);
        $chain = $result['招商银行'];
        self::assertFalse($chain['closes']);
        self::assertSame('979.00', $chain['expected_after']);
        self::assertSame('900.00', $chain['statement_balance']);
        self::assertSame('79.00', $chain['difference']);
    }

    public function testSkipsRowsWithoutStatementBalance(): void
    {
        $user = $this->makeUser('balance-skip@test.com');
        $this->makeAssetAccount($user, '招商银行');
        $this->seedStartingBalance($user, '1000.00', Carbon::parse('2026-06-01 10:00:00', 'Asia/Shanghai'));

        // Alipay-style row carries no running balance -> not part of any chain.
        $row = $this->makePendingBankRow($user, [
            'firefly_amount' => '21.00',
            'balance'        => null,
        ]);

        $result = app(BalanceChainVerifier::class)->verifyBalance($user, new Collection([$row]));

        self::assertSame([], $result);
    }

    public function testImportReportCarriesBalanceChain(): void
    {
        $user = $this->makeUser('balance-import@test.com');
        $this->makeAssetAccount($user, '招商银行');
        $this->seedStartingBalance($user, '1000.00', Carbon::parse('2026-06-01 10:00:00', 'Asia/Shanghai'));

        $task = $this->makeTask($user, 'cmb');
        $row  = $this->makeRow($user, $task, [
            'status'         => 'pending',
            'firefly_type'   => 'withdrawal',
            'firefly_amount' => '21.00',
            'amount'         => '21.00',
            'source_name'    => '招商银行',
            'destination_name' => '便利店',
            'firefly_description' => '便利店消费',
            'occurred_at'    => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
            'metadata'       => ['balance' => '979.00'],
        ]);

        $report = app(BillStatementRowImportService::class)->importTaskRows($user, $task->id, [$row->id], true);

        self::assertSame(1, $report['summary']['imported']);
        self::assertArrayHasKey('balance_chain', $report);
        self::assertArrayHasKey('招商银行', $report['balance_chain']);
        self::assertTrue($report['balance_chain']['招商银行']['closes']);
    }

    private function seedStartingBalance(User $user, string $amount, Carbon $date): void
    {
        $task = $this->makeTask($user, 'cmb');
        $row  = $this->makeRow($user, $task, [
            'status'              => 'pending',
            'firefly_type'        => 'deposit',
            'firefly_amount'      => $amount,
            'amount'              => $amount,
            'source_name'         => '工资',
            'destination_name'    => '招商银行',
            'firefly_description' => '初始入账',
            'occurred_at'         => $date,
            'metadata'            => [],
        ]);
        $result = app(BillStatementRowImportService::class)->importTaskRows($user, $task->id, [$row->id], true);
        self::assertSame(1, $result['summary']['imported'], 'starting-balance fixture failed to import');
    }

    /**
     * @param array{firefly_amount:string, balance:?string} $spec
     */
    private function makePendingBankRow(User $user, array $spec): BillStatementRow
    {
        $task = $this->makeTask($user, 'cmb');

        return $this->makeRow($user, $task, [
            'status'              => 'pending',
            'firefly_type'        => 'withdrawal',
            'firefly_amount'      => $spec['firefly_amount'],
            'amount'              => $spec['firefly_amount'],
            'source_name'         => '招商银行',
            'destination_name'    => '便利店',
            'firefly_description' => '便利店消费',
            'occurred_at'         => Carbon::parse('2026-06-23 13:35:00', 'Asia/Shanghai'),
            'metadata'            => null === $spec['balance'] ? [] : ['balance' => $spec['balance']],
        ]);
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
            'summary'     => 'balance-chain test',
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
            'counterparty'             => '便利店',
            'duplicate_state'          => 'unique',
            'raw_data'                 => [],
            'editable_data'            => [],
        ], $overrides));
    }
}
