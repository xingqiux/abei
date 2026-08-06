<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\User;

/**
 * 账单收件箱首页/侧栏用的渠道计数聚合。
 *
 * 统计口径原本写死在 Web 端 BillInbox\IndexController 里，这里抽出来，
 * 让 Web 页面与 API（/api/v1/bill-inbox/summary）共用同一份查询逻辑。
 */
class BillInboxSummaryService
{
    public function __construct(private readonly BillSourceChannelRegistry $channelRegistry) {}

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
        foreach ($this->channelRegistry->settingsChannels() as $channel) {
            $source = (string) $channel['source'];
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
                ->where('status', 'pending')
                ->whereHas('billTask', static fn ($query) => $query->where('source', $source))
                ->count()
            ;

            $channels[] = [
                'source'             => $source,
                'name'               => $channel['name'],
                'description'        => $channel['description'],
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
     * @return array{pending_total:int,needs_code:int,unprocessed:int,failed:int,channels:array<int,array<string,mixed>>}
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

        return [
            'pending_total' => $needsCode + $unprocessed + $failed,
            'needs_code'    => $needsCode,
            'unprocessed'   => $unprocessed,
            'failed'        => $failed,
            'channels'      => $channels,
        ];
    }
}
