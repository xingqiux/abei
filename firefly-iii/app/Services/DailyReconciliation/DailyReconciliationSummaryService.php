<?php

declare(strict_types=1);

namespace FireflyIII\Services\DailyReconciliation;

use Carbon\Carbon;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Helpers\Collector\GroupCollectorInterface;
use FireflyIII\Models\TransactionJournal;
use FireflyIII\User;

/**
 * 按天对账页面用的收支聚合与对账状态判断。
 *
 * 「按天对账」页面（daily-reconciliation）本身只是一个可编辑的当日流水清单，
 * 并不单独存储「本日已对账/有差异」这类状态。本服务复用 Firefly III 原生的
 * 账户区间对账流程（accounts/{account}/reconcile，见
 * app/Http/Controllers/Account/ReconcileController::submit()）留下的两个真实数据信号：
 *   1. transactions.reconciled 布尔位：用户在该流程里勾选交易「已对账」时被置 true；
 *   2. 若对账有差额，该流程会额外生成一笔 type=Reconciliation 的调整交易，
 *      金额即为差额。
 *
 * 由此推导每日状态：
 *   - none:       当天没有任何收支/转账流水
 *   - diff:       当天存在 Reconciliation 类型的调整交易（说明当时对账有差额）
 *   - reconciled: 当天有流水，且全部 transactions.reconciled = true
 *   - pending:    当天有流水，但至少有一笔未标记为已对账
 *
 * Web 端 DailyReconciliationController 与 API 端
 * (GET /api/v1/daily-reconciliation/summary) 共用本服务，避免重复查询逻辑。
 */
class DailyReconciliationSummaryService
{
    private const array TX_TYPES = [
        TransactionTypeEnum::WITHDRAWAL->value,
        TransactionTypeEnum::DEPOSIT->value,
        TransactionTypeEnum::TRANSFER->value,
    ];

    /**
     * 单日收支汇总，原始 bcmath 字符串（未做币种符号格式化），供 Web 端按当前
     * 显示币种自行格式化。
     *
     * @return array{income:string,expense:string,net:string,count:int,currency_id:int|null}
     */
    public function singleDayTotals(User $user, Carbon $day): array
    {
        $start = $day->copy()->startOfDay()->setTimezone('UTC');
        $end   = $day->copy()->endOfDay()->setTimezone('UTC');

        $journals = $this->collectJournals($user, $start, $end, self::TX_TYPES);

        $bucket = $this->emptyBucket();
        foreach ($journals as $journal) {
            $this->accumulate($bucket, $journal);
        }

        return [
            'income'      => $bucket['income'],
            'expense'     => $bucket['expense'],
            'net'         => bcsub($bucket['income'], $bucket['expense'], 2),
            'count'       => $bucket['count'],
            'currency_id' => $bucket['currency_id'],
        ];
    }

    /**
     * 最近 $days 天的按天汇总 + 对账状态，供 API 使用。
     *
     * @return array{last_reconciled_date:?string,days_unreconciled:int,days:array<int,array<string,mixed>>}
     */
    public function rangeSummary(User $user, int $days = 30): array
    {
        $tz         = config('app.timezone');
        $today      = today($tz)->startOfDay();
        $days       = max(1, min(366, $days));
        $rangeStart = $today->copy()->subDays($days - 1);

        $start = $rangeStart->copy()->setTimezone('UTC');
        $end   = $today->copy()->endOfDay()->setTimezone('UTC');

        $normalJournals = $this->collectJournals($user, $start, $end, self::TX_TYPES);
        $reconJournals  = $this->collectJournals($user, $start, $end, [TransactionTypeEnum::RECONCILIATION->value]);

        $buckets = [];
        $cursor  = $rangeStart->copy();
        while ($cursor->lte($today)) {
            $buckets[$cursor->format('Y-m-d')] = $this->emptyBucket() + [
                'diff_amount'    => '0',
                'all_reconciled' => true,
            ];
            $cursor->addDay();
        }

        foreach ($normalJournals as $journal) {
            $key = $journal['date']->copy()->setTimezone($tz)->format('Y-m-d');
            if (!isset($buckets[$key])) {
                continue;
            }
            $this->accumulate($buckets[$key], $journal);
            if (true !== $journal['reconciled']) {
                $buckets[$key]['all_reconciled'] = false;
            }
        }

        foreach ($reconJournals as $journal) {
            $key = $journal['date']->copy()->setTimezone($tz)->format('Y-m-d');
            if (!isset($buckets[$key])) {
                continue;
            }
            $amount                        = (string) $journal['amount'];
            $absAmount                     = str_starts_with($amount, '-') ? substr($amount, 1) : $amount;
            $buckets[$key]['diff_amount']  = bcadd($buckets[$key]['diff_amount'], $absAmount, 2);
        }

        $dayList = [];
        foreach (array_reverse(array_keys($buckets)) as $date) {
            $bucket  = $buckets[$date];
            $hasDiff = 0 !== bccomp($bucket['diff_amount'], '0', 2);
            $status  = match (true) {
                0 === $bucket['count'] && !$hasDiff => 'none',
                $hasDiff                            => 'diff',
                $bucket['all_reconciled']            => 'reconciled',
                default                              => 'pending',
            };

            $dayList[] = [
                'date'        => $date,
                'status'      => $status,
                'income'      => $this->formatAmount($bucket['income']),
                'expense'     => $this->formatAmount($bucket['expense']),
                'net'         => $this->formatAmount(bcsub($bucket['income'], $bucket['expense'], 2)),
                'tx_count'    => $bucket['count'],
                'diff_amount' => $hasDiff ? $this->formatAmount($bucket['diff_amount']) : null,
            ];
        }

        ['date' => $lastReconciledDate, 'days_unreconciled' => $daysUnreconciled] = $this->unreconciledWindow($user, $today, $tz);

        return [
            'last_reconciled_date' => $lastReconciledDate,
            'days_unreconciled'    => $daysUnreconciled,
            'days'                 => $dayList,
        ];
    }

    /**
     * @param array<int,string> $types
     *
     * @return array<int,array<string,mixed>>
     */
    private function collectJournals(User $user, Carbon $start, Carbon $end, array $types): array
    {
        /** @var GroupCollectorInterface $collector */
        $collector = app(GroupCollectorInterface::class);
        $collector->setUser($user);

        return $collector
            ->setRange($start, $end)
            ->setTypes($types)
            ->getExtractedJournals()
        ;
    }

    /**
     * @return array{income:string,expense:string,count:int,currency_id:int|null}
     */
    private function emptyBucket(): array
    {
        return ['income' => '0', 'expense' => '0', 'count' => 0, 'currency_id' => null];
    }

    /**
     * @param array{income:string,expense:string,count:int,currency_id:int|null} $bucket
     * @param array<string,mixed>                                                $journal
     */
    private function accumulate(array &$bucket, array $journal): void
    {
        ++$bucket['count'];
        $bucket['currency_id'] ??= ((int) ($journal['currency_id'] ?? 0)) ?: null;

        // GroupCollector 固定选的是「来源腿」的金额（source.amount as amount），
        // 按 Firefly 复式记账惯例，来源腿永远是负数（不管是取现的资产账户，
        // 还是收入交易里充当来源的对方账户）。所以收入、支出都要取反号才是
        // 正数展示值；原 Web 端旧代码只对收入取反、支出直接相加，
        // 导致支出汇总为负数，这里一并修正（Web 与 API 共用，两边都受益）。
        $amount = (string) $journal['amount'];
        if (TransactionTypeEnum::DEPOSIT->value === $journal['transaction_type_type']) {
            $bucket['income'] = bcadd($bucket['income'], bcmul($amount, '-1'), 2);
        }
        if (TransactionTypeEnum::WITHDRAWAL->value === $journal['transaction_type_type']) {
            $bucket['expense'] = bcadd($bucket['expense'], bcmul($amount, '-1'), 2);
        }
        // transfer 类型只计入 count，不计收支（与原 Web 端汇总口径一致）。
    }

    /**
     * 最近一次「已对账」的日期，以及从那之后到今天为止未对账的天数。
     *
     * 若从未做过任何对账，则从用户最早一笔交易的日期起算。
     *
     * @return array{date:?string,days_unreconciled:int}
     */
    private function unreconciledWindow(User $user, Carbon $today, string $tz): array
    {
        $lastReconciled = TransactionJournal::query()
            ->where('user_id', $user->id)
            ->whereHas('transactions', static fn ($query) => $query->where('reconciled', true))
            ->orderByDesc('date')
            ->first()
        ;

        if ($lastReconciled instanceof TransactionJournal) {
            $lastDate          = $lastReconciled->date->copy()->setTimezone($tz)->startOfDay();
            $startUnreconciled = $lastDate->copy()->addDay()->startOfDay();
            $daysUnreconciled  = $startUnreconciled->gt($today) ? 0 : (int) $startUnreconciled->diffInDays($today) + 1;

            return ['date' => $lastDate->format('Y-m-d'), 'days_unreconciled' => $daysUnreconciled];
        }

        $earliest = TransactionJournal::query()->where('user_id', $user->id)->orderBy('date')->first();
        if (!$earliest instanceof TransactionJournal) {
            return ['date' => null, 'days_unreconciled' => 0];
        }

        $earliestDate     = $earliest->date->copy()->setTimezone($tz)->startOfDay();
        $daysUnreconciled = $earliestDate->gt($today) ? 0 : (int) $earliestDate->diffInDays($today) + 1;

        return ['date' => null, 'days_unreconciled' => $daysUnreconciled];
    }

    private function formatAmount(string $amount): string
    {
        return number_format((float) $amount, 2, '.', '');
    }
}
