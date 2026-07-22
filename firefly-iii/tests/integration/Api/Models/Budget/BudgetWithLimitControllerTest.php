<?php

declare(strict_types=1);

namespace Tests\integration\Api\Models\Budget;

use FireflyIII\Models\Budget;
use FireflyIII\Models\BudgetLimit;
use FireflyIII\Repositories\Budget\BudgetLimitRepository;
use FireflyIII\Repositories\Budget\BudgetLimitRepositoryInterface;
use FireflyIII\User;
use RuntimeException;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\Models\Budget\StoreController
 */
final class BudgetWithLimitControllerTest extends TestCase
{
    private User $user;

    public function testLimitFailureRollsBackBudgetAndAllowsSameNameRetry(): void
    {
        $realRepository = app(BudgetLimitRepositoryInterface::class);
        $failingRepository = new class extends BudgetLimitRepository {
            public function store(array $data): BudgetLimit
            {
                throw new RuntimeException('Injected budget limit failure.');
            }
        };

        $this->app->instance(BudgetLimitRepositoryInterface::class, $failingRepository);

        $payload = $this->payload('Groceries', 'CNY');
        $this->withoutExceptionHandling();
        try {
            $this->postJson(route('api.v1.budgets.store-with-limit'), $payload);
            $this->fail('The injected budget limit failure was not raised.');
        } catch (RuntimeException $exception) {
            $this->assertSame('Injected budget limit failure.', $exception->getMessage());
        } finally {
            $this->withExceptionHandling();
        }

        $this->assertSame(0, Budget::withTrashed()->where('name', 'Groceries')->count());
        $this->assertSame(0, BudgetLimit::query()->count());

        $this->app->instance(BudgetLimitRepositoryInterface::class, $realRepository);
        $response = $this->postJson(route('api.v1.budgets.store-with-limit'), $payload);

        $response->assertCreated();
        $this->assertSame(1, Budget::withTrashed()->where('name', 'Groceries')->count());
        $this->assertSame(1, BudgetLimit::query()->count());
    }

    public function testStoresRequestedLimitCurrencyAndExactAmount(): void
    {
        $response = $this->postJson(
            route('api.v1.budgets.store-with-limit'),
            $this->payload('Travel', 'USD', '10019092019.01')
        );

        $response->assertCreated();

        $budget = Budget::query()->where('name', 'Travel')->firstOrFail();
        $limit  = $budget->budgetlimits()->with('transactionCurrency')->sole();

        $this->assertSame('USD', $limit->transactionCurrency->code);
        $this->assertSame(0, bccomp('10019092019.01', $limit->amount, 2));
    }

    public function testAllowsSingleDayLimit(): void
    {
        $payload = $this->payload('One day', 'CNY', '25.50');
        $payload['limit']['end'] = $payload['limit']['start'];

        $response = $this->postJson(route('api.v1.budgets.store-with-limit'), $payload);

        $response->assertCreated();
        $limit = Budget::query()->where('name', 'One day')->firstOrFail()->budgetlimits()->sole();
        $this->assertSame($limit->start_date->toDateString(), $limit->end_date->toDateString());
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = $this->createAuthenticatedUser();
        $this->actingAs($this->user, 'api');
    }

    /**
     * @return array<string, mixed>
     */
    private function payload(string $name, string $currencyCode, string $amount = '1200.50'): array
    {
        return [
            'name'   => $name,
            'active' => true,
            'limit'  => [
                'start'         => '2026-07-01',
                'end'           => '2026-07-31',
                'amount'        => $amount,
                'currency_code' => $currencyCode,
            ],
        ];
    }
}
