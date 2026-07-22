<?php

declare(strict_types=1);

namespace FireflyIII\Services;

use Carbon\Carbon;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Support\Facades\FireflyConfig;
use FireflyIII\User;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

final class FinancialReportService
{
    /**
     * @return array{top_expenses:array<int,array<string,mixed>>,transfer_flows:array<int,array<string,mixed>>}
     */
    public function overview(User $user, Carbon $startDay, Carbon $endDay, int $topLimit = 10): array
    {
        [$start, $end, $storedAsUtc] = $this->storageRange($startDay, $endDay);
        $topLimit = max(1, min($topLimit, 50));

        return [
            'top_expenses'  => $this->topExpenses($user, $start, $end, $storedAsUtc, $topLimit),
            'transfer_flows' => $this->transferFlows($user, $start, $end),
        ];
    }

    /**
     * @return array<int,array<string,mixed>>
     */
    private function topExpenses(User $user, Carbon $start, Carbon $end, bool $storedAsUtc, int $limit): array
    {
        $rows = $this->baseQuery($user, $start, $end)
            ->where('types.type', TransactionTypeEnum::WITHDRAWAL->value)
            ->select([
                'journals.transaction_group_id as group_id',
                'currencies.id as currency_id',
                'currencies.code as currency_code',
                'currencies.symbol as currency_symbol',
                'currencies.decimal_places',
            ])
            ->selectRaw('MAX(groups.title) as group_title')
            ->selectRaw('MIN(journals.description) as description')
            ->selectRaw('MAX(journals.date) as date')
            ->selectRaw('SUM(ABS(source.amount)) as amount')
            ->selectRaw('COUNT(DISTINCT journals.id) as split_count')
            ->groupBy([
                'journals.transaction_group_id',
                'currencies.id',
                'currencies.code',
                'currencies.symbol',
                'currencies.decimal_places',
            ])
            ->orderByRaw('SUM(ABS(source.amount)) DESC')
            ->get()
        ;

        $counts = [];
        $result = [];
        foreach ($rows as $row) {
            $currencyCode = (string) $row->currency_code;
            $counts[$currencyCode] ??= 0;
            if ($counts[$currencyCode] >= $limit) {
                continue;
            }
            ++$counts[$currencyCode];

            $timezone   = $storedAsUtc ? 'UTC' : config('app.timezone');
            $date       = Carbon::parse((string) $row->date, $timezone)->setTimezone(config('app.timezone'));
            $titleValue = $row->group_title;
            if (null === $titleValue || '' === $titleValue || '0' === $titleValue) {
                $titleValue = $row->description;
            }
            $title = trim((string) $titleValue);
            $result[] = [
                'group_id'        => (string) $row->group_id,
                'title'           => '' === $title ? '未命名交易' : $title,
                'date'            => $date->toAtomString(),
                'amount'          => bcadd((string) $row->amount, '0', (int) $row->decimal_places),
                'currency_id'     => (string) $row->currency_id,
                'currency_code'   => $currencyCode,
                'currency_symbol' => (string) $row->currency_symbol,
                'split_count'     => (int) $row->split_count,
            ];
        }

        return $result;
    }

    /**
     * @return array<int,array<string,mixed>>
     */
    private function transferFlows(User $user, Carbon $start, Carbon $end): array
    {
        return $this->baseQuery($user, $start, $end)
            ->where('types.type', TransactionTypeEnum::TRANSFER->value)
            ->select([
                'source_accounts.id as source_account_id',
                'source_accounts.name as source_account_name',
                'destination_accounts.id as destination_account_id',
                'destination_accounts.name as destination_account_name',
                'currencies.id as currency_id',
                'currencies.code as currency_code',
                'currencies.symbol as currency_symbol',
                'currencies.decimal_places',
            ])
            ->selectRaw('SUM(ABS(source.amount)) as amount')
            ->selectRaw('COUNT(DISTINCT journals.id) as transaction_count')
            ->groupBy([
                'source_accounts.id',
                'source_accounts.name',
                'destination_accounts.id',
                'destination_accounts.name',
                'currencies.id',
                'currencies.code',
                'currencies.symbol',
                'currencies.decimal_places',
            ])
            ->orderByRaw('SUM(ABS(source.amount)) DESC')
            ->get()
            ->map(static fn ($row): array => [
                'source_account_id'        => (string) $row->source_account_id,
                'source_account_name'      => (string) $row->source_account_name,
                'destination_account_id'   => (string) $row->destination_account_id,
                'destination_account_name' => (string) $row->destination_account_name,
                'amount'                   => bcadd((string) $row->amount, '0', (int) $row->decimal_places),
                'currency_id'              => (string) $row->currency_id,
                'currency_code'            => (string) $row->currency_code,
                'currency_symbol'          => (string) $row->currency_symbol,
                'transaction_count'        => (int) $row->transaction_count,
            ])
            ->values()
            ->all()
        ;
    }

    private function baseQuery(User $user, Carbon $start, Carbon $end): Builder
    {
        return DB::table('transaction_journals as journals')
            ->join('transaction_groups as groups', 'groups.id', '=', 'journals.transaction_group_id')
            ->join('transaction_types as types', 'types.id', '=', 'journals.transaction_type_id')
            ->join('transactions as source', static function ($join): void {
                $join->on('source.transaction_journal_id', '=', 'journals.id')->where('source.amount', '<', 0);
            })
            ->join('transactions as destination', static function ($join): void {
                $join->on('destination.transaction_journal_id', '=', 'journals.id')->where('destination.amount', '>', 0);
            })
            ->join('accounts as source_accounts', 'source_accounts.id', '=', 'source.account_id')
            ->join('accounts as destination_accounts', 'destination_accounts.id', '=', 'destination.account_id')
            ->join('transaction_currencies as currencies', 'currencies.id', '=', 'source.transaction_currency_id')
            ->where('journals.user_id', $user->id)
            ->whereBetween('journals.date', [$start->format('Y-m-d H:i:s'), $end->format('Y-m-d H:i:s')])
            ->whereNull('groups.deleted_at')
            ->whereNull('journals.deleted_at')
            ->whereNull('source.deleted_at')
            ->whereNull('destination.deleted_at')
        ;
    }

    /**
     * @return array{Carbon, Carbon, bool}
     */
    private function storageRange(Carbon $startDay, Carbon $endDay): array
    {
        $start       = $startDay->copy()->startOfDay();
        $end         = $endDay->copy()->endOfDay();
        $storedAsUtc = true === FireflyConfig::get('utc', false)?->data;
        if ($storedAsUtc) {
            $start->setTimezone('UTC');
            $end->setTimezone('UTC');
        }

        return [$start, $end, $storedAsUtc];
    }
}
