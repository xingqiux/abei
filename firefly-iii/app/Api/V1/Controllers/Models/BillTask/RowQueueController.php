<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Services\BillIngestion\BillStatementCurrencyResolver;
use FireflyIII\Services\BillIngestion\BillStatementRowDismissalService;
use FireflyIII\Services\BillIngestion\BillStatementRowImportService;
use FireflyIII\Services\BillIngestion\BillStatementRowQueueService;
use FireflyIII\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * 跨任务的流水队列。
 *
 * 现有的 BillTask\ListController 是「按邮件看」：先选一个任务，再看它名下的行。
 * 收件箱要的是反过来的视角——把所有渠道所有任务的行摊平，按「能不能直接入账」排队，
 * 任务退回去当每一行的来源凭证。所以另起一个控制器，不往任务那套路由里塞。
 */
final class RowQueueController extends Controller
{
    use BillTaskResponse;

    public function __construct(
        private readonly BillStatementRowQueueService $queueService,
        private readonly BillStatementRowDismissalService $dismissalService,
        private readonly BillStatementRowImportService $rowImportService,
        private readonly BillStatementCurrencyResolver $currencyResolver,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'group'  => ['nullable', 'string', 'in:'.implode(',', BillStatementRowQueueService::GROUPS)],
            'source' => ['nullable', 'string', 'max:64'],
            'page'   => ['nullable', 'integer', 'min:1'],
            'limit'  => ['nullable', 'integer', 'min:1', 'max:200'],
        ]);

        $group  = (string) ($validated['group'] ?? 'importable');
        $source = trim((string) ($validated['source'] ?? ''));
        $result = $this->queueService->paginate(
            auth()->user(),
            $group,
            '' === $source ? null : $source,
            (int) ($validated['page'] ?? 1),
            (int) ($validated['limit'] ?? 50),
        );

        return response()->json([
            'data' => array_map(
                fn (array $entry): array => $this->queueRowResource($entry['row'], $entry['group'], $entry['reasons']),
                $result['data']
            ),
            'meta' => [
                'group'      => $group,
                'source'     => '' === $source ? null : $source,
                'pagination' => [
                    'total'        => $result['total'],
                    'count'        => count($result['data']),
                    'per_page'     => $result['limit'],
                    'current_page' => $result['page'],
                    'total_pages'  => max(1, (int) ceil($result['total'] / $result['limit'])),
                ],
            ],
        ]);
    }

    public function dismiss(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'row_ids'   => ['nullable', 'array'],
            'row_ids.*' => ['integer'],
            'filter'    => ['nullable', 'string', 'in:machine_duplicates'],
        ]);

        $user   = auth()->user();
        $filter = (string) ($validated['filter'] ?? '');
        $rowIds = array_values(array_unique(array_map('intval', $validated['row_ids'] ?? [])));

        if ('' === $filter && [] === $rowIds) {
            throw ValidationException::withMessages([
                'row_ids' => ['要划掉哪些流水：给 row_ids，或者给 filter。'],
            ]);
        }

        // 任务 id 得在改之前收集：划掉之后这些行就不是 pending 了，再查就查不着。
        $taskIds = $this->affectedTaskIds($user, $filter, $rowIds);

        $dismissed = 'machine_duplicates' === $filter
            ? $this->dismissalService->dismissMachineDuplicates($user)
            : $this->dismissalService->dismissRowIds($user, $rowIds, BillStatementRowDismissalService::REASON_USER);

        // 划掉可能正好是这个任务最后一条没处置的行，任务该收工了。
        foreach ($taskIds as $taskId) {
            $this->rowImportService->completeTaskWhenNoActionableRowsRemain($user, $taskId);
        }

        return response()->json([
            'data' => [
                'type'       => 'bill-row-dismiss-result',
                'attributes' => [
                    'dismissed' => $dismissed,
                    'reason'    => 'machine_duplicates' === $filter
                        ? BillStatementRowDismissalService::REASON_DUPLICATE_AUTO
                        : BillStatementRowDismissalService::REASON_USER,
                ],
            ],
        ]);
    }

    public function restore(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'row_ids'   => ['required', 'array', 'min:1'],
            'row_ids.*' => ['integer'],
        ]);

        $user     = auth()->user();
        $rowIds   = array_values(array_unique(array_map('intval', $validated['row_ids'])));
        $taskIds  = $this->taskIdsForRows($user, $rowIds);
        $restored = $this->dismissalService->restoreRowIds($user, $rowIds);

        foreach ($taskIds as $taskId) {
            $this->rowImportService->reopenTaskWhenRowsReturn($user, $taskId);
        }

        return response()->json([
            'data' => [
                'type'       => 'bill-row-restore-result',
                'attributes' => [
                    'restored' => $restored,
                ],
            ],
        ]);
    }

    /**
     * 跨任务批量入账。
     *
     * 入账本身还是走单任务的 BillStatementRowImportService::importTaskRows：
     * 余额链校验、重复拦截、失败回写都在那里面，这里只负责按任务分组再把结果拼起来。
     * confirm=false 是干跑，语义跟单任务接口一模一样。
     */
    public function import(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'row_ids'         => ['required', 'array', 'min:1'],
            'row_ids.*'       => ['integer'],
            'confirm'         => ['nullable', 'boolean'],
            'include_payload' => ['nullable', 'boolean'],
        ]);

        $user   = auth()->user();
        $rowIds = array_values(array_unique(array_map('intval', $validated['row_ids'])));
        $byTask = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->whereIn('id', $rowIds)
            ->orderBy('bill_task_id')
            ->orderBy('row_number')
            ->get(['id', 'bill_task_id'])
            ->groupBy('bill_task_id')
        ;

        $summary = ['total' => 0, 'imported' => 0, 'skipped' => 0, 'failed' => 0];
        $rows    = [];
        $tasks   = [];

        foreach ($byTask as $taskId => $taskRows) {
            $result = $this->rowImportService->importTaskRows(
                $user,
                (int) $taskId,
                $taskRows->map(static fn (BillStatementRow $row): int => (int) $row->id)->all(),
                $request->boolean('confirm'),
                ['include_payload' => $request->boolean('include_payload')],
            );

            foreach (array_keys($summary) as $key) {
                $summary[$key] += $result['summary'][$key];
            }
            $rows    = [...$rows, ...$result['rows']];
            // 余额链是按账户算的，跨任务合并成一份会互相盖掉，所以按任务分开放。
            $tasks[] = [
                'task_id'       => (string) $taskId,
                'summary'       => $result['summary'],
                'balance_chain' => $result['balance_chain'],
            ];
        }

        return response()->json([
            'summary' => $summary,
            'rows'    => $rows,
            'tasks'   => $tasks,
        ]);
    }

    /**
     * @param array<int,int> $rowIds
     *
     * @return array<int,int>
     */
    private function affectedTaskIds(User $user, string $filter, array $rowIds): array
    {
        $query = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->where('status', 'pending')
        ;
        if ('machine_duplicates' === $filter) {
            $query->where('duplicate_state', 'duplicate');
        }
        if ('machine_duplicates' !== $filter) {
            $query->whereIn('id', $rowIds);
        }

        return $query->distinct()->pluck('bill_task_id')->map(static fn (mixed $id): int => (int) $id)->all();
    }

    /**
     * @param array<int,int> $rowIds
     *
     * @return array<int,int>
     */
    private function taskIdsForRows(User $user, array $rowIds): array
    {
        return BillStatementRow::query()
            ->where('user_id', $user->id)
            ->whereIn('id', $rowIds)
            ->distinct()
            ->pluck('bill_task_id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all()
        ;
    }
}
