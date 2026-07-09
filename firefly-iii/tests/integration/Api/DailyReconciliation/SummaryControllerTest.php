<?php

declare(strict_types=1);

namespace Tests\integration\Api\DailyReconciliation;

use Carbon\Carbon;
use FireflyIII\Enums\AccountTypeEnum;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Models\Account;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Repositories\Account\AccountRepositoryInterface;
use FireflyIII\Repositories\TransactionGroup\TransactionGroupRepositoryInterface;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Override;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\DailyReconciliation\SummaryController
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
