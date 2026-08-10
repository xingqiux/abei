<?php

declare(strict_types=1);

namespace FireflyIII\Services\Category;

use Carbon\Carbon;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\User;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * 「这个分类用过几次、最后一次是什么时候」。
 *
 * 分类可以挂在日记账上（普通交易），也可以挂在单条 transaction 上（拆分交易），两边都要算，
 * 而且同一笔不能算两次——所以是一条 union all 子查询 + COUNT(DISTINCT journal)，
 * 不是每个分类查一遍。77 个分类的管理界面要一次列全，N+1 在这里是直接的卡顿。
 */
final class CategoryUsageService
{
    /**
     * @param array<int, int> $categoryIds
     * @param null|Carbon     $since       只数这个日期之后的交易，null 是全时段
     *
     * @return array<int, array{transactions_count: int, last_used: null|Carbon}>
     */
    public function usageFor(User $user, array $categoryIds, ?Carbon $since = null): array
    {
        $return         = [];
        $categoryIds    = array_values(array_unique(array_map('intval', $categoryIds)));
        foreach ($categoryIds as $categoryId) {
            $return[$categoryId] = ['transactions_count' => 0, 'last_used' => null];
        }
        if (0 === count($categoryIds)) {
            return $return;
        }

        $viaJournal     = DB::table('category_transaction_journal as ctj')
            ->join('transaction_journals as tj', 'tj.id', '=', 'ctj.transaction_journal_id')
            ->whereIn('ctj.category_id', $categoryIds)
            ->where('tj.user_id', $user->id)
            ->whereNull('tj.deleted_at')
            ->select(['ctj.category_id as category_id', 'tj.id as journal_id', 'tj.date as journal_date'])
        ;
        if ($since instanceof Carbon) {
            $viaJournal->where('tj.date', '>=', $since->format('Y-m-d 00:00:00'));
        }

        $viaTransaction = DB::table('category_transaction as ct')
            ->join('transactions as t', 't.id', '=', 'ct.transaction_id')
            ->join('transaction_journals as tj', 'tj.id', '=', 't.transaction_journal_id')
            ->whereIn('ct.category_id', $categoryIds)
            ->where('tj.user_id', $user->id)
            ->whereNull('t.deleted_at')
            ->whereNull('tj.deleted_at')
            ->select(['ct.category_id as category_id', 'tj.id as journal_id', 'tj.date as journal_date'])
        ;
        if ($since instanceof Carbon) {
            $viaTransaction->where('tj.date', '>=', $since->format('Y-m-d 00:00:00'));
        }

        $rows           = DB::query()
            ->fromSub($viaJournal->unionAll($viaTransaction), 'cat_usage')
            ->groupBy('cat_usage.category_id')
            ->get([
                'cat_usage.category_id',
                DB::raw('COUNT(DISTINCT cat_usage.journal_id) as journal_count'),
                DB::raw('MAX(cat_usage.journal_date) as last_used'),
            ])
        ;

        foreach ($rows as $row) {
            $categoryId          = (int) $row->category_id;
            $return[$categoryId] = [
                'transactions_count' => (int) $row->journal_count,
                'last_used'          => null === $row->last_used ? null : Carbon::parse((string) $row->last_used, config('app.timezone')),
            ];
        }

        return $return;
    }

    /**
     * 单个分类的笔数。合并前要告诉用户「N 笔交易将迁移」，用的是同一套口径。
     */
    public function transactionCount(User $user, int $categoryId): int
    {
        return $this->usageFor($user, [$categoryId])[$categoryId]['transactions_count'];
    }

    /**
     * 这批分类一共牵动多少笔交易。跟 usageFor() 逐个数完再相加不一样：
     * 一笔交易同时命中父子两个分类只算一次，重置命令要报的是「多少笔会失去分类」。
     *
     * @param array<int, int> $categoryIds
     */
    public function distinctJournalCount(User $user, array $categoryIds): int
    {
        $categoryIds    = array_values(array_unique(array_map('intval', $categoryIds)));
        if (0 === count($categoryIds)) {
            return 0;
        }

        $viaJournal     = DB::table('category_transaction_journal as ctj')
            ->join('transaction_journals as tj', 'tj.id', '=', 'ctj.transaction_journal_id')
            ->whereIn('ctj.category_id', $categoryIds)
            ->where('tj.user_id', $user->id)
            ->whereNull('tj.deleted_at')
            ->select(['tj.id as journal_id'])
        ;

        $viaTransaction = DB::table('category_transaction as ct')
            ->join('transactions as t', 't.id', '=', 'ct.transaction_id')
            ->join('transaction_journals as tj', 'tj.id', '=', 't.transaction_journal_id')
            ->whereIn('ct.category_id', $categoryIds)
            ->where('tj.user_id', $user->id)
            ->whereNull('t.deleted_at')
            ->whereNull('tj.deleted_at')
            ->select(['tj.id as journal_id'])
        ;

        return (int) DB::query()
            ->fromSub($viaJournal->unionAll($viaTransaction), 'cat_usage')
            ->distinct()
            ->count('cat_usage.journal_id')
        ;
    }

    /**
     * 没挂任何分类的收支笔数。
     *
     * 「未分类」没有实体分类，所以只能反着查：日记账上没有分类关系，名下的 transaction 上也没有。
     * 转账、余额校准这些不算——用户在分类页看到的「未分类 N 笔」是等着归类的收支。
     */
    public function uncategorizedCount(User $user): int
    {
        return DB::table('transaction_journals as tj')
            ->join('transaction_types as tt', 'tt.id', '=', 'tj.transaction_type_id')
            ->where('tj.user_id', $user->id)
            ->whereNull('tj.deleted_at')
            ->whereIn('tt.type', [TransactionTypeEnum::WITHDRAWAL->value, TransactionTypeEnum::DEPOSIT->value])
            ->whereNotExists(static function (Builder $query): void {
                $query->select(DB::raw('1'))
                    ->from('category_transaction_journal as ctj')
                    ->whereColumn('ctj.transaction_journal_id', 'tj.id')
                ;
            })
            ->whereNotExists(static function (Builder $query): void {
                $query->select(DB::raw('1'))
                    ->from('category_transaction as ct')
                    ->join('transactions as t', 't.id', '=', 'ct.transaction_id')
                    ->whereColumn('t.transaction_journal_id', 'tj.id')
                    ->whereNull('t.deleted_at')
                ;
            })
            ->count()
        ;
    }
}
