<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use Carbon\CarbonInterface;
use FireflyIII\Enums\TransactionTypeEnum;
use FireflyIII\Helpers\Collector\GroupCollectorInterface;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\User;
use Illuminate\Support\Collection;

/**
 * Class CrossSourceDuplicateMatcher.
 *
 * Complements BillStatementRowSummaryService::existingReferences(), which only
 * catches cross-source duplicates that share an order id (platform/merchant
 * order number recorded as internal_reference / external_id on an existing
 * Firefly transaction).
 *
 * The real gap (issue #14) is duplicates WITHOUT a shared order id: e.g. a
 * manual/OCR-entered transaction "招商银行 -> 1点点 -21.00" and an Alipay-email
 * import "招商银行 -> 淘宝闪购 -21.00 (description 1点点)" describe the same
 * purchase but have no common order number, so exact matching misses them and
 * two Firefly transactions get created.
 *
 * This matcher compares a candidate statement row against EXISTING Firefly
 * transactions using loose, multi-field similarity instead of exact time:
 *
 *   - amount: absolute value equal (required);
 *   - asset/payment account: candidate source/destination account name equals
 *     the existing transaction's source or destination account (required);
 *   - time: within a loose window (±24h) of the candidate's date (required);
 *   - merchant/description: candidate merchant terms overlap the existing
 *     transaction's counterparty account name or description (required, either
 *     exact or substring) -- or a candidate order id appears verbatim in the
 *     existing description.
 *
 * The result is ADVISORY only: it surfaces "row N likely matches existing
 * transaction #X, suggest merge/replace/skip" in the review payload. It never
 * auto-skips or auto-imports anything.
 */
final class CrossSourceDuplicateMatcher
{
    /** Loose time window, in hours, on each side of the candidate date. */
    private const int WINDOW_HOURS = 24;

    /** Minimum normalized-text length before substring matching is trusted. */
    private const int MIN_TERM_LENGTH = 2;

    /**
     * @param Collection<int, BillStatementRow> $rows
     *
     * @return array<int, list<array<string,mixed>>> map of row id => matches
     */
    public function matchRows(User $user, Collection $rows): array
    {
        /** @var Collection<int, BillStatementRow> $candidates */
        $candidates = $rows->filter(fn (BillStatementRow $row): bool => $this->isMatchable($row))->values();
        if ($candidates->isEmpty()) {
            return [];
        }

        $dates = $candidates
            ->map(fn (BillStatementRow $row): ?CarbonInterface => $this->rowDate($row))
            ->filter(static fn (?CarbonInterface $date): bool => $date instanceof CarbonInterface)
            ->values()
        ;
        if ($dates->isEmpty()) {
            return [];
        }

        /** @var CarbonInterface $min */
        $min      = $dates->reduce(static fn (?CarbonInterface $carry, CarbonInterface $date): CarbonInterface => null === $carry || $date->lt($carry) ? $date : $carry);
        /** @var CarbonInterface $max */
        $max      = $dates->reduce(static fn (?CarbonInterface $carry, CarbonInterface $date): CarbonInterface => null === $carry || $date->gt($carry) ? $date : $carry);
        $start    = $min->clone()->subHours(self::WINDOW_HOURS);
        $end      = $max->clone()->addHours(self::WINDOW_HOURS);

        $existing = $this->fetchExistingTransactions($user, $start, $end);
        if ([] === $existing) {
            return [];
        }

        $result = [];
        foreach ($candidates as $row) {
            $matches = [];
            foreach ($existing as $journal) {
                $match = $this->score($row, $journal);
                if (null !== $match) {
                    $matches[] = $match;
                }
            }
            if ([] !== $matches) {
                usort($matches, static fn (array $a, array $b): int => self::rank($b['confidence']) <=> self::rank($a['confidence']));
                $result[$row->id] = $matches;
            }
        }

        return $result;
    }

    /**
     * @return array<int, array<string,mixed>>
     */
    private function fetchExistingTransactions(User $user, CarbonInterface $start, CarbonInterface $end): array
    {
        /** @var GroupCollectorInterface $collector */
        $collector = app(GroupCollectorInterface::class);
        $collector
            ->setUser($user)
            ->withAccountInformation()
            ->setRange(Carbon::instance($start), Carbon::instance($end))
            ->setTypes([
                TransactionTypeEnum::WITHDRAWAL->value,
                TransactionTypeEnum::DEPOSIT->value,
                TransactionTypeEnum::TRANSFER->value,
            ])
        ;

        return $collector->getExtractedJournals();
    }

    /**
     * @param array<string,mixed> $journal
     *
     * @return null|array<string,mixed>
     */
    private function score(BillStatementRow $row, array $journal): ?array
    {
        $rowAmount      = $this->amountKey($row->firefly_amount ?? $row->amount);
        $journalAmount  = $this->amountKey($journal['amount'] ?? null);
        if ('' === $rowAmount || $rowAmount !== $journalAmount) {
            return null;
        }

        $rowDate = $this->rowDate($row);
        $txDate  = $journal['date'] ?? null;
        if (!$rowDate instanceof CarbonInterface || !$txDate instanceof CarbonInterface) {
            return null;
        }
        $hoursApart = abs($rowDate->diffInHours($txDate, false));
        if ($hoursApart > self::WINDOW_HOURS) {
            return null;
        }
        $sameDay = $rowDate->clone()->setTimezone('Asia/Shanghai')->isSameDay($txDate->clone()->setTimezone('Asia/Shanghai'));

        if (!$this->accountMatches($row, $journal)) {
            return null;
        }

        $matchedOn = ['amount', 'account'];
        $matchedOn[] = $sameDay ? 'same_day' : 'within_24h';

        $orderId       = $this->orderIdMatch($row, $journal);
        $merchantLevel = $this->merchantMatch($row, $journal);

        $match = match (true) {
            $orderId                                => ['order_id', 'high'],
            'exact' === $merchantLevel && $sameDay => ['merchant_exact', 'high'],
            'exact' === $merchantLevel             => ['merchant_exact', 'medium'],
            'substring' === $merchantLevel         => ['merchant_similar', 'medium'],
            default                                => null,
        };
        if (null === $match) {
            // amount + account + time only, no merchant/order overlap: too weak
            // to claim a cross-source duplicate without risking false positives.
            return null;
        }
        [$matchedField, $confidence] = $match;
        $matchedOn[]                 = $matchedField;

        return [
            'transaction_group_id'   => (string) ($journal['transaction_group_id'] ?? ''),
            'transaction_journal_id' => (string) ($journal['transaction_journal_id'] ?? ''),
            'confidence'             => $confidence,
            'matched_on'             => $matchedOn,
            'suggestion'             => 'high' === $confidence ? 'skip' : 'review',
            'existing'               => [
                'description'      => (string) ($journal['description'] ?? ''),
                'date'             => $txDate->clone()->setTimezone('Asia/Shanghai')->toAtomString(),
                'amount'           => $journalAmount,
                'source_name'      => (string) ($journal['source_account_name'] ?? ''),
                'destination_name' => (string) ($journal['destination_account_name'] ?? ''),
            ],
        ];
    }

    /**
     * The candidate's paying/asset account must line up with one side of the
     * existing transaction.
     *
     * @param array<string,mixed> $journal
     */
    private function accountMatches(BillStatementRow $row, array $journal): bool
    {
        $rowAccounts = array_filter([
            $this->normalText($row->source_name),
            $this->normalText($row->destination_name),
        ], static fn (string $value): bool => '' !== $value);
        if ([] === $rowAccounts) {
            return false;
        }

        $txAccounts = array_filter([
            $this->normalText($journal['source_account_name'] ?? null),
            $this->normalText($journal['destination_account_name'] ?? null),
        ], static fn (string $value): bool => '' !== $value);

        foreach ($rowAccounts as $rowAccount) {
            if (in_array($rowAccount, $txAccounts, true)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param array<string,mixed> $journal
     *
     * @return ''|'exact'|'substring'
     */
    private function merchantMatch(BillStatementRow $row, array $journal): string
    {
        $rowTerms = $this->uniqueTerms([
            $row->destination_name,
            $row->counterparty,
            $row->firefly_description,
            $row->description,
        ]);
        $txTerms = $this->uniqueTerms([
            $journal['destination_account_name'] ?? null,
            $journal['description'] ?? null,
        ]);
        if ([] === $rowTerms || [] === $txTerms) {
            return '';
        }

        foreach ($rowTerms as $rowTerm) {
            foreach ($txTerms as $txTerm) {
                if ($rowTerm === $txTerm) {
                    return 'exact';
                }
            }
        }
        foreach ($rowTerms as $rowTerm) {
            foreach ($txTerms as $txTerm) {
                if (mb_strlen($rowTerm) >= self::MIN_TERM_LENGTH && mb_strlen($txTerm) >= self::MIN_TERM_LENGTH
                    && (str_contains($rowTerm, $txTerm) || str_contains($txTerm, $rowTerm))) {
                    return 'substring';
                }
            }
        }

        return '';
    }

    /**
     * @param array<string,mixed> $journal
     */
    private function orderIdMatch(BillStatementRow $row, array $journal): bool
    {
        $description = (string) ($journal['description'] ?? '');
        if ('' === $description) {
            return false;
        }
        foreach ([$row->platform_order_no, $row->merchant_order_no] as $orderNo) {
            $clean = $this->cleanScalar($orderNo);
            if ('' !== $clean && mb_strlen($clean) >= 6 && str_contains($description, $clean)) {
                return true;
            }
        }

        return false;
    }

    private function isMatchable(BillStatementRow $row): bool
    {
        if (null !== $row->transaction_group_id) {
            return false;
        }
        if (null === $row->firefly_type || '' === (string) $row->firefly_type) {
            return false;
        }

        return '' !== $this->amountKey($row->firefly_amount ?? $row->amount);
    }

    private function rowDate(BillStatementRow $row): ?CarbonInterface
    {
        $date = $row->firefly_date ?? $row->occurred_at;

        return $date instanceof CarbonInterface ? $date : null;
    }

    /**
     * @param list<mixed> $values
     *
     * @return list<string>
     */
    private function uniqueTerms(array $values): array
    {
        $terms = [];
        foreach ($values as $value) {
            $normal = $this->normalText($value);
            if ('' !== $normal && !in_array($normal, $terms, true)) {
                $terms[] = $normal;
            }
        }

        return $terms;
    }

    public function amountKey(mixed $value): string
    {
        if (null === $value || '' === trim((string) $value)) {
            return '';
        }

        return number_format(abs((float) $value), 2, '.', '');
    }

    private function cleanScalar(mixed $value): string
    {
        if (null === $value) {
            return '';
        }
        $text = trim((string) $value);

        return in_array($text, ['/', '-', '--'], true) ? '' : $text;
    }

    private function normalText(mixed $value): string
    {
        $text = mb_strtolower($this->cleanScalar($value));

        return trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
    }

    private static function rank(string $confidence): int
    {
        return match ($confidence) {
            'high'   => 2,
            'medium' => 1,
            default  => 0,
        };
    }
}
