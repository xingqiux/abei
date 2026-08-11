<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\CarbonInterface;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\DB;

final class CrossChannelPairingService
{
    private const int WINDOW_HOURS = 48;

    private const array BANK_ALIASES = [
        'cmb' => ['招商银行', '招行', 'cmbchina'],
        'boc' => ['中国银行', '中行', 'bank of china'],
    ];

    private const array WALLET_ALIASES = [
        'wechat' => ['财付通', '微信', 'wechat', 'weixin'],
        'alipay' => ['支付宝', 'zhifubao', 'alipay'],
    ];

    public function __construct(private readonly CrossSourceDuplicateMatcher $amountMatcher) {}

    public function pairTaskRows(BillTask $task): void
    {
        $this->pairOpenRows($task->user, $task->id);
    }

    public function pairOpenRows(User $user, ?int $taskId = null): void
    {
        /** @var Collection<int,BillStatementRow> $rows */
        $rows = BillStatementRow::query()
            ->where('user_id', $user->id)
            ->whereIn('review_state', ['pending_book', 'pending_confirm', 'booked'])
            ->with('billTask')
            ->orderBy('occurred_at')
            ->orderBy('id')
            ->get();

        // ponytail: 全量重分类按用户做内存配对；单用户未处理行明显增长时改成按金额和时间分批查询。
        $targets = null === $taskId ? $rows : $rows->where('bill_task_id', $taskId);
        foreach ($targets as $row) {
            if (null !== $row->event_group_id || 'booked' === $row->review_state) {
                continue;
            }

            $matches = $rows
                ->filter(fn (BillStatementRow $candidate): bool => $this->isCandidate($row, $candidate))
                ->map(fn (BillStatementRow $candidate): array => [
                    'row' => $candidate,
                    'evidence' => $this->evidence($row, $candidate),
                    'hours' => $this->hoursApart($row, $candidate),
                ])
                ->filter(static fn (array $match): bool => 'none' !== $match['evidence'])
                ->sortBy(static fn (array $match): string => ('strong' === $match['evidence'] ? '0' : '1').sprintf('%08.3f', $match['hours']))
                ->values();

            if ($matches->isNotEmpty()) {
                $match = $matches->first();
                $this->pair($row, $match['row'], $match['evidence']);
                continue;
            }

            $this->suggestSingleRowTransfer($row);
        }
    }

    public function rejectTransfer(BillStatementRow $row): void
    {
        DB::transaction(function () use ($row): void {
            foreach ($this->groupRows($row) as $member) {
                if ('booked' === $member->review_state) {
                    continue;
                }
                $this->restoreOriginal($member);
                $this->setPendingBook($member);
                $member->event_group_id = null;
                $member->save();
            }
        });
    }

    public function resolveDuplicate(BillStatementRow $row, bool $merge): void
    {
        DB::transaction(function () use ($row, $merge): void {
            $members = $this->groupRows($row);
            if (!$merge) {
                foreach ($members as $member) {
                    if ('booked' !== $member->review_state) {
                        $this->restoreOriginal($member);
                        $this->setPendingBook($member);
                    }
                    $member->event_group_id = null;
                    $member->save();
                }

                return;
            }

            $booked = $members->firstWhere('review_state', 'booked');
            if ($booked instanceof BillStatementRow) {
                foreach ($members as $member) {
                    if ((int) $member->id !== (int) $booked->id) {
                        $this->exclude($member, 'superseded_by_booked');
                    }
                }

                return;
            }

            $main = $members->first(fn (BillStatementRow $member): bool => 'main' === ($this->pairingMetadata($member)['role'] ?? null)) ?? $row;
            $this->setPendingBook($main);
            $main->save();
            foreach ($members as $member) {
                if ((int) $member->id !== (int) $main->id) {
                    $this->exclude($member, 'merged_duplicate');
                }
            }
        });
    }

    public function excludeOtherObservationsAfterBooking(BillStatementRow $booked): void
    {
        if (null === $booked->event_group_id) {
            return;
        }
        foreach ($this->groupRows($booked) as $member) {
            if ((int) $member->id !== (int) $booked->id && in_array($member->review_state, ['pending_book', 'pending_confirm'], true)) {
                $this->exclude($member, 'superseded_by_booked');
            }
        }
    }

    private function pair(BillStatementRow $left, BillStatementRow $right, string $evidence): void
    {
        DB::transaction(function () use ($left, $right, $evidence): void {
            $groupId = (string) Str::uuid();
            [$wallet, $bank] = $this->walletAndBank($left, $right);
            $this->rememberOriginal($left, 'secondary', $evidence);
            $this->rememberOriginal($right, 'secondary', $evidence);
            $left->event_group_id = $groupId;
            $right->event_group_id = $groupId;

            if ('booked' === $left->review_state || 'booked' === $right->review_state) {
                $booked = 'booked' === $left->review_state ? $left : $right;
                $open = (int) $booked->id === (int) $left->id ? $right : $left;
                $this->rememberOriginal($open, 'main', $evidence);
                $this->setPendingConfirm($open, 'duplicate');
                $booked->save();
                $open->save();

                return;
            }

            if ($this->directionType($left) !== $this->directionType($right)) {
                $outflow = 'withdrawal' === $this->directionType($left) ? $left : $right;
                $inflow = (int) $outflow->id === (int) $left->id ? $right : $left;
                $this->rememberOriginal($outflow, 'main', $evidence);
                $outflow->firefly_type = 'transfer';
                $outflow->source_name = $this->assetAccount($outflow);
                $outflow->destination_name = $this->assetAccount($inflow);
                $this->setPendingConfirm($outflow, 'transfer');
                $this->exclude($inflow, 'merged_duplicate', false);
                $outflow->save();
                $inflow->save();

                return;
            }

            $this->rememberOriginal($wallet, 'main', $evidence);
            $wallet->payment_method = $this->walletPaymentMethod($wallet);
            if ('withdrawal' === $this->directionType($wallet)) {
                $wallet->source_name = $this->assetAccount($bank);
            } else {
                $wallet->destination_name = $this->assetAccount($bank);
            }

            if ('strong' === $evidence) {
                $this->setPendingBook($wallet);
                $this->exclude($bank, 'merged_duplicate', false);
            } else {
                $this->setPendingConfirm($wallet, 'duplicate');
                $this->setPendingBook($bank);
            }
            $wallet->save();
            $bank->save();
        });
    }

    private function suggestSingleRowTransfer(BillStatementRow $row): void
    {
        $source = (string) $row->billTask->source;
        if (!array_key_exists($source, self::WALLET_ALIASES)) {
            return;
        }
        $text = $this->rowText($row);
        $bankSource = array_key_first(array_filter(self::BANK_ALIASES, fn (array $aliases): bool => $this->containsAny($text, $aliases)));
        $walletAccount = 'wechat' === $source ? '微信零钱' : '支付宝';
        $bankAccount = null === $bankSource ? null : $this->bankName($bankSource, $text);

        [$from, $to] = match (true) {
            str_contains($text, '零钱通转入') => ['微信零钱', '零钱通'],
            str_contains($text, '零钱通转出') => ['零钱通', '微信零钱'],
            str_contains($text, '余额宝') && str_contains($text, '转出') => ['余额宝', $bankAccount ?? '支付宝'],
            str_contains($text, '余额宝') && str_contains($text, '转入') => [$bankAccount ?? '支付宝', '余额宝'],
            null !== $bankAccount && str_contains($text, '提现') => [$walletAccount, $bankAccount],
            default => [null, null],
        };
        if (null === $from || null === $to) {
            return;
        }

        $this->rememberOriginal($row, 'main', 'single');
        $row->event_group_id = (string) Str::uuid();
        $row->firefly_type = 'transfer';
        $row->source_name = $from;
        $row->destination_name = $to;
        $this->setPendingConfirm($row, 'transfer');
        $row->save();
    }

    private function isCandidate(BillStatementRow $row, BillStatementRow $candidate): bool
    {
        if ((int) $row->id === (int) $candidate->id || null !== $candidate->event_group_id) {
            return false;
        }
        $sources = [(string) $row->billTask->source, (string) $candidate->billTask->source];
        if ($sources[0] === $sources[1] || null === $this->walletAndBankOrNull($row, $candidate)) {
            return false;
        }
        if ($this->amountMatcher->amountKey($row->firefly_amount ?? $row->amount) !== $this->amountMatcher->amountKey($candidate->firefly_amount ?? $candidate->amount)) {
            return false;
        }

        return $this->hoursApart($row, $candidate) <= self::WINDOW_HOURS;
    }

    private function evidence(BillStatementRow $left, BillStatementRow $right): string
    {
        [$wallet, $bank] = $this->walletAndBank($left, $right);
        $walletSource = (string) $wallet->billTask->source;
        $bankSource = (string) $bank->billTask->source;
        $walletPointsBank = $this->containsAny($this->rowText($wallet), self::BANK_ALIASES[$bankSource]);
        $bankPointsWallet = $this->containsAny($this->rowText($bank), self::WALLET_ALIASES[$walletSource]);
        $cardMatches = [] !== array_intersect($this->cardSuffixes($wallet), $this->cardSuffixes($bank));

        return match (true) {
            ($walletPointsBank && $bankPointsWallet) || $cardMatches => 'strong',
            $walletPointsBank || $bankPointsWallet => 'weak',
            default => 'none',
        };
    }

    /** @return array{BillStatementRow,BillStatementRow} */
    private function walletAndBank(BillStatementRow $left, BillStatementRow $right): array
    {
        return $this->walletAndBankOrNull($left, $right) ?? throw new \LogicException('配对行必须分别来自钱包和银行渠道。');
    }

    /** @return null|array{BillStatementRow,BillStatementRow} */
    private function walletAndBankOrNull(BillStatementRow $left, BillStatementRow $right): ?array
    {
        $leftSource = (string) $left->billTask->source;
        $rightSource = (string) $right->billTask->source;
        if (isset(self::WALLET_ALIASES[$leftSource], self::BANK_ALIASES[$rightSource])) {
            return [$left, $right];
        }
        if (isset(self::WALLET_ALIASES[$rightSource], self::BANK_ALIASES[$leftSource])) {
            return [$right, $left];
        }

        return null;
    }

    private function hoursApart(BillStatementRow $left, BillStatementRow $right): float
    {
        $leftDate = $left->occurred_at;
        $rightDate = $right->occurred_at;
        if (!$leftDate instanceof CarbonInterface || !$rightDate instanceof CarbonInterface) {
            return INF;
        }

        return abs($leftDate->diffInHours($rightDate, false));
    }

    private function rowText(BillStatementRow $row): string
    {
        return mb_strtolower(implode(' ', array_filter([
            $row->payment_method,
            $row->counterparty_account,
            $row->counterparty,
            $row->description,
            $row->platform_category,
            $row->source_name,
            $row->destination_name,
        ], static fn ($value): bool => is_string($value) && '' !== trim($value))));
    }

    private function containsAny(string $text, array $aliases): bool
    {
        foreach ($aliases as $alias) {
            if (str_contains($text, mb_strtolower($alias))) {
                return true;
            }
        }

        return false;
    }

    /** @return list<string> */
    private function cardSuffixes(BillStatementRow $row): array
    {
        preg_match_all('/(?:尾号|尾数|储蓄卡|信用卡|卡号|账号|卡|\()[^\d]{0,4}(\d{4})/u', $this->rowText($row), $matches);

        return array_values(array_unique($matches[1] ?? []));
    }

    private function directionType(BillStatementRow $row): string
    {
        return match (true) {
            in_array($row->firefly_type, ['withdrawal', 'deposit'], true) => (string) $row->firefly_type,
            '收入' === $row->direction => 'deposit',
            default => 'withdrawal',
        };
    }

    private function assetAccount(BillStatementRow $row): string
    {
        $value = 'deposit' === $this->directionType($row) ? $row->destination_name : $row->source_name;

        return trim((string) $value);
    }

    private function walletPaymentMethod(BillStatementRow $wallet): string
    {
        $name = 'wechat' === $wallet->billTask->source ? '微信' : '支付宝';
        $method = trim((string) $wallet->payment_method);

        return str_contains($method, $name) ? $method : trim($name.' / '.$method, ' /');
    }

    private function bankName(string $source, string $text): string
    {
        $base = 'cmb' === $source ? '招商银行' : '中国银行';
        preg_match('/(?:尾号|尾数|储蓄卡|信用卡|卡号|账号|卡|\()[^\d]{0,4}(\d{4})/u', $text, $match);

        return isset($match[1]) ? sprintf('%s储蓄卡(%s)', $base, $match[1]) : $base;
    }

    private function rememberOriginal(BillStatementRow $row, string $role, string $evidence): void
    {
        $metadata = is_array($row->metadata) ? $row->metadata : [];
        $pairing = is_array($metadata['cross_channel_pairing'] ?? null) ? $metadata['cross_channel_pairing'] : [];
        $pairing['original'] ??= [
            'firefly_type' => $row->firefly_type,
            'source_name' => $row->source_name,
            'destination_name' => $row->destination_name,
            'payment_method' => $row->payment_method,
        ];
        $pairing['role'] = $role;
        $pairing['evidence'] = $evidence;
        $metadata['cross_channel_pairing'] = $pairing;
        $row->metadata = $metadata;
    }

    private function restoreOriginal(BillStatementRow $row): void
    {
        $original = $this->pairingMetadata($row)['original'] ?? [];
        $fallbackType = '收入' === $row->direction ? 'deposit' : 'withdrawal';
        $row->firefly_type = $original['firefly_type'] ?? $fallbackType;
        $row->source_name = $original['source_name'] ?? ('deposit' === $fallbackType ? $row->counterparty : $row->payment_method);
        $row->destination_name = $original['destination_name'] ?? ('deposit' === $fallbackType ? $row->payment_method : $row->counterparty);
        $row->payment_method = $original['payment_method'] ?? $row->payment_method;
    }

    /** @return array<string,mixed> */
    private function pairingMetadata(BillStatementRow $row): array
    {
        $metadata = is_array($row->metadata) ? $row->metadata : [];

        return is_array($metadata['cross_channel_pairing'] ?? null) ? $metadata['cross_channel_pairing'] : [];
    }

    /** @return Collection<int,BillStatementRow> */
    private function groupRows(BillStatementRow $row): Collection
    {
        if (null === $row->event_group_id) {
            return collect([$row]);
        }

        return BillStatementRow::query()
            ->where('user_id', $row->user_id)
            ->where('event_group_id', $row->event_group_id)
            ->orderBy('id')
            ->get();
    }

    private function setPendingBook(BillStatementRow $row): void
    {
        $row->review_state = 'pending_book';
        $row->confirm_reason = null;
        $row->excluded_reason = null;
        $row->status = 'pending';
        $row->dismissed_reason = null;
        $row->dismissed_at = null;
    }

    private function setPendingConfirm(BillStatementRow $row, string $reason): void
    {
        $this->setPendingBook($row);
        $row->review_state = 'pending_confirm';
        $row->confirm_reason = $reason;
    }

    private function exclude(BillStatementRow $row, string $reason, bool $save = true): void
    {
        $row->review_state = 'excluded';
        $row->confirm_reason = null;
        $row->excluded_reason = $reason;
        $row->status = 'dismissed';
        $row->dismissed_reason = 'merged_duplicate' === $reason
            ? BillStatementRowDismissalService::REASON_DUPLICATE_AUTO
            : $reason;
        $row->dismissed_at = now('Asia/Shanghai');
        if ($save) {
            $row->save();
        }
    }
}
