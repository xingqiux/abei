<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\TransactionJournalMeta;
use FireflyIII\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

class BillStatementRowSummaryService
{
    public function __construct(
        private readonly CrossSourceDuplicateMatcher $crossSourceMatcher = new CrossSourceDuplicateMatcher(),
    ) {}

    /**
     * @param array{status?:string,from?:string,to?:string,limit?:int} $filters
     *
     * @return array{summary:array<string,mixed>,data:array<int,array<string,mixed>>}
     */
    public function summarizeTaskRows(User $user, int $taskId, array $filters = []): array
    {
        $query = $this->taskRowsQuery($user, $taskId, $filters)
            ->orderBy('occurred_at', 'desc')
            ->orderBy('row_number')
        ;

        /** @var Collection<int, BillStatementRow> $allRows */
        $allRows = (clone $query)->get();
        $limit   = max(1, (int) ($filters['limit'] ?? 20));

        return [
            'summary' => $this->summaryForRows($allRows),
            'data'    => $allRows->take($limit)->map(fn (BillStatementRow $row): array => $this->rowPreview($row))->values()->all(),
        ];
    }

    /**
     * @return array<string,mixed>
     */
    public function reviewTaskRows(User $user, int $taskId): array
    {
        /** @var Collection<int, BillStatementRow> $rows */
        $rows               = $this->taskRowsQuery($user, $taskId, [])->orderBy('row_number')->get();
        $existingReferences = $this->existingReferences($user, $rows);
        $pendingRows        = $rows->filter(fn (BillStatementRow $row): bool => 'pending' === $row->status)->values();
        $crossSourceMatches = $this->crossSourceMatcher->matchRows($user, $pendingRows);
        $existingCandidates = [];
        $transferCandidates = [];
        $skipCandidates     = [];
        $needsUserNote      = [];
        $newCandidates      = [];
        $duplicateCandidates = [];
        $conflictCandidates  = [];
        $preservedUserEdits  = [];
        $crossSourceCandidates = [];

        foreach ($pendingRows as $row) {
            $preview = $this->rowPreview($row);
            $rowMatches = $crossSourceMatches[$row->id] ?? [];
            $preview['cross_source_matches'] = $rowMatches;
            if ([] !== $rowMatches) {
                $crossSourceCandidates[] = $preview + ['reason' => '疑似与已有 Firefly 交易重复（跨来源）'];
                if ('high' === ($rowMatches[0]['confidence'] ?? '')) {
                    $skipCandidates[] = $preview + ['reason' => '高度疑似跨来源重复交易'];
                }
            }
            if ('conflict' === $row->duplicate_state) {
                $conflictCandidates[] = $preview + ['reason' => '疑似重复但核心字段冲突'];
                $skipCandidates[]     = $preview + ['reason' => '重复识别冲突，需要人工确认'];
            }
            if ('duplicate' === $row->duplicate_state) {
                $duplicateCandidates[] = $preview + ['reason' => '已存在相同账单流水'];
                if (null !== $row->user_modified_at) {
                    $preservedUserEdits[] = $preview + ['reason' => '重复流水已保留你的手动修改'];
                }
            }
            if (null !== $row->firefly_type && '' !== $row->firefly_type && !$this->looksSpecialCase($row) && !in_array($row->duplicate_state, ['duplicate', 'conflict'], true)) {
                $newCandidates[] = $preview;
            }
            if ($this->hasExistingReference($row, $existingReferences)) {
                $existingCandidates[] = $preview + ['reason' => '同订单号已存在 Firefly 交易'];
                $skipCandidates[]     = $preview + ['reason' => '疑似重复交易'];
            }
            if ($this->looksLikeTransfer($row)) {
                $transferCandidates[] = $preview + ['reason' => '疑似自己账户转账'];
            }
            if ($this->needsUserNote($row)) {
                $needsUserNote[] = $preview + ['reason' => '用途不够明确，需要补备注'];
            }
            if (null === $row->firefly_type || '' === $row->firefly_type || in_array($row->direction, ['不计收支', '其他'], true)) {
                $skipCandidates[] = $preview + ['reason' => '不是可直接导入的普通收支'];
            }
        }

        return [
            'summary'               => $this->reviewSummary($rows, $newCandidates, $skipCandidates, $transferCandidates, $needsUserNote, $duplicateCandidates, $conflictCandidates, $preservedUserEdits),
            'new_candidates'        => $this->uniqueByRowId($newCandidates),
            'existing_candidates'   => $this->uniqueByRowId($existingCandidates),
            'cross_source_candidates' => $this->uniqueByRowId($crossSourceCandidates),
            'duplicate_candidates'  => $this->uniqueByRowId($duplicateCandidates),
            'conflict_candidates'   => $this->uniqueByRowId($conflictCandidates),
            'preserved_user_edits'  => $this->uniqueByRowId($preservedUserEdits),
            'skip_candidates'       => $this->uniqueByRowId($skipCandidates),
            'transfer_candidates'   => $this->uniqueByRowId($transferCandidates),
            'refund_pairs'          => $this->refundPairs($pendingRows),
            'needs_user_note'       => $this->uniqueByRowId($needsUserNote),
        ];
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<string,mixed>
     */
    public function summaryForRows(Collection $rows): array
    {
        $expense = '0';
        $income  = '0';

        foreach ($rows as $row) {
            $amount = $this->rowAmount($row);
            if ($this->isIncome($row)) {
                $income = bcadd($income, $amount, 2);
                continue;
            }
            if ($this->isExpense($row)) {
                $expense = bcadd($expense, $amount, 2);
            }
        }

        return [
            'total'           => $rows->count(),
            'by_status'          => $this->countBy($rows, 'status'),
            'by_direction'       => $this->countBy($rows, 'direction'),
            'by_firefly_type'    => $this->countBy($rows, 'firefly_type'),
            'by_duplicate_state' => $this->countBy($rows, 'duplicate_state'),
            'amounts'            => [
                'expense' => $this->formatAmount($expense),
                'income'  => $this->formatAmount($income),
                'net'     => $this->formatAmount(bcsub($income, $expense, 2)),
            ],
        ];
    }

    /**
     * @return array<string,mixed>
     */
    public function rowPreview(BillStatementRow $row): array
    {
        return [
            'row_id'              => (string) $row->id,
            'row_number'          => $row->row_number,
            'status'              => $row->status,
            'occurred_at'         => optional($row->occurred_at)->toAtomString(),
            'direction'           => $row->direction,
            'amount'              => null === $row->amount ? null : $this->formatAmount((string) $row->amount),
            'firefly_type'        => $row->firefly_type,
            'firefly_amount'      => null === $row->firefly_amount ? null : $this->formatAmount((string) $row->firefly_amount),
            'counterparty'        => $this->redactText($row->counterparty),
            'description_preview' => $this->redactText($this->truncate((string) ($row->firefly_description ?: $row->description ?: ''))),
            'source_name'         => $this->redactText($row->source_name),
            'destination_name'    => $this->redactText($row->destination_name),
            'category_name'       => $row->category_name,
            'duplicate_state'     => $row->duplicate_state,
            'duplicate_of_row_id' => null === $row->duplicate_of_row_id ? null : (string) $row->duplicate_of_row_id,
            'user_modified_at'    => optional($row->user_modified_at)->toAtomString(),
            'error'               => $row->error_message,
            'transaction_group_id'=> null === $row->transaction_group_id ? null : (string) $row->transaction_group_id,
        ];
    }

    /**
     * @param array{status?:string,from?:string,to?:string,limit?:int} $filters
     *
     * @return Builder<BillStatementRow>
     */
    public function taskRowsQuery(User $user, int $taskId, array $filters): Builder
    {
        $query = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->where('bill_task_id', $taskId)
        ;

        $status = (string) ($filters['status'] ?? '');
        $from   = (string) ($filters['from'] ?? '');
        $to     = (string) ($filters['to'] ?? '');
        if ('' !== $status) {
            $query->where('status', $status);
        }
        if ('' !== $from) {
            $query->where('occurred_at', '>=', $from.' 00:00:00');
        }
        if ('' !== $to) {
            $query->where('occurred_at', '<=', $to.' 23:59:59');
        }

        return $query;
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<string,true>
     */
    private function existingReferences(User $user, Collection $rows): array
    {
        $references = $rows
            ->flatMap(static fn (BillStatementRow $row): array => array_filter([$row->platform_order_no, $row->merchant_order_no], static fn ($value): bool => is_string($value) && '' !== $value))
            ->unique()
            ->values()
        ;
        if ($references->isEmpty()) {
            return [];
        }

        return TransactionJournalMeta::query()
            ->whereHas('transactionJournal', static fn (Builder $query) => $query->where('user_id', $user->id))
            ->whereIn('name', ['internal_reference', 'external_id'])
            ->whereIn('data', $references->map(static fn (string $reference): string => json_encode($reference, JSON_THROW_ON_ERROR))->all())
            ->whereNull('deleted_at')
            ->pluck('data')
            ->map(static fn (mixed $data): string => (string) $data)
            ->flip()
            ->map(static fn (): bool => true)
            ->all()
        ;
    }

    /**
     * @param array<string,true> $existingReferences
     */
    private function hasExistingReference(BillStatementRow $row, array $existingReferences): bool
    {
        foreach ([$row->platform_order_no, $row->merchant_order_no] as $reference) {
            if (is_string($reference) && '' !== $reference && isset($existingReferences[$reference])) {
                return true;
            }
        }

        return false;
    }

    private function looksSpecialCase(BillStatementRow $row): bool
    {
        return $this->looksLikeTransfer($row) || in_array($row->direction, ['不计收支', '其他'], true);
    }

    private function looksLikeTransfer(BillStatementRow $row): bool
    {
        $haystack = implode(' ', array_filter([
            $row->firefly_type,
            $row->platform_category,
            $row->counterparty,
            $row->description,
            $row->source_name,
            $row->destination_name,
            $row->payment_method,
        ], static fn ($value): bool => is_string($value) && '' !== $value));

        if ('transfer' === $row->firefly_type) {
            return true;
        }

        foreach (['转账', '提现', '充值', '花呗还款', '信用卡还款', '网联收款'] as $keyword) {
            if (str_contains($haystack, $keyword)) {
                return true;
            }
        }

        return false;
    }

    private function needsUserNote(BillStatementRow $row): bool
    {
        if (null !== $row->notes && '' !== trim($row->notes)) {
            return false;
        }
        if (null === $row->category_name || '' === trim((string) $row->category_name)) {
            return true;
        }

        $text = trim((string) ($row->description ?: $row->counterparty ?: ''));
        if ('' === $text) {
            return true;
        }

        return in_array($text, ['微信转账', '转账', '二维码收款', '收款', '付款'], true);
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<int,array<string,mixed>>
     */
    private function refundPairs(Collection $rows): array
    {
        $expenses = $rows->filter(fn (BillStatementRow $row): bool => $this->isExpense($row))->values();
        $incomes  = $rows->filter(fn (BillStatementRow $row): bool => $this->isIncome($row))->values();
        $pairs    = [];

        foreach ($expenses as $expense) {
            foreach ($incomes as $income) {
                if ($this->rowAmount($expense) !== $this->rowAmount($income)) {
                    continue;
                }
                if ($this->normalizedCounterparty($expense) !== $this->normalizedCounterparty($income)) {
                    continue;
                }
                $pairs[] = [
                    'expense_row_id' => (string) $expense->id,
                    'income_row_id'  => (string) $income->id,
                    'amount'         => $this->formatAmount($this->rowAmount($expense)),
                    'counterparty'   => $this->redactText($expense->counterparty),
                    'reason'         => '同交易对方同金额收支抵消',
                ];
            }
        }

        return $pairs;
    }

    private function normalizedCounterparty(BillStatementRow $row): string
    {
        return trim((string) ($row->counterparty ?: $row->destination_name ?: $row->source_name ?: ''));
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     * @param array<int,array<string,mixed>>    $newCandidates
     * @param array<int,array<string,mixed>>    $skipCandidates
     * @param array<int,array<string,mixed>>    $transferCandidates
     * @param array<int,array<string,mixed>>    $needsUserNote
     * @param array<int,array<string,mixed>>    $duplicateCandidates
     * @param array<int,array<string,mixed>>    $conflictCandidates
     * @param array<int,array<string,mixed>>    $preservedUserEdits
     *
     * @return array<string,mixed>
     */
    private function reviewSummary(Collection $rows, array $newCandidates, array $skipCandidates, array $transferCandidates, array $needsUserNote, array $duplicateCandidates, array $conflictCandidates, array $preservedUserEdits): array
    {
        $summary = $this->summaryForRows($rows);

        return $summary + [
            'pending'                 => $rows->where('status', 'pending')->count(),
            'imported'                => $rows->where('status', 'imported')->count(),
            'failed'                  => $rows->where('status', 'failed')->count(),
            'importable'              => count($this->uniqueByRowId($newCandidates)),
            'skip_candidates'         => count($this->uniqueByRowId($skipCandidates)),
            'transfer_candidates'     => count($this->uniqueByRowId($transferCandidates)),
            'needs_user_note'         => count($this->uniqueByRowId($needsUserNote)),
            'duplicate_candidates'    => count($this->uniqueByRowId($duplicateCandidates)),
            'conflict_candidates'     => count($this->uniqueByRowId($conflictCandidates)),
            'preserved_user_edits'    => count($this->uniqueByRowId($preservedUserEdits)),
        ];
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<string,int>
     */
    private function countBy(Collection $rows, string $field): array
    {
        return $rows
            ->groupBy(static fn (BillStatementRow $row): string => (string) ($row->{$field} ?? '未设置'))
            ->map(static fn (Collection $group): int => $group->count())
            ->all()
        ;
    }

    /**
     * @param array<int,array<string,mixed>> $items
     *
     * @return array<int,array<string,mixed>>
     */
    private function uniqueByRowId(array $items): array
    {
        $seen = [];

        return array_values(array_filter($items, static function (array $item) use (&$seen): bool {
            $rowId = (string) ($item['row_id'] ?? '');
            if ('' === $rowId || isset($seen[$rowId])) {
                return false;
            }
            $seen[$rowId] = true;

            return true;
        }));
    }

    private function isExpense(BillStatementRow $row): bool
    {
        return '支出' === $row->direction || 'withdrawal' === $row->firefly_type;
    }

    private function isIncome(BillStatementRow $row): bool
    {
        return '收入' === $row->direction || 'deposit' === $row->firefly_type;
    }

    private function rowAmount(BillStatementRow $row): string
    {
        return $this->formatAmount((string) ($row->firefly_amount ?? $row->amount ?? '0'));
    }

    private function formatAmount(string $amount): string
    {
        return number_format((float) $amount, 2, '.', '');
    }

    private function truncate(string $value, int $limit = 60): string
    {
        if (mb_strlen($value) <= $limit) {
            return $value;
        }

        return mb_substr($value, 0, $limit - 1).'…';
    }

    private function redactText(?string $value): ?string
    {
        if (null === $value || '' === $value) {
            return $value;
        }

        return (string) preg_replace_callback('/\d{7,}/', static function (array $matches): string {
            $number = $matches[0];

            return substr($number, 0, 2).'****'.substr($number, -2);
        }, $value);
    }
}
