<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * 跨任务的流水队列。
 *
 * 收件箱要回答的是「还有多少笔要处理」，这个数跟邮件、跟任务都没关系，是把所有
 * 渠道所有任务名下的行拉平了一起看。原先的计数散在渠道卡片和任务列表里各算各的，
 * 侧栏一个数、页头另一个数，谁也说不清哪个对。这里是唯一口径。
 */
class BillStatementRowQueueService
{
    /** 队列能查的分组。importable / attention 是待办，dismissed / imported 是回看。 */
    public const array GROUPS = ['importable', 'attention', 'dismissed', 'imported'];

    /**
     * 待办计数，供 GET /api/v1/bill-inbox/summary 的 todo 用。
     *
     * @return array{importable:int,attention:int}
     */
    public function todoCounts(User $user): array
    {
        $counts = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->whereIn('review_state', ['pending_book', 'pending_confirm'])
            ->selectRaw('review_state, count(*) as total')
            ->groupBy('review_state')
            ->pluck('total', 'review_state');

        return [
            'importable' => (int) ($counts['pending_book'] ?? 0),
            'attention' => (int) ($counts['pending_confirm'] ?? 0),
        ];
    }

    /**
     * 分页取某一组的行。
     *
     * @return array{data:array<int,array{row:BillStatementRow,group:string,reasons:array<int,string>}>,total:int,page:int,limit:int}
     */
    public function paginate(User $user, string $group, ?string $source, int $page, int $limit): array
    {
        $page  = max(1, $page);
        $limit = max(1, min(200, $limit));

        $state = match ($group) {
            'importable' => 'pending_book',
            'attention' => 'pending_confirm',
            'dismissed' => 'excluded',
            'imported' => 'booked',
        };
        $query = $this->baseQuery($user, $source)
            ->where('review_state', $state)
            ->orderByDesc('occurred_at')
            ->orderByDesc('id');
        $total = (clone $query)->count();
        $rows = $query->with('billTask')->forPage($page, $limit)->get();

        return [
            'data'  => $rows->map(fn (BillStatementRow $row): array => [
                'row' => $row,
                'group' => $group,
                'reasons' => $this->reasons($row),
            ])->values()->all(),
            'total' => $total,
            'page'  => $page,
            'limit' => $limit,
        ];
    }

    /** @return list<string> */
    private function reasons(BillStatementRow $row): array
    {
        if ('pending_confirm' !== $row->review_state) {
            return [];
        }

        return [match ($row->confirm_reason) {
            'transfer' => BillStatementRowSummaryService::REASON_TRANSFER,
            'duplicate' => BillStatementRowSummaryService::REASON_DUPLICATE,
            'split' => BillStatementRowSummaryService::REASON_NEEDS_SPLIT,
            default => BillStatementRowSummaryService::REASON_NOT_IMPORTABLE,
        }];
    }

    /**
     * @return Builder<BillStatementRow>
     */
    private function baseQuery(User $user, ?string $source): Builder
    {
        $query = BillStatementRow::query()->where('user_id', $user->id);
        if (null !== $source && '' !== $source) {
            $query->whereHas('billTask', static fn (Builder $task): Builder => $task->where('source', $source));
        }

        return $query;
    }
}
