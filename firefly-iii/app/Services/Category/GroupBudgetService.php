<?php

declare(strict_types=1);

namespace FireflyIII\Services\Category;

use Carbon\Carbon;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Models\AbeiGroupBudget;
use FireflyIII\Models\Category;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Support\Facades\Amount;
use FireflyIII\Support\Facades\Steam;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;

/**
 * 按支出组的预算。
 *
 * 「已花」不靠逐笔挂 budget_id，而是「这个组和它全部子分类在期内的支出合计」。
 * 分类是记账时本来就要选的，预算归属再选一次纯属重复劳动，也必然对不上。
 */
final class GroupBudgetService
{
    /**
     * 支出域的全部顶级组，含没设预算的（amount 为 null）。
     *
     * @return array<int, array<string, mixed>>
     */
    public function rows(User $user, Carbon $start, Carbon $end): array
    {
        $currency  = Amount::getPrimaryCurrency();
        $decimals  = (int) $currency->decimal_places;

        $groups    = $user->categories()
            ->where('domain', DefaultCategorySet::DOMAIN_EXPENSE)
            ->whereNull('parent_id')
            ->whereNull('disabled_at')
            ->orderBy('name', 'ASC')
            ->get()
        ;
        $groupIds  = $groups->pluck('id')->map(static fn ($id): int => (int) $id)->all();

        // 组自己也可能直接挂着账（无子级的组），所以 组 id 也要进汇总名单
        $childMap  = [];
        foreach ($groupIds as $groupId) {
            $childMap[$groupId] = $groupId;
        }
        $children  = Category::query()
            ->where('user_id', $user->id)
            ->whereIn('parent_id', $groupIds)
            ->get(['categories.id', 'categories.parent_id'])
        ;

        /** @var Category $child */
        foreach ($children as $child) {
            $childMap[(int) $child->id] = (int) $child->parent_id;
        }

        $perCategory = $this->spentPerCategory($user, $start, $end, $currency);
        $budgets     = AbeiGroupBudget::where('user_id', $user->id)
            ->whereIn('category_id', $groupIds)
            ->get()
            ->keyBy(static fn (AbeiGroupBudget $budget): int => (int) $budget->category_id)
        ;

        $spentByGroup = [];
        foreach ($groupIds as $groupId) {
            $spentByGroup[$groupId] = '0';
        }
        foreach ($perCategory as $categoryId => $sum) {
            $groupId = $childMap[$categoryId] ?? null;
            if (null === $groupId) {
                continue;
            }
            $spentByGroup[$groupId] = bcadd($spentByGroup[$groupId], $sum, 12);
        }

        $return = [];

        /** @var Category $group */
        foreach ($groups as $group) {
            $groupId  = (int) $group->id;
            $budget   = $budgets->get($groupId);
            $return[] = [
                'category_id'   => (string) $groupId,
                'name'          => $group->name,
                'icon'          => $group->icon,
                'color'         => $group->color,
                'amount'        => $budget instanceof AbeiGroupBudget ? $this->money((string) $budget->amount, $decimals) : null,
                'spent'         => $this->money($spentByGroup[$groupId], $decimals),
                'currency_code' => $budget instanceof AbeiGroupBudget ? (string) $budget->currency_code : $currency->code,
            ];
        }

        return $return;
    }

    /**
     * 一个组的行，PUT 之后原样回给前端。
     *
     * @return null|array<string, mixed>
     */
    public function row(User $user, Category $group, Carbon $start, Carbon $end): ?array
    {
        foreach ($this->rows($user, $start, $end) as $row) {
            if ($row['category_id'] === (string) $group->id) {
                return $row;
            }
        }

        return null;
    }

    /**
     * 期内每个分类的支出，正数。
     *
     * 分类可能挂在日记账上，也可能挂在拆分交易的单条 transaction 上；后者优先，
     * 跟 GroupCollector 的口径一致，用 COALESCE 一次算完，不会把同一笔算两遍。
     *
     * 外币按 native_amount（已折算成主货币的那一列）计入，缺这列才退回原币金额。
     *
     * @return array<int, string>
     */
    private function spentPerCategory(User $user, Carbon $start, Carbon $end, TransactionCurrency $currency): array
    {
        $rows   = DB::table('transactions as t')
            ->join('transaction_journals as tj', 'tj.id', '=', 't.transaction_journal_id')
            ->join('transaction_types as tt', 'tt.id', '=', 'tj.transaction_type_id')
            ->leftJoin('category_transaction as ct', 'ct.transaction_id', '=', 't.id')
            ->leftJoin('category_transaction_journal as ctj', 'ctj.transaction_journal_id', '=', 'tj.id')
            ->where('tj.user_id', $user->id)
            ->where('tt.type', TransactionTypeEnum::WITHDRAWAL->value)
            ->whereNull('t.deleted_at')
            ->whereNull('tj.deleted_at')
            // 支出的两条 transaction 里只取付款方那条（负数），不然一笔会被算成零
            ->where('t.amount', '<', 0)
            ->where('tj.date', '>=', $start->format('Y-m-d 00:00:00'))
            ->where('tj.date', '<=', $end->format('Y-m-d 23:59:59'))
            ->groupBy(DB::raw('COALESCE(ct.category_id, ctj.category_id)'), 't.transaction_currency_id')
            ->get([
                DB::raw('COALESCE(ct.category_id, ctj.category_id) as category_id'),
                't.transaction_currency_id as currency_id',
                DB::raw('SUM(t.amount) as sum_amount'),
                DB::raw('SUM(t.native_amount) as sum_native'),
            ])
        ;

        $return = [];
        foreach ($rows as $row) {
            if (null === $row->category_id) {
                continue;
            }
            $categoryId          = (int) $row->category_id;
            $sum                 = (int) $row->currency_id === (int) $currency->id
                ? (string) $row->sum_amount
                : (string) ($row->sum_native ?? $row->sum_amount);
            $return[$categoryId] = bcadd($return[$categoryId] ?? '0', $this->positive($sum), 12);
        }

        return $return;
    }

    /**
     * 四舍五入到货币精度，并且补齐小数位——前端拿到的永远是 "0.00" 而不是时而 "0" 时而 "0.00"。
     */
    private function money(string $amount, int $decimals): string
    {
        return bcadd(Steam::bcround($amount, $decimals), '0', $decimals);
    }

    private function positive(string $amount): string
    {
        return -1 === bccomp($amount, '0', 12) ? bcmul($amount, '-1', 12) : $amount;
    }
}
