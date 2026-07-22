<?php

declare(strict_types=1);

namespace Tests\integration\Api\Models;

use FireflyIII\Models\Rule;
use FireflyIII\Models\RuleGroup;
use FireflyIII\TransactionRules\Engine\RuleEngineInterface;
use Illuminate\Support\Collection;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @coversNothing
 */
final class RuleTriggerControllerTest extends TestCase
{
    #[DataProvider('endpointProvider')]
    public function testRuleTestWithoutAccountsDoesNotApplyAnEmptyAccountFilter(string $routeName, bool $testGroup): void
    {
        $user  = $this->createAuthenticatedUser();
        $group = RuleGroup::create([
            'user_id'         => $user->id,
            'user_group_id'   => $user->user_group_id,
            'title'           => 'Test rule group',
            'description'     => '',
            'order'           => 1,
            'active'          => true,
            'stop_processing' => false,
        ]);
        $rule  = Rule::create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'rule_group_id' => $group->id,
            'title'         => 'Test rule',
            'description'   => '',
            'order'         => 1,
            'active'        => true,
            'strict'        => true,
        ]);

        $engine = Mockery::mock(RuleEngineInterface::class);
        $engine->shouldReceive('setRules')->once();
        $engine->shouldReceive('addOperator')->once()->with(['type' => 'date_after', 'value' => '2026-07-01']);
        $engine->shouldReceive('addOperator')->once()->with(['type' => 'date_before', 'value' => '2026-07-31']);
        $engine->shouldReceive('find')->once()->andReturn(new Collection());
        $this->app->instance(RuleEngineInterface::class, $engine);
        $this->actingAs($user, 'api');

        $model    = $testGroup ? $group : $rule;
        $response = $this->getJson(route($routeName, [$model->id]).'?start=2026-07-01&end=2026-07-31');

        $response->assertOk()->assertJsonPath('meta.pagination.total', 0);
    }

    public static function endpointProvider(): iterable
    {
        yield 'rule' => ['api.v1.rules.test', false];
        yield 'rule group' => ['api.v1.rule-groups.test', true];
    }
}
