<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\Account;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Support\Steam;
use FireflyIII\User;
use Illuminate\Support\Collection;

/**
 * Balance chain verification for asset accounts (bank cards).
 *
 * For accounts whose statement rows carry a running balance (CMB/BOC),
 * verify that the Firefly balance reconciles with the statement balance:
 * current Firefly balance + net effect of selected rows = expected statement balance
 *
 * Issue #14, section 4: "导入前增加余额链校验"
 */
class BalanceChainVerifier
{
    private const TOLERANCE = 0.01;

    public function __construct(private readonly Steam $steam = new Steam()) {}

    /**
     * Verify balance chain for asset accounts with statement balances.
     *
     * @param Collection<int, BillStatementRow>|array<int, BillStatementRow> $rows
     *
     * @return array<string, array<string, mixed>> Keyed by account name, each entry contains:
     *   - account_name: string
     *   - current_firefly_balance: string (formatted decimal)
     *   - net_effect: string (sum of +deposits / -withdrawals)
     *   - expected_after: string (current + net_effect)
     *   - statement_balance: string (the metadata.balance of the latest row)
     *   - closes: bool (whether expected_after matches statement_balance within tolerance)
     *   - difference: string (absolute difference, or null if closes)
     */
    public function verifyBalance(User $user, Collection|array $rows): array
    {
        $collection = $rows instanceof Collection ? $rows : collect($rows);

        // Group rows by account (source for withdrawal, destination for deposit)
        $rowsByAccount = $this->groupRowsByAccount($collection);

        $result = [];
        foreach ($rowsByAccount as $accountName => $accountRows) {
            $balance = $this->verifyAccountBalance($user, $accountName, $accountRows);
            if (null !== $balance) {
                $result[$accountName] = $balance;
            }
        }

        return $result;
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<string, Collection<int, BillStatementRow>>
     */
    private function groupRowsByAccount(Collection $rows): array
    {
        $grouped = [];

        foreach ($rows as $row) {
            // Only process rows that have a statement balance
            if (!$this->hasStatementBalance($row)) {
                continue;
            }

            $accountName = $this->getAccountNameForRow($row);
            if ('' === $accountName) {
                continue;
            }

            if (!isset($grouped[$accountName])) {
                $grouped[$accountName] = new Collection();
            }
            $grouped[$accountName]->push($row);
        }

        return $grouped;
    }

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<string, mixed>|null
     */
    private function verifyAccountBalance(User $user, string $accountName, Collection $rows): ?array
    {
        // Find the Firefly account by name
        $account = Account::query()
            ->where('user_id', $user->id)
            ->where('name', $accountName)
            ->whereHas('accountType', fn ($q) => $q->where('type', 'Asset account'))
            ->first()
        ;

        if (null === $account) {
            return null;
        }

        // Get the current Firefly balance as of the earliest row date
        $earliestDate = $rows->min(fn (BillStatementRow $row) => $row->occurred_at?->timestamp ?? 0);
        if (0 === $earliestDate) {
            return null;
        }

        $earliestRow = $rows->first(fn (BillStatementRow $row) => ($row->occurred_at?->timestamp ?? 0) === $earliestDate);
        if (null === $earliestRow?->occurred_at) {
            return null;
        }

        // Get the balance BEFORE the first transaction (i.e., at start of day minus 1 second)
        $beforeDate = $earliestRow->occurred_at->copy()->subSecond();
        $fireflyBalanceArray = $this->steam->finalAccountBalance($account, $beforeDate, inclusive: true);
        $currentFireflyBalance = $this->extractBalance($user, $account, $fireflyBalanceArray);

        // Calculate net effect: sum of deposits minus withdrawals
        $netEffect = $this->calculateNetEffect($rows);

        // Expected balance after applying all rows
        $expectedAfter = bcadd($currentFireflyBalance, $netEffect, 2);

        // Get the statement balance from the latest row
        $latestRow = $rows->sortByDesc(fn (BillStatementRow $row) => $row->occurred_at?->timestamp ?? 0)->first();
        if (null === $latestRow) {
            return null;
        }

        $statementBalance = $this->getStatementBalance($latestRow);
        if (null === $statementBalance || '' === $statementBalance) {
            return null;
        }

        // Check if balances close within tolerance (|difference| <= tolerance).
        $difference    = bcsub($expectedAfter, $statementBalance, 2);
        $absDifference = str_starts_with($difference, '-') ? substr($difference, 1) : $difference;
        $closes        = bccomp($absDifference, $this->floatToStr(self::TOLERANCE), 2) <= 0;

        return [
            'account_name'           => $accountName,
            'current_firefly_balance'=> $currentFireflyBalance,
            'net_effect'             => $netEffect,
            'expected_after'         => $expectedAfter,
            'statement_balance'      => $statementBalance,
            'closes'                 => $closes,
            'difference'             => !$closes ? $difference : null,
        ];
    }

    /**
     * Calculate net effect: sum of deposits minus sum of withdrawals.
     *
     * @param Collection<int, BillStatementRow> $rows
     */
    private function calculateNetEffect(Collection $rows): string
    {
        $deposits = '0';
        $withdrawals = '0';

        foreach ($rows as $row) {
            $amount = (string) ($row->firefly_amount ?? $row->amount ?? '0');

            if ('deposit' === $row->firefly_type) {
                $deposits = bcadd($deposits, $amount, 2);
            } elseif ('withdrawal' === $row->firefly_type) {
                $withdrawals = bcadd($withdrawals, $amount, 2);
            }
        }

        // Net effect: deposits + (-withdrawals)
        return bcsub($deposits, $withdrawals, 2);
    }

    private function getAccountNameForRow(BillStatementRow $row): string
    {
        // For withdrawal, the source account is the asset account
        if ('withdrawal' === $row->firefly_type) {
            return $row->source_name ?? '';
        }

        // For deposit, the destination account is the asset account
        if ('deposit' === $row->firefly_type) {
            return $row->destination_name ?? '';
        }

        return '';
    }

    /**
     * Steam::finalAccountBalance returns balances keyed by currency code, plus
     * a native 'balance' key that is only populated when the account has an
     * explicit currency and primary-conversion context. Read the account's own
     * currency-code entry first (that is the statement's currency), and fall
     * back to the native 'balance' key.
     *
     * @param array<string, string> $balances
     */
    private function extractBalance(User $user, Account $account, array $balances): string
    {
        $repository = app(\FireflyIII\Repositories\Account\AccountRepositoryInterface::class);
        $repository->setUser($user);
        $currencyCode = $repository->getAccountCurrency($account)?->code;

        // Prefer the account's own currency balance.
        if (null !== $currencyCode && isset($balances[$currencyCode]) && '' !== (string) $balances[$currencyCode]) {
            return (string) $balances[$currencyCode];
        }

        // Then the native 'balance' key, when it carries a non-zero amount.
        $native = (string) ($balances['balance'] ?? '0');
        if (bccomp($native, '0', 12) !== 0) {
            return $native;
        }

        // Fallback: sum the per-currency-code entries. For a single-currency
        // account (all bill sources are CNY) this is exactly the balance, and
        // it stays correct even when the account has no explicit currency meta.
        $sum = '0';
        foreach ($balances as $key => $value) {
            if (in_array($key, ['balance', 'pc_balance', 'native_balance'], true)) {
                continue;
            }
            $sum = bcadd($sum, (string) $value, 12);
        }

        return $sum;
    }

    private function hasStatementBalance(BillStatementRow $row): bool
    {
        $metadata = $row->metadata;
        if (!is_array($metadata)) {
            return false;
        }

        $balance = $metadata['balance'] ?? null;

        return is_string($balance) && '' !== $balance;
    }

    private function getStatementBalance(BillStatementRow $row): ?string
    {
        $metadata = $row->metadata;
        if (!is_array($metadata)) {
            return null;
        }

        $balance = $metadata['balance'] ?? null;

        return is_string($balance) && '' !== $balance ? $balance : null;
    }

    private function floatToStr(float $value): string
    {
        return number_format($value, 2, '.', '');
    }
}
