<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

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

    /** 还没处置完的行的 status。分组判定只在这两种上跑。 */
    private const array OPEN_STATUSES = ['pending', 'needs_split'];

    public function __construct(
        private readonly BillStatementRowSummaryService $rowSummaryService,
        private readonly CrossSourceDuplicateMatcher $crossSourceMatcher = new CrossSourceDuplicateMatcher(),
    ) {}

    /**
     * 待办计数，供 GET /api/v1/bill-inbox/summary 的 todo 用。
     *
     * @return array{importable:int,attention:int}
     */
    public function todoCounts(User $user): array
    {
        $counts = ['importable' => 0, 'attention' => 0];
        foreach ($this->classifiedOpenRows($user, null) as $entry) {
            $group = $entry['group'];
            if (array_key_exists($group, $counts)) {
                ++$counts[$group];
            }
        }

        return $counts;
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

        if (in_array($group, ['dismissed', 'imported'], true)) {
            // 终态的行只看 status，条数可能上万，交给数据库分页；
            // 跨来源判重是给待办用的，这里跑它纯属白花时间。
            $query = $this->baseQuery($user, $source)
                ->where('status', $group)
                ->orderByDesc('occurred_at')
                ->orderByDesc('id')
            ;
            $total = (clone $query)->count();
            $rows  = $query->with('billTask')->forPage($page, $limit)->get();

            return [
                'data'  => $rows->map(static fn (BillStatementRow $row): array => [
                    'row'     => $row,
                    'group'   => $group,
                    'reasons' => [],
                ])->values()->all(),
                'total' => $total,
                'page'  => $page,
                'limit' => $limit,
            ];
        }

        $entries = array_values(array_filter(
            $this->classifiedOpenRows($user, $source),
            static fn (array $entry): bool => $group === $entry['group']
        ));

        return [
            'data'  => array_slice($entries, ($page - 1) * $limit, $limit),
            'total' => count($entries),
            'page'  => $page,
            'limit' => $limit,
        ];
    }

    /**
     * 没处置完的行，全部跑一遍分桶。
     *
     * 跨来源判重要一次拿到所有候选行才能只查一次 Firefly，所以这里不分页，
     * 整批算完再切页。待办的量级是「还没处理的」，不是历史总量，扛得住。
     *
     * @return array<int,array{row:BillStatementRow,group:string,reasons:array<int,string>}>
     */
    private function classifiedOpenRows(User $user, ?string $source): array
    {
        /** @var Collection<int, BillStatementRow> $rows */
        $rows = $this->baseQuery($user, $source)
            ->whereIn('status', self::OPEN_STATUSES)
            ->with('billTask')
            ->orderByDesc('occurred_at')
            ->orderByDesc('id')
            ->get()
        ;
        if ($rows->isEmpty()) {
            return [];
        }

        $pendingRows        = $rows->filter(static fn (BillStatementRow $row): bool => 'pending' === $row->status)->values();
        $crossSourceMatches = $this->crossSourceMatcher->matchRows($user, $pendingRows);

        $entries = [];
        foreach ($rows as $row) {
            $classified = $this->rowSummaryService->classifyRow($row, $crossSourceMatches[$row->id] ?? []);
            $entries[]  = [
                'row'     => $row,
                'group'   => $classified['group'],
                'reasons' => $classified['reasons'],
            ];
        }

        return $entries;
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
