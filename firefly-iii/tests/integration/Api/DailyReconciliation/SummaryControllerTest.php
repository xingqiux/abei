<?php

declare(strict_types=1);

namespace Tests\integration\Api\DailyReconciliation;

use Carbon\Carbon;
use FireflyIII\Enums\AccountTypeEnum;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Models\Account;
use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\TransactionJournal;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\Repositories\Account\AccountRepositoryInterface;
use FireflyIII\Repositories\TransactionGroup\TransactionGroupRepositoryInterface;
use FireflyIII\Support\Facades\FireflyConfig;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Override;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\DailyReconciliation\SummaryController
 * @covers \FireflyIII\Api\V1\Controllers\DailyReconciliation\ActionController
 * @covers \FireflyIII\Services\DailyReconciliation\DailyReconciliationService
 * @covers \FireflyIII\Services\DailyReconciliation\DailyReconciliationSummaryService
 */
final class SummaryControllerTest extends TestCase
{
    use RefreshDatabase;

    public function testSummaryReturnsPerDayStatusAndAggregatesForCurrentUser(): void
    {
        $user     = $this->createAuthenticatedUser();
        $currency = TransactionCurrency::where('code', 'CNY')->first() ?? TransactionCurrency::factory()->create([
            'code'           => 'CNY',
            'name'           => 'Chinese Yuan',
            'symbol'         => '¥',
            'decimal_places' => 2,
        ]);
        $account  = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => '招商银行',
            'active'        => true,
        ]);

        // 06-18：有差额调整交易的一天（调整发生的当天算作 diff）。
        $this->createWithdrawal($user, $account, $currency, '2026-06-18 09:00:00', '30.00', reconciled: true);
        $this->createReconciliationAdjustment($user, $account, $currency, '2026-06-18 23:59:00', '3.00');
        // 06-19：有交易但未勾选 reconciled，算 pending。
        $this->createWithdrawal($user, $account, $currency, '2026-06-19 10:30:00', '20.00', reconciled: false);
        $this->createDeposit($user, $account, $currency, '2026-06-19 12:00:00', '5.00', reconciled: false);
        // 06-20：全部交易都已勾选 reconciled，且没有差额调整交易。
        $this->createWithdrawal($user, $account, $currency, '2026-06-20 10:30:00', '12.34', reconciled: true);
        // 06-21：当天没有任何交易。

        $this->actingAs($user, 'api');
        $response = $this->getJson(route('api.v1.daily-reconciliation.summary', ['days' => 30]));

        $response->assertStatus(200);
        $response->assertJsonPath('last_reconciled_date', '2026-06-20');
        $response->assertJsonPath('days_unreconciled', 5);

        $days = collect($response->json('days'))->keyBy('date');

        $this->assertSame('diff', $days['2026-06-18']['status']);
        $this->assertSame('3.00', $days['2026-06-18']['diff_amount']);
        $this->assertSame('30.00', $days['2026-06-18']['expense']);
        $this->assertSame(1, $days['2026-06-18']['tx_count']);

        $this->assertSame('pending', $days['2026-06-19']['status']);
        $this->assertSame('20.00', $days['2026-06-19']['expense']);
        $this->assertSame('5.00', $days['2026-06-19']['income']);
        $this->assertSame(2, $days['2026-06-19']['tx_count']);
        $this->assertNull($days['2026-06-19']['diff_amount']);

        $this->assertSame('reconciled', $days['2026-06-20']['status']);
        $this->assertSame('12.34', $days['2026-06-20']['expense']);
        $this->assertSame(1, $days['2026-06-20']['tx_count']);
        $this->assertNull($days['2026-06-20']['diff_amount']);

        $this->assertSame('none', $days['2026-06-21']['status']);
        $this->assertSame(0, $days['2026-06-21']['tx_count']);
    }

    public function testSummaryDefaultsToThirtyDaysAndRequiresAuthentication(): void
    {
        $unauthenticated = $this->get(route('api.v1.daily-reconciliation.summary'), ['Accept' => 'application/json']);
        $unauthenticated->assertStatus(401);
        $unauthenticated->assertHeader('Content-Type', 'application/json');
        $unauthenticated->assertContent('{"message":"Unauthenticated.","exception":"AuthenticationException"}');

        $user = $this->createAuthenticatedUser();
        $this->actingAs($user, 'api');

        $response = $this->getJson(route('api.v1.daily-reconciliation.summary'));
        $response->assertStatus(200);
        $response->assertJsonCount(30, 'days');
        $response->assertJsonPath('last_reconciled_date', null);
        $response->assertJsonPath('days_unreconciled', 0);
    }

    public function testSummaryKeepsDifferentCurrenciesSeparate(): void
    {
        $user = $this->createAuthenticatedUser();
        $cny  = TransactionCurrency::where('code', 'CNY')->firstOrFail();
        $usd  = TransactionCurrency::where('code', 'USD')->first() ?? TransactionCurrency::factory()->create([
            'code'           => 'USD',
            'name'           => 'US Dollar',
            'symbol'         => '$',
            'decimal_places' => 2,
        ]);
        $account = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => '多币种测试账户',
            'active'        => true,
        ]);

        $this->createWithdrawal($user, $account, $cny, '2026-06-22 09:00:00', '9007199254740993.01', reconciled: false);
        $this->createDeposit($user, $account, $usd, '2026-06-22 10:00:00', '12.34', reconciled: false);

        $this->actingAs($user, 'api');
        $response = $this->getJson(route('api.v1.daily-reconciliation.summary', ['days' => 30]));
        $response->assertOk();

        $day = collect($response->json('days'))->firstWhere('date', '2026-06-22');
        $this->assertNull($day['income']);
        $this->assertNull($day['expense']);
        $this->assertNull($day['net']);
        $this->assertSame(2, $day['tx_count']);

        $totals = collect($day['currency_totals'])->keyBy('currency_code');
        $this->assertSame('9007199254740993.01', $totals['CNY']['expense']);
        $this->assertSame('-9007199254740993.01', $totals['CNY']['net']);
        $this->assertSame('12.34', $totals['USD']['income']);
        $this->assertSame('12.34', $totals['USD']['net']);
    }

    public function testReconcileMarksEveryTransactionAndIsIdempotentBeyondOneApiPage(): void
    {
        $user     = $this->createAuthenticatedUser();
        $currency = TransactionCurrency::where('code', 'CNY')->first() ?? TransactionCurrency::factory()->create([
            'code'           => 'CNY',
            'name'           => 'Chinese Yuan',
            'symbol'         => '¥',
            'decimal_places' => 2,
        ]);
        $account  = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => '测试账户',
            'active'        => true,
        ]);

        for ($index = 0; $index < 201; ++$index) {
            $this->createWithdrawal(
                $user,
                $account,
                $currency,
                sprintf('2026-06-19 10:%02d:%02d', $index % 60, $index % 60),
                '1.00',
                reconciled: false,
            );
        }

        $this->actingAs($user, 'api');
        $first = $this->postJson(route('api.v1.daily-reconciliation.reconcile', ['reconciliationDate' => '2026-06-19']));
        $first->assertOk();
        $first->assertJsonPath('date', '2026-06-19');
        $first->assertJsonPath('total', 201);
        $first->assertJsonPath('updated', 201);
        $first->assertJsonPath('already_reconciled', 0);

        $second = $this->postJson(route('api.v1.daily-reconciliation.reconcile', ['reconciliationDate' => '2026-06-19']));
        $second->assertOk();
        $second->assertJsonPath('total', 201);
        $second->assertJsonPath('updated', 0);
        $second->assertJsonPath('already_reconciled', 201);
    }

    public function testReconcileValidatesDateAndRequiresAuthentication(): void
    {
        $this->postJson(route('api.v1.daily-reconciliation.reconcile', ['reconciliationDate' => '2026-06-19']))
            ->assertUnauthorized();

        $user = $this->createAuthenticatedUser();
        $this->actingAs($user, 'api');
        $this->postJson('/api/v1/daily-reconciliation/2026-99-99/reconcile')
            ->assertUnprocessable()
            ->assertJsonValidationErrors('date');
    }

    public function testReconcileRollsBackEveryTransactionWhenBulkUpdateFails(): void
    {
        $user     = $this->createAuthenticatedUser();
        $currency = TransactionCurrency::where('code', 'CNY')->firstOrFail();
        $account  = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => '回滚测试账户',
            'active'        => true,
        ]);

        $this->createWithdrawal($user, $account, $currency, '2026-06-19 09:00:00', '10.00', reconciled: false);
        $this->createWithdrawal($user, $account, $currency, '2026-06-19 10:00:00', '20.00', reconciled: false);

        $transactionId = TransactionJournal::query()
            ->where('user_id', $user->id)
            ->orderByDesc('id')
            ->firstOrFail()
            ->transactions()
            ->orderBy('id')
            ->value('id');

        DB::unprepared(sprintf(<<<'SQL'
CREATE FUNCTION fail_daily_reconciliation_update() RETURNS trigger AS $$
BEGIN
    IF NEW.id = %d AND NEW.reconciled = TRUE THEN
        RAISE EXCEPTION 'injected daily reconciliation failure';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SQL, $transactionId));
        DB::unprepared(<<<'SQL'
CREATE TRIGGER fail_daily_reconciliation_update
BEFORE UPDATE OF reconciled ON transactions
FOR EACH ROW EXECUTE FUNCTION fail_daily_reconciliation_update()
SQL);

        $this->actingAs($user, 'api');
        $this->withoutExceptionHandling();
        try {
            $this->postJson(route('api.v1.daily-reconciliation.reconcile', ['reconciliationDate' => '2026-06-19']));
            $this->fail('The injected reconciliation failure was not raised.');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('injected daily reconciliation failure', $exception->getMessage());
        } finally {
            $this->withExceptionHandling();
            DB::unprepared('DROP TRIGGER IF EXISTS fail_daily_reconciliation_update ON transactions');
            DB::unprepared('DROP FUNCTION IF EXISTS fail_daily_reconciliation_update()');
        }

        $this->assertSame(
            0,
            TransactionJournal::query()
                ->where('user_id', $user->id)
                ->whereHas('transactions', static fn ($query) => $query->where('reconciled', true))
                ->count()
        );
    }

    public function testReconcileOnlyUpdatesAuthenticatedUsersTransactions(): void
    {
        $user      = $this->createAuthenticatedUser();
        $otherUser = $this->createUser('other-reconciliation@example.com');
        $currency  = TransactionCurrency::where('code', 'CNY')->firstOrFail();
        $account   = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => '当前用户账户',
            'active'        => true,
        ]);
        $otherAccount = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $otherUser->id,
            'user_group_id' => $otherUser->user_group_id,
            'name'          => '其他用户账户',
            'active'        => true,
        ]);

        $this->createWithdrawal($user, $account, $currency, '2026-06-19 09:00:00', '10.00', reconciled: false);
        $this->createWithdrawal($otherUser, $otherAccount, $currency, '2026-06-19 10:00:00', '20.00', reconciled: false);

        $this->actingAs($user, 'api');
        $response = $this->postJson(route('api.v1.daily-reconciliation.reconcile', ['reconciliationDate' => '2026-06-19']));

        $response->assertOk();
        $response->assertJsonPath('total', 1);
        $response->assertJsonPath('updated', 1);
        $this->assertTrue($this->allTransactionsReconciledFor($user));
        $this->assertFalse($this->allTransactionsReconciledFor($otherUser));
    }

    #[DataProvider('utcStorageProvider')]
    public function testReconcileUsesConfiguredTimezoneAtDayBoundaries(bool $storeDatesAsUtc): void
    {
        config(['app.timezone' => 'America/Los_Angeles']);
        FireflyConfig::set('utc', $storeDatesAsUtc);

        $user     = $this->createAuthenticatedUser();
        $currency = TransactionCurrency::where('code', 'CNY')->firstOrFail();
        $account  = Account::factory()->withType(AccountTypeEnum::ASSET)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => '时区边界账户',
            'active'        => true,
        ]);

        $this->createWithdrawal($user, $account, $currency, '2026-06-18 23:59:59', '1.00', reconciled: false);
        $this->createWithdrawal($user, $account, $currency, '2026-06-19 00:00:00', '2.00', reconciled: false);
        $this->createWithdrawal($user, $account, $currency, '2026-06-19 23:59:59', '3.00', reconciled: false);
        $this->createWithdrawal($user, $account, $currency, '2026-06-20 00:00:00', '4.00', reconciled: false);

        $this->actingAs($user, 'api');
        $response = $this->postJson(route('api.v1.daily-reconciliation.reconcile', ['reconciliationDate' => '2026-06-19']));

        $response->assertOk();
        $response->assertJsonPath('total', 2);
        $response->assertJsonPath('updated', 2);

        $journals = TransactionJournal::query()->where('user_id', $user->id)->orderBy('date')->get();
        $this->assertFalse($journals[0]->transactions->every(static fn ($transaction) => $transaction->reconciled));
        $this->assertTrue($journals[1]->transactions->every(static fn ($transaction) => $transaction->reconciled));
        $this->assertTrue($journals[2]->transactions->every(static fn ($transaction) => $transaction->reconciled));
        $this->assertFalse($journals[3]->transactions->every(static fn ($transaction) => $transaction->reconciled));
    }

    /**
     * @return array<string, array{bool}>
     */
    public static function utcStorageProvider(): array
    {
        return [
            'local wall time storage' => [false],
            'UTC storage'             => [true],
        ];
    }

    private function createWithdrawal(User $user, Account $source, TransactionCurrency $currency, string $date, string $amount, bool $reconciled): void
    {
        $this->storeSingleTransaction($user, [
            'type'             => TransactionTypeEnum::WITHDRAWAL->value,
            'date'             => Carbon::parse($date, config('app.timezone')),
            'amount'           => $amount,
            'description'      => '测试支出',
            'currency_id'      => $currency->id,
            'currency_code'    => $currency->code,
            'source_id'        => $source->id,
            'source_name'      => $source->name,
            'destination_id'   => null,
            'destination_name' => '便利店',
            'category_name'    => '餐饮',
            'reconciled'       => $reconciled,
        ]);
    }

    private function createDeposit(User $user, Account $destination, TransactionCurrency $currency, string $date, string $amount, bool $reconciled): void
    {
        $this->storeSingleTransaction($user, [
            'type'             => TransactionTypeEnum::DEPOSIT->value,
            'date'             => Carbon::parse($date, config('app.timezone')),
            'amount'           => $amount,
            'description'      => '测试收入',
            'currency_id'      => $currency->id,
            'currency_code'    => $currency->code,
            'source_id'        => null,
            'source_name'      => '朋友转账',
            'destination_id'   => $destination->id,
            'destination_name' => $destination->name,
            'category_name'    => null,
            'reconciled'       => $reconciled,
        ]);
    }

    private function createReconciliationAdjustment(User $user, Account $account, TransactionCurrency $currency, string $date, string $amount): void
    {
        /** @var AccountRepositoryInterface $accountRepository */
        $accountRepository = app(AccountRepositoryInterface::class);
        $accountRepository->setUser($user);
        $reconciliationAccount = $accountRepository->getReconciliation($account);

        $this->storeSingleTransaction($user, [
            'type'             => strtolower(TransactionTypeEnum::RECONCILIATION->value),
            'date'             => Carbon::parse($date, config('app.timezone')),
            'amount'           => $amount,
            'description'      => '对账调整',
            'currency_id'      => $currency->id,
            'currency_code'    => $currency->code,
            'source_id'        => $account->id,
            'source_name'      => $account->name,
            'destination_id'   => $reconciliationAccount?->id,
            'destination_name' => $reconciliationAccount?->name,
            'category_name'    => null,
            'reconciled'       => true,
        ]);
    }

    /**
     * @param array<string,mixed> $transaction
     */
    private function storeSingleTransaction(User $user, array $transaction): void
    {
        /** @var TransactionGroupRepositoryInterface $repository */
        $repository = app(TransactionGroupRepositoryInterface::class);
        $repository->setUser($user);
        $repository->setUserGroup($user->userGroup);
        $repository->store([
            'user'          => $user,
            'user_group'    => $user->userGroup,
            'apply_rules'   => false,
            'fire_webhooks' => false,
            'transactions'  => [$transaction + [
                'foreign_currency_id'   => null,
                'foreign_currency_code' => null,
                'foreign_amount'        => null,
                'source_iban'           => null,
                'source_number'         => null,
                'source_bic'            => null,
                'destination_iban'      => null,
                'destination_number'    => null,
                'destination_bic'       => null,
                'budget_id'             => null,
                'budget_name'           => null,
                'category_id'           => null,
                'bill_id'               => null,
                'bill_name'             => null,
                'piggy_bank_id'         => null,
                'piggy_bank_name'       => null,
                'notes'                 => null,
                'tags'                  => [],
            ]],
        ]);
    }

    private function allTransactionsReconciledFor(User $user): bool
    {
        return TransactionJournal::query()
            ->where('user_id', $user->id)
            ->get()
            ->every(static fn (TransactionJournal $journal) => $journal->transactions->every(
                static fn ($transaction) => $transaction->reconciled
            ));
    }

    private function createUser(string $email): User
    {
        $group = UserGroup::create(['title' => $email]);
        $role  = UserRole::where('title', 'owner')->firstOrFail();
        $user  = User::create(['email' => $email, 'password' => 'password', 'user_group_id' => $group->id]);

        GroupMembership::create([
            'user_id'       => $user->id,
            'user_group_id' => $group->id,
            'user_role_id'  => $role->id,
        ]);

        return $user;
    }

    #[Override]
    protected function setUp(): void
    {
        parent::setUp();

        Carbon::setTestNow(Carbon::parse('2026-06-25 12:00:00', config('app.timezone')));
    }

    #[Override]
    protected function tearDown(): void
    {
        Carbon::setTestNow();

        parent::tearDown();
    }
}
