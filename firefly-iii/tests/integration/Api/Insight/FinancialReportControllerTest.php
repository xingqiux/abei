<?php

declare(strict_types=1);

namespace Tests\integration\Api\Insight;

use Carbon\Carbon;
use FireflyIII\Enums\AccountTypeEnum;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Models\Account;
use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\Repositories\TransactionGroup\TransactionGroupRepositoryInterface;
use FireflyIII\User;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\Insight\ReportController
 * @covers \FireflyIII\Services\FinancialReportService
 */
final class FinancialReportControllerTest extends TestCase
{
    public function testAggregatesTopExpensesByFullGroupAndCurrency(): void
    {
        $user     = $this->createAuthenticatedUser();
        $cny      = TransactionCurrency::query()->where('code', 'CNY')->firstOrFail();
        $usd      = TransactionCurrency::query()->where('code', 'USD')->firstOrFail();
        $asset    = $this->createAccount($user, 'Checking', AccountTypeEnum::ASSET);
        $groceries = $this->createAccount($user, 'Groceries', AccountTypeEnum::EXPENSE);
        $utilities = $this->createAccount($user, 'Utilities', AccountTypeEnum::EXPENSE);

        $group = $this->storeGroup($user, 'Weekly shopping', [
            $this->transaction(TransactionTypeEnum::WITHDRAWAL, '2026-07-05 09:00:00', '10.00', $cny, $asset, $groceries),
            $this->transaction(TransactionTypeEnum::WITHDRAWAL, '2026-07-05 09:05:00', '20.00', $cny, $asset, $utilities),
        ]);
        $this->storeGroup($user, 'Single expense', [
            $this->transaction(TransactionTypeEnum::WITHDRAWAL, '2026-07-06 09:00:00', '25.00', $cny, $asset, $groceries),
        ]);
        $this->storeGroup($user, 'USD expense', [
            $this->transaction(TransactionTypeEnum::WITHDRAWAL, '2026-07-07 09:00:00', '40.00', $usd, $asset, $groceries),
        ]);

        $this->actingAs($user, 'api');
        $response = $this->getJson(route('api.v1.insight.report.overview', [
            'start' => '2026-07-01',
            'end'   => '2026-07-31',
        ]));

        $response->assertOk();
        $top = collect($response->json('data.top_expenses'))->groupBy('currency_code');
        $this->assertSame((string) $group->id, $top['CNY'][0]['group_id']);
        $this->assertSame('30.00', $top['CNY'][0]['amount']);
        $this->assertSame(2, $top['CNY'][0]['split_count']);
        $this->assertSame('25.00', $top['CNY'][1]['amount']);
        $this->assertSame('40.00', $top['USD'][0]['amount']);
    }

    public function testAggregatesTransferDirectionAndExcludesOtherUsers(): void
    {
        $user        = $this->createAuthenticatedUser();
        $otherUser   = $this->createUser('other-report@example.com');
        $currency    = TransactionCurrency::query()->where('code', 'CNY')->firstOrFail();
        $source      = $this->createAccount($user, 'Checking', AccountTypeEnum::ASSET, $currency);
        $destination = $this->createAccount($user, 'Savings', AccountTypeEnum::ASSET, $currency);
        $otherSource = $this->createAccount($otherUser, 'Other checking', AccountTypeEnum::ASSET, $currency);
        $otherDest   = $this->createAccount($otherUser, 'Other savings', AccountTypeEnum::ASSET, $currency);

        $this->storeGroup($user, null, [
            $this->transaction(TransactionTypeEnum::TRANSFER, '2026-07-08 09:00:00', '5.25', $currency, $source, $destination),
            $this->transaction(TransactionTypeEnum::TRANSFER, '2026-07-08 10:00:00', '6.75', $currency, $source, $destination),
        ]);
        $this->storeGroup($otherUser, null, [
            $this->transaction(TransactionTypeEnum::TRANSFER, '2026-07-08 11:00:00', '999.00', $currency, $otherSource, $otherDest),
        ]);

        $this->actingAs($user, 'api');
        $response = $this->getJson(route('api.v1.insight.report.overview', [
            'start' => '2026-07-01',
            'end'   => '2026-07-31',
        ]));

        $response->assertOk();
        $response->assertJsonCount(1, 'data.transfer_flows');
        $response->assertJsonPath('data.transfer_flows.0.source_account_name', 'Checking');
        $response->assertJsonPath('data.transfer_flows.0.destination_account_name', 'Savings');
        $response->assertJsonPath('data.transfer_flows.0.amount', '12.00');
        $response->assertJsonPath('data.transfer_flows.0.transaction_count', 2);
        $this->assertStringNotContainsString('Other checking', $response->getContent());
        $this->assertStringNotContainsString('999.00', $response->getContent());
    }

    public function testTopExpensesReadsMoreThan250GroupsAndExcludesDepositsAndTransfers(): void
    {
        $user        = $this->createAuthenticatedUser();
        $currency    = TransactionCurrency::query()->where('code', 'CNY')->firstOrFail();
        $asset       = $this->createAccount($user, 'Checking', AccountTypeEnum::ASSET, $currency);
        $expense     = $this->createAccount($user, 'General expense', AccountTypeEnum::EXPENSE, $currency);
        $revenue     = $this->createAccount($user, 'Refunds', AccountTypeEnum::REVENUE, $currency);
        $destination = $this->createAccount($user, 'Savings', AccountTypeEnum::ASSET, $currency);

        for ($index = 0; $index < 250; ++$index) {
            $this->storeGroup($user, sprintf('Small expense %d', $index), [
                $this->transaction(TransactionTypeEnum::WITHDRAWAL, '2026-07-10 09:00:00', '1.00', $currency, $asset, $expense),
            ]);
        }
        $largest = $this->storeGroup($user, 'Expense after page 250', [
            $this->transaction(TransactionTypeEnum::WITHDRAWAL, '2026-07-11 09:00:00', '999.00', $currency, $asset, $expense),
        ]);
        $this->storeGroup($user, 'Large refund', [
            $this->transaction(TransactionTypeEnum::DEPOSIT, '2026-07-12 09:00:00', '5000.00', $currency, $revenue, $asset),
        ]);
        $this->storeGroup($user, 'Large transfer', [
            $this->transaction(TransactionTypeEnum::TRANSFER, '2026-07-13 09:00:00', '6000.00', $currency, $asset, $destination),
        ]);

        $this->actingAs($user, 'api');
        $response = $this->getJson(route('api.v1.insight.report.overview', [
            'start' => '2026-07-01',
            'end'   => '2026-07-31',
        ]));

        $response->assertOk();
        $response->assertJsonCount(10, 'data.top_expenses');
        $response->assertJsonPath('data.top_expenses.0.group_id', (string) $largest->id);
        $response->assertJsonPath('data.top_expenses.0.amount', '999.00');
        $response->assertJsonCount(1, 'data.transfer_flows');
        $this->assertStringNotContainsString('Large refund', $response->getContent());
        $this->assertStringNotContainsString('5000.00', $response->getContent());
    }

    public function testRequiresAuthenticationAndValidDateRange(): void
    {
        $this->getJson('/api/v1/insight/report/overview?start=2026-07-01&end=2026-07-31')
            ->assertUnauthorized();

        $this->actingAs($this->createAuthenticatedUser(), 'api');
        $this->getJson('/api/v1/insight/report/overview?start=2026-07-31&end=2026-07-01')
            ->assertUnprocessable()
            ->assertJsonValidationErrors('end');
    }

    /**
     * @param array<int,array<string,mixed>> $transactions
     */
    private function storeGroup(User $user, ?string $title, array $transactions): object
    {
        /** @var TransactionGroupRepositoryInterface $repository */
        $repository = app(TransactionGroupRepositoryInterface::class);
        $repository->setUser($user);
        $repository->setUserGroup($user->userGroup);

        return $repository->store([
            'user'             => $user,
            'user_group'       => $user->userGroup,
            'group_title'      => $title,
            'apply_rules'      => false,
            'fire_webhooks'    => false,
            'batch_submission' => false,
            'transactions'     => $transactions,
        ]);
    }

    /**
     * @return array<string,mixed>
     */
    private function transaction(
        TransactionTypeEnum $type,
        string $date,
        string $amount,
        TransactionCurrency $currency,
        Account $source,
        Account $destination,
    ): array {
        return [
            'type'                     => $type->value,
            'date'                     => Carbon::parse($date, config('app.timezone')),
            'amount'                   => $amount,
            'description'              => $destination->name,
            'currency_id'              => $currency->id,
            'currency_code'            => $currency->code,
            'foreign_currency_id'      => null,
            'foreign_currency_code'    => null,
            'foreign_amount'           => null,
            'source_id'                => $source->id,
            'source_name'              => $source->name,
            'source_iban'              => null,
            'source_number'            => null,
            'source_bic'               => null,
            'destination_id'           => $destination->id,
            'destination_name'         => $destination->name,
            'destination_iban'         => null,
            'destination_number'       => null,
            'destination_bic'          => null,
            'budget_id'                => null,
            'budget_name'              => null,
            'category_id'              => null,
            'category_name'            => null,
            'bill_id'                  => null,
            'bill_name'                => null,
            'piggy_bank_id'            => null,
            'piggy_bank_name'          => null,
            'notes'                    => null,
            'tags'                     => [],
            'reconciled'               => false,
        ];
    }

    private function createAccount(User $user, string $name, AccountTypeEnum $type, ?TransactionCurrency $currency = null): Account
    {
        $account = Account::factory()->withType($type)->create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => $name,
            'active'        => true,
        ]);

        if (null !== $currency) {
            $account->accountMeta()->create(['name' => 'currency_id', 'data' => (string) $currency->id]);
        }

        return $account;
    }

    private function createUser(string $email): User
    {
        $group = UserGroup::create(['title' => $email]);
        $role  = UserRole::query()->where('title', 'owner')->firstOrFail();
        $user  = User::create(['email' => $email, 'password' => 'password', 'user_group_id' => $group->id]);

        GroupMembership::create([
            'user_id'       => $user->id,
            'user_group_id' => $group->id,
            'user_role_id'  => $role->id,
        ]);

        return $user;
    }
}
