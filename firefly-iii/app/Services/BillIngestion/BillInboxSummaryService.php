<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillMailboxSyncState;
use FireflyIII\Models\BillTask;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;

/**
 * 账单收件箱首页/侧栏用的渠道计数聚合。
 *
 * 统计口径原本写死在 Web 端 BillInbox\IndexController 里，这里抽出来，
 * 让 Web 页面与 API（/api/v1/bill-inbox/summary）共用同一份查询逻辑。
 */
class BillInboxSummaryService
{
    public function __construct(
        private readonly BillSourceChannelRegistry $channelRegistry,
        private readonly BillStatementRowQueueService $queueService,
    ) {}

    /**
     * 每个渠道一条记录，字段含义：
     *   source              渠道 key（alipay/wechat/cmb/boc...）
     *   name                渠道展示名
     *   description         渠道说明
     *   needs_secret_count  需要验证码/密码的任务数
     *   todo_count          待处理任务数（已接收 received + 待处理 ready）
     *   failed_count        处理失败任务数（failed + unknown）
     *   parsed_count        已解析任务数
     *   pending_row_count   待存入流水数（BillStatementRow.status = pending）
     *   latest_task         最近一个任务（BillTask|null）
     *   latest_status       最近一个任务的状态
     *   latest_received_at  最近一个任务的接收时间（Carbon|null）
     *
     * @return array<int, array<string, mixed>>
     */
    public function channelSummaries(User $user): array
    {
        $channels    = [];
        $seenSources = [];
        foreach ($this->channelRegistry->channels() as $channel) {
            $source = $channel->source();
            if (array_key_exists($source, $seenSources)) {
                continue;
            }
            $seenSources[$source] = true;

            $stats  = BillTask::query()
                ->where('user_id', $user->id)
                ->where('source', $source)
                ->selectRaw('status, count(*) as total')
                ->groupBy('status')
                ->pluck('total', 'status')
                ->toArray()
            ;
            $latest = BillTask::query()
                ->where('user_id', $user->id)
                ->where('source', $source)
                ->with('mailMessage')
                ->orderByDesc('received_at')
                ->orderByDesc('id')
                ->first()
            ;
            $pendingRows = BillStatementRow::query()
                ->where('user_id', $user->id)
                ->where('review_state', 'pending_book')
                ->whereHas('billTask', static fn ($query) => $query->where('source', $source))
                ->count()
            ;

            $channels[] = [
                'source'             => $source,
                'name'               => $channel->displayName(),
                'needs_secret_count' => (int) ($stats['needs_secret'] ?? 0),
                'todo_count'         => (int) ($stats['received'] ?? 0) + (int) ($stats['ready'] ?? 0),
                'failed_count'       => (int) ($stats['failed'] ?? 0) + (int) ($stats['unknown'] ?? 0),
                'parsed_count'       => (int) ($stats['parsed'] ?? 0),
                'pending_row_count'  => $pendingRows,
                'latest_task'        => $latest,
                'latest_status'      => null === $latest ? null : (string) $latest->status,
                'latest_received_at' => null === $latest ? null : $latest->received_at,
            ];
        }

        return $channels;
    }

    /**
     * 供 GET /api/v1/bill-inbox/summary 使用的扁平化结构。
     *
     * todo 是全站唯一的待办口径：侧栏 badge、页头、渠道卡片都读它，不再各算各的。
     * 之前每个界面自己拼一遍计数，同一时刻三个地方三个数，用户没法判断哪个可信。
     *
     * @return array{pending_total:int,needs_code:int,unprocessed:int,failed:int,todo:array{importable:int,attention:int,stuck_tasks:int,total:int},channels:array<int,array<string,mixed>>,mailbox_sync:array<string,mixed>}
     */
    public function apiSummary(User $user): array
    {
        $channels    = [];
        $needsCode   = 0;
        $unprocessed = 0;
        $failed      = 0;

        foreach ($this->channelSummaries($user) as $channel) {
            $needsCode   += $channel['needs_secret_count'];
            $unprocessed += $channel['todo_count'];
            $failed      += $channel['failed_count'];

            $channels[] = [
                'key'              => $channel['source'],
                'name'             => $channel['name'],
                'last_received_at' => null === $channel['latest_received_at'] ? null : $channel['latest_received_at']->toAtomString(),
                'needs_code'       => $channel['needs_secret_count'],
                'unprocessed'      => $channel['todo_count'],
                'failed'           => $channel['failed_count'],
                'parsed'           => $channel['parsed_count'],
                'to_store'         => $channel['pending_row_count'],
                'last_status'      => $channel['latest_status'],
            ];
        }

        // 卡住了的任务：等密码的、处理失败的、认不出来的。它们是任务级的问题，
        // 名下压根没解析出行，所以按任务数计，不混进行的计数里。
        $stuckTasks = $needsCode + $failed;
        $rowCounts  = $this->queueService->todoCounts($user);

        return [
            'pending_total' => $needsCode + $unprocessed + $failed,
            'needs_code'    => $needsCode,
            'unprocessed'   => $unprocessed,
            'failed'        => $failed,
            'todo'          => [
                'importable'  => $rowCounts['importable'],
                'attention'   => $rowCounts['attention'],
                'stuck_tasks' => $stuckTasks,
                'total'       => $rowCounts['importable'] + $rowCounts['attention'] + $stuckTasks,
            ],
            'channels'      => $channels,
            'mailbox_sync'  => $this->mailboxSyncState($user),
        ];
    }

    /**
     * @return array<string,mixed>
     */
    public function inboxSummary(User $user): array
    {
        $mailStates = BillTask::query()
            ->where('user_id', $user->id)
            ->selectRaw('status, count(*) as total')
            ->groupBy('status')
            ->pluck('total', 'status');
        $mailChannels = BillTask::query()
            ->where('user_id', $user->id)
            ->selectRaw('source, count(*) as total')
            ->groupBy('source')
            ->pluck('total', 'source')
            ->map(static fn (mixed $count): int => (int) $count)
            ->all();
        $rowStates = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->selectRaw('review_state, confirm_reason, excluded_reason, count(*) as total')
            ->groupBy('review_state', 'confirm_reason', 'excluded_reason')
            ->get();

        $rows = [
            'pending_book' => 0,
            'pending_confirm' => ['transfer' => 0, 'duplicate' => 0, 'split' => 0],
            'booked' => 0,
            'excluded' => [
                'user' => 0,
                'merged_duplicate' => 0,
                'zero_amount' => 0,
                'mail_archived' => 0,
                'split_parent' => 0,
                'superseded_by_booked' => 0,
            ],
        ];
        foreach ($rowStates as $state) {
            $count = (int) $state->total;
            if ('pending_confirm' === $state->review_state) {
                $reason = (string) $state->confirm_reason;
                $rows['pending_confirm'][$reason] = ($rows['pending_confirm'][$reason] ?? 0) + $count;
                continue;
            }
            if ('excluded' === $state->review_state) {
                $reason = (string) $state->excluded_reason;
                $rows['excluded'][$reason] = ($rows['excluded'][$reason] ?? 0) + $count;
                continue;
            }
            if (array_key_exists((string) $state->review_state, $rows)) {
                $rows[$state->review_state] += $count;
            }
        }

        $pendingByChannel = DB::table('bill_statement_rows as rows')
            ->join('bill_tasks as tasks', 'tasks.id', '=', 'rows.bill_task_id')
            ->where('rows.user_id', $user->id)
            ->whereIn('rows.review_state', ['pending_book', 'pending_confirm'])
            ->selectRaw('tasks.source, count(*) as total')
            ->groupBy('tasks.source')
            ->pluck('total', 'source')
            ->map(static fn (mixed $count): int => (int) $count)
            ->all();

        return [
            'mails' => [
                'total' => array_sum(array_map('intval', $mailStates->all())),
                'locked' => (int) ($mailStates['needs_secret'] ?? 0),
                'failed' => (int) ($mailStates['failed'] ?? 0),
                'by_channel' => $mailChannels,
            ],
            'rows' => $rows,
            'pending_by_channel' => $pendingByChannel,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function mailboxSyncState(User $user): array
    {
        $state = BillMailboxSyncState::query()->where('user_id', $user->id)->first();
        if (!$state instanceof BillMailboxSyncState) {
            return [
                'status'        => 'idle',
                'requested_at'  => null,
                'started_at'    => null,
                'finished_at'   => null,
                'result'        => null,
                'error_message' => null,
            ];
        }

        return [
            'status'        => $state->status,
            'requested_at'  => $state->requested_at?->toAtomString(),
            'started_at'    => $state->started_at?->toAtomString(),
            'finished_at'   => $state->finished_at?->toAtomString(),
            'result'        => $state->result,
            'error_message' => $state->error_message,
        ];
    }
}
