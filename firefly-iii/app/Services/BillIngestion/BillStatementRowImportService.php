<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Exceptions\FireflyException;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Models\TransactionGroup;
use FireflyIII\Repositories\TransactionGroup\TransactionGroupRepositoryInterface;
use FireflyIII\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Throwable;

class BillStatementRowImportService
{
    public function __construct(
        private readonly TransactionGroupRepositoryInterface $transactionRepository,
        private readonly BillStatementRowSummaryService $rowSummaryService,
        private readonly BillStatementCurrencyResolver $currencyResolver,
        private readonly BalanceChainVerifier $balanceChainVerifier = new BalanceChainVerifier(),
    ) {}

    /**
     * @param array<int,int> $rowIds
     *
     * @param array{include_payload?:bool} $options
     *
     * @return array{summary:array{total:int,imported:int,skipped:int,failed:int},rows:array<int,array<string,mixed>>,balance_chain:array<string,array<string,mixed>>}
     */
    public function importTaskRows(User $user, int $taskId, array $rowIds = [], bool $confirm = false, array $options = []): array
    {
        $query = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->where('bill_task_id', $taskId)
            ->orderBy('row_number')
        ;
        if ([] !== $rowIds) {
            $query->whereIn('id', $rowIds);
        }

        /** @var Collection<int, BillStatementRow> $rows */
        $rows    = $query->get();
        $reports = [];
        $summary = ['total' => $rows->count(), 'imported' => 0, 'skipped' => 0, 'failed' => 0];

        // Verify the balance chain BEFORE importing, over the rows that would
        // actually be created, so the current Firefly balance still excludes
        // them and net_effect is not double counted. Advisory only.
        $importableRows = $rows->filter(static fn (BillStatementRow $row): bool => 'pending' === $row->status)->values();
        $balanceChain   = $this->balanceChainVerifier->verifyBalance($user, $importableRows);

        foreach ($rows as $row) {
            $report = $this->importRow($user, $row, $confirm, (bool) ($options['include_payload'] ?? false));
            ++$summary[$report['status']];
            $reports[] = $report;
        }

        if ($confirm && $summary['imported'] > 0) {
            $this->completeTaskWhenNoActionableRowsRemain($user, $taskId);
        }

        return [
            'summary'       => $summary,
            'rows'          => $reports,
            'balance_chain' => $balanceChain,
        ];
    }

    private function completeTaskWhenNoActionableRowsRemain(User $user, int $taskId): void
    {
        $remaining = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->where('bill_task_id', $taskId)
            ->where(static function ($query): void {
                $query->whereIn('status', ['needs_split', 'failed'])
                    ->orWhere(static function ($pending): void {
                        $pending->where('status', 'pending')->where('duplicate_state', 'unique');
                    });
            })
            ->exists();
        if ($remaining) {
            return;
        }

        /** @var null|BillTask $task */
        $task = BillTask::query()->where('user_id', $user->id)->find($taskId);
        if (!$task instanceof BillTask || 'imported' === $task->status) {
            return;
        }
        $task->status = 'imported';
        $task->save();
        $task->events()->create([
            'event_type' => 'task.imported',
            'message'    => '账单任务中的可入账流水已处理完成',
        ]);
    }

    /**
     * @return array<string,mixed>
     */
    private function importRow(User $user, BillStatementRow $row, bool $confirm, bool $includePayload): array
    {
        if (in_array($row->status, ['needs_split', 'split'], true)) {
            return $this->reportForRow($user, $row, [
                'status' => 'skipped',
                'error'  => '组合支付需要先拆分真实扣款账户和金额。',
            ]);
        }

        if ('imported' === $row->status && null !== $row->transaction_group_id) {
            return $this->reportForRow($user, $row, [
                'status'               => 'skipped',
                'transaction_group_id' => (string) $row->transaction_group_id,
                'error'                => '这条流水已经存入 Firefly。',
            ]);
        }

        if (in_array($row->duplicate_state, ['duplicate', 'conflict'], true)) {
            return $this->reportForRow($user, $row, [
                'status' => 'skipped',
                'error'  => '这条流水已识别为重复或冲突，不自动导入。',
            ]);
        }

        if (null === $row->firefly_type || '' === $row->firefly_type) {
            return $this->reportForRow($user, $row, [
                'status' => 'skipped',
                'error'  => '这条流水不是可直接导入的收支记录。',
            ]);
        }

        $payload = $this->payloadForRow($user, $row);
        if (!$confirm) {
            $report = [
                'status' => 'skipped',
                'action' => 'would_import',
                'error'  => null,
            ];
            if ($includePayload) {
                $report['payload'] = $this->publicPayload($payload);
            }

            return $this->reportForRow($user, $row, $report);
        }

        try {
            /** @var TransactionGroup $group */
            $group = DB::transaction(function () use ($user, $row, $payload): TransactionGroup {
                $this->transactionRepository->setUser($user);
                $this->transactionRepository->setUserGroup($user->userGroup);
                $group = $this->transactionRepository->store($payload);

                $row->status               = 'imported';
                $row->transaction_group_id = $group->id;
                $row->error_message        = null;
                $row->save();

                return $group;
            });
        } catch (Throwable $e) {
            $errorMessage       = $e instanceof FireflyException
                ? $e->getMessage()
                : '导入失败，请检查账户和账单行后重试。';
            $row->status        = 'failed';
            $row->error_message = $errorMessage;
            $row->save();

            return $this->reportForRow($user, $row, [
                'status' => 'failed',
                'error'  => $errorMessage,
            ]);
        }

        return $this->reportForRow($user, $row->refresh(), [
            'status'               => 'imported',
            'transaction_group_id' => (string) $group->id,
        ]);
    }

    /**
     * @param array<string,mixed> $overrides
     *
     * @return array<string,mixed>
     */
    private function reportForRow(User $user, BillStatementRow $row, array $overrides): array
    {
        $overrides['action'] ??= match ($overrides['status'] ?? null) {
            'imported' => 'imported',
            'failed'   => 'failed',
            default    => 'skip',
        };

        return array_replace($this->rowSummaryService->rowPreview($row, $user), $overrides);
    }

    /**
     * @param array<string,mixed> $payload
     *
     * @return array<string,mixed>
     */
    private function publicPayload(array $payload): array
    {
        unset($payload['user'], $payload['user_group']);

        return $payload;
    }

    /**
     * @return array<string,mixed>
     */
    private function payloadForRow(User $user, BillStatementRow $row): array
    {
        $date     = $row->firefly_date instanceof Carbon ? $row->firefly_date : $row->occurred_at;
        $currency = $this->currencyResolver->resolve($user, $row);
        $description = $row->firefly_description;
        if (null === $description || '' === $description || '0' === $description) {
            $description = $row->description;
        }
        if (null === $description || '' === $description || '0' === $description) {
            $description = $row->counterparty;
        }

        return [
            'user'                    => $user,
            'user_group'              => $user->userGroup,
            'group_title'             => null,
            'error_if_duplicate_hash' => false,
            'batch_submission'        => false,
            'apply_rules'             => true,
            'fire_webhooks'           => true,
            'transactions'            => [[
                'type'                  => $row->firefly_type,
                'date'                  => $date ?? Carbon::now(config('app.timezone')),
                'order'                 => 0,
                'currency_id'           => $currency->id,
                'currency_code'         => $currency->code,
                'foreign_currency_id'   => null,
                'foreign_currency_code' => null,
                'amount'                => (string) $row->firefly_amount,
                'foreign_amount'        => null,
                'description'           => $description,
                'source_id'             => null,
                'source_name'           => $row->source_name,
                'source_iban'           => null,
                'source_number'         => null,
                'source_bic'            => null,
                'destination_id'        => null,
                'destination_name'      => $row->destination_name,
                'destination_iban'      => null,
                'destination_number'    => null,
                'destination_bic'       => null,
                'budget_id'             => null,
                'budget_name'           => null,
                'category_id'           => null,
                'category_name'         => $row->category_name,
                'bill_id'               => null,
                'bill_name'             => null,
                'piggy_bank_id'         => null,
                'piggy_bank_name'       => null,
                'reconciled'            => false,
                'notes'                 => $row->notes,
                'tags'                  => $row->tags ?? [],
                'internal_reference'    => $row->platform_order_no,
                'external_id'           => $row->merchant_order_no,
                'recurrence_id'         => null,
                'bunq_payment_id'       => null,
                'external_url'          => null,
                'sepa_cc'               => null,
                'sepa_ct_op'            => null,
                'sepa_ct_id'            => null,
                'sepa_db'               => null,
                'sepa_country'          => null,
                'sepa_ep'               => null,
                'sepa_ci'               => null,
                'sepa_batch_id'         => null,
                'interest_date'         => null,
                'book_date'             => null,
                'process_date'          => null,
                'due_date'              => null,
                'payment_date'          => null,
                'invoice_date'          => null,
            ]],
        ];
    }
}
