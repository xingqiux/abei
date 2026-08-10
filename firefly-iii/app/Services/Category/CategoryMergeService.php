<?php

declare(strict_types=1);

namespace FireflyIII\Services\Category;

use FireflyIII\Models\Category;
use FireflyIII\Models\RecurrenceTransactionMeta;
use FireflyIII\Models\RuleAction;
use FireflyIII\Models\RuleTrigger;
use FireflyIII\Services\Internal\Destroy\CategoryDestroyService;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

/**
 * 把一个分类整个并进另一个：名下交易全迁走，源分类删掉。
 *
 * 77 个分类要收敛成几十个，靠的就是这个动作。它是破坏性的且不可撤销，所以：
 * 先把不该合的情况全挡在事务外，进了事务就一次做完（交易、规则、定期交易、缓存统计）。
 * 只迁交易不迁规则的话，用户下次记账规则又会把老分类名写回来，等于白合。
 */
final class CategoryMergeService
{
    public function __construct(private readonly CategoryUsageService $usageService) {}

    /**
     * @return int 迁走的交易笔数
     *
     * @throws ValidationException
     */
    public function merge(User $user, Category $source, Category $target): int
    {
        // 动作是删数据，别指望调用方一定做过归属检查
        if ((int) $source->user_id !== (int) $user->id || (int) $target->user_id !== (int) $user->id) {
            throw ValidationException::withMessages([
                'into_id' => ['分类不属于当前用户。'],
            ]);
        }
        $this->assertMergeable($source, $target);

        $moved = $this->usageService->transactionCount($user, (int) $source->id);

        DB::transaction(function () use ($user, $source, $target): void {
            $this->moveJournals($source, $target);
            $this->moveTransactions($source, $target);
            $this->moveRecurrences($user, $source, $target);
            $this->moveRules($user, $source, $target);

            // 两边的周期缓存都脏了：源没了，目标多了一批交易
            $source->primaryPeriodStatistics()->delete();
            $target->primaryPeriodStatistics()->delete();

            app(CategoryDestroyService::class)->destroy($source);
        });

        Log::info(sprintf('Merged category #%d ("%s") into #%d ("%s"), %d transaction(s) moved.', $source->id, $source->name, $target->id, $target->name, $moved));

        return $moved;
    }

    /**
     * @throws ValidationException
     */
    private function assertMergeable(Category $source, Category $target): void
    {
        if ((int) $source->id === (int) $target->id) {
            throw ValidationException::withMessages([
                'into_id' => ['不能把分类合并进它自己。'],
            ]);
        }
        // 只挡源头。v0.2 起默认词表本身就是 system=true，「把自建分类并进餐饮」是最常见的用法，
        // 挡住目标等于把迁移功能废掉；挡住源头是因为合并会删掉源分类，而默认分类不许删。
        if ($source->system) {
            throw ValidationException::withMessages([
                'into_id' => ['系统分类不能作为合并来源，它不允许被删除。'],
            ]);
        }
        if ((int) $target->parent_id === (int) $source->id) {
            throw ValidationException::withMessages([
                'into_id' => ['不能把分类合并进自己的子分类。'],
            ]);
        }
        if ($source->children()->count() > 0) {
            throw ValidationException::withMessages([
                'into_id' => ['这个分类下面还有子分类，先把子分类移走或合并掉。'],
            ]);
        }
    }

    /**
     * 分类挂在日记账上的那一半。已经同时挂着目标分类的日记账，直接把源那条关系删掉，
     * 不然改成目标 id 就成了同一笔挂两次。
     */
    private function moveJournals(Category $source, Category $target): void
    {
        // 子查询里读同一张表 MySQL 不许，所以先把目标已有的日记账捞成数组
        $existing = DB::table('category_transaction_journal')
            ->where('category_id', $target->id)
            ->pluck('transaction_journal_id')
            ->toArray()
        ;
        if (count($existing) > 0) {
            DB::table('category_transaction_journal')
                ->where('category_id', $source->id)
                ->whereIn('transaction_journal_id', $existing)
                ->delete()
            ;
        }

        DB::table('category_transaction_journal')
            ->where('category_id', $source->id)
            ->update(['category_id' => $target->id])
        ;
    }

    /**
     * 定期交易里按 id 和按名字两种写法都要跟着改，否则下次自动记账又冒出老分类。
     */
    private function moveRecurrences(User $user, Category $source, Category $target): void
    {
        foreach (['category_id' => [(string) $source->id, (string) $target->id], 'category_name' => [$source->name, $target->name]] as $field => $values) {
            RecurrenceTransactionMeta::leftJoin('recurrences_transactions', 'rt_meta.rt_id', '=', 'recurrences_transactions.id')
                ->leftJoin('recurrences', 'recurrences.id', '=', 'recurrences_transactions.recurrence_id')
                ->where('recurrences.user_id', $user->id)
                ->where('rt_meta.name', $field)
                ->where('rt_meta.value', $values[0])
                ->update(['rt_meta.value' => $values[1]])
            ;
        }
    }

    private function moveRules(User $user, Category $source, Category $target): void
    {
        $actions  = RuleAction::leftJoin('rules', 'rules.id', '=', 'rule_actions.rule_id')
            ->where('rules.user_id', $user->id)
            ->where('rule_actions.action_type', 'set_category')
            ->where('rule_actions.action_value', $source->name)
            ->get(['rule_actions.*'])
        ;

        /** @var RuleAction $action */
        foreach ($actions as $action) {
            $action->action_value = $target->name;
            $action->save();
        }

        $triggers = RuleTrigger::leftJoin('rules', 'rules.id', '=', 'rule_triggers.rule_id')
            ->where('rules.user_id', $user->id)
            ->where('rule_triggers.trigger_type', 'category_is')
            ->where('rule_triggers.trigger_value', $source->name)
            ->get(['rule_triggers.*'])
        ;

        /** @var RuleTrigger $trigger */
        foreach ($triggers as $trigger) {
            $trigger->trigger_value = $target->name;
            $trigger->save();
        }
    }

    /**
     * 拆分交易那一半：分类挂在单条 transaction 上。
     */
    private function moveTransactions(Category $source, Category $target): void
    {
        $existing = DB::table('category_transaction')
            ->where('category_id', $target->id)
            ->pluck('transaction_id')
            ->toArray()
        ;
        if (count($existing) > 0) {
            DB::table('category_transaction')
                ->where('category_id', $source->id)
                ->whereIn('transaction_id', $existing)
                ->delete()
            ;
        }

        DB::table('category_transaction')
            ->where('category_id', $source->id)
            ->update(['category_id' => $target->id])
        ;
    }
}
