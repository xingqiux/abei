<?php

declare(strict_types=1);

namespace FireflyIII\Services\DailyReconciliation;

use Carbon\Carbon;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Models\Transaction;
use FireflyIII\Models\TransactionJournal;
use FireflyIII\Support\Facades\FireflyConfig;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;

final class DailyReconciliationService
{
    /**
     * @return array{date:string,total:int,updated:int,already_reconciled:int,transactions_updated:int}
     */
    public function reconcile(User $user, Carbon $day): array
    {
        $timezone = config('app.timezone');
        $localDay = $day->copy()->setTimezone($timezone);
        $start    = $localDay->copy()->startOfDay();
        $end      = $localDay->copy()->endOfDay();
        if (true === FireflyConfig::get('utc', false)?->data) {
            $start->setTimezone('UTC');
            $end->setTimezone('UTC');
        }

        return DB::transaction(static function () use ($user, $localDay, $start, $end): array {
            $journalIds = TransactionJournal::query()
                ->where('user_id', $user->id)
                ->whereBetween('date', [$start, $end])
                ->whereHas('transactionType', static fn ($query) => $query->whereIn('type', [
                    TransactionTypeEnum::WITHDRAWAL->value,
                    TransactionTypeEnum::DEPOSIT->value,
                    TransactionTypeEnum::TRANSFER->value,
                ]))
                ->lockForUpdate()
                ->pluck('id')
            ;

            $total = $journalIds->count();
            if (0 === $total) {
                return [
                    'date'                 => $localDay->format('Y-m-d'),
                    'total'                => 0,
                    'updated'              => 0,
                    'already_reconciled'   => 0,
                    'transactions_updated' => 0,
                ];
            }

            $pendingJournalIds = Transaction::query()
                ->whereIn('transaction_journal_id', $journalIds)
                ->where('reconciled', false)
                ->distinct()
                ->pluck('transaction_journal_id')
            ;
            $transactionsUpdated = Transaction::query()
                ->whereIn('transaction_journal_id', $pendingJournalIds)
                ->where('reconciled', false)
                ->update(['reconciled' => true])
            ;
            $updated = $pendingJournalIds->count();

            return [
                'date'                 => $localDay->format('Y-m-d'),
                'total'                => $total,
                'updated'              => $updated,
                'already_reconciled'   => $total - $updated,
                'transactions_updated' => $transactionsUpdated,
            ];
        });
    }
}
