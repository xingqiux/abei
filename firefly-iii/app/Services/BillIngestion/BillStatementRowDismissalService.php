<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Casts\BillStatementLocalDateTimeCast;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\User;

/**
 * 「划掉」一条流水的唯一入口。
 *
 * 划掉有四个来源（0 元自动、机器判重、归档级联、人工），每一处都得写同样的三件事：
 * status、dismissed_reason、dismissed_at。散在五个渠道的 ImportService、
 * BillTaskActionService、控制器里各写一遍，迟早漏掉其中一件，行就卡在
 * 「status 是 dismissed 但没人知道为什么」的状态。所以集中到这里。
 */
class BillStatementRowDismissalService
{
    /** 机器判重批量划掉。判错了可以整批恢复。 */
    public const string REASON_DUPLICATE_AUTO = 'duplicate_auto';

    /** 解析时金额就是 0，入账没有意义。 */
    public const string REASON_ZERO_AMOUNT    = 'zero_amount';

    /** 所属任务被归档，名下没处置完的行跟着走。 */
    public const string REASON_TASK_ARCHIVED  = 'task_archived';

    /** 人在界面上按的「划掉」。不许被任何自动流程覆盖或回滚。 */
    public const string REASON_USER           = 'user';

    /**
     * 建行时的统一判定：解析出来金额就是 0 的行，直接建成 dismissed。
     *
     * 挂在 BillStatementRowIdentityService::upsertRow 的建行路径上，
     * 五个渠道的 ImportService 都从那一个口进来，不必各自判一遍。
     *
     * @param array<string,mixed> $attributes
     *
     * @return array<string,mixed>
     */
    public function applyInitialRules(array $attributes): array
    {
        if (!$this->isZeroAmount($attributes['amount'] ?? null, $attributes['firefly_amount'] ?? null)) {
            return $attributes;
        }

        $attributes['status']           = 'dismissed';
        $attributes['dismissed_reason'] = self::REASON_ZERO_AMOUNT;
        $attributes['dismissed_at']     = Carbon::now(BillStatementLocalDateTimeCast::DEFAULT_TIMEZONE);

        return $attributes;
    }

    /**
     * 金额栏空着不算 0——那是「没解析出来」，得让人看见，不能悄悄划掉。
     */
    public function isZeroAmount(mixed $amount, mixed $fireflyAmount = null): bool
    {
        $value = $this->firstNumeric($amount, $fireflyAmount);
        if (null === $value) {
            return false;
        }

        return 0 === bccomp($value, '0', 12);
    }

    /**
     * 按 id 划掉。只动 pending 的行：已入账的不能撤、已划掉的不必重划。
     *
     * @param array<int,int> $rowIds
     */
    public function dismissRowIds(User $user, array $rowIds, string $reason): int
    {
        if ([] === $rowIds) {
            return 0;
        }

        return $this->dismissQuery(
            BillStatementRow::query()->where('user_id', $user->id)->whereIn('id', $rowIds),
            $reason
        );
    }

    /**
     * 机器判出来是重复的那批（pending + duplicate）。
     */
    public function dismissMachineDuplicates(User $user): int
    {
        return $this->dismissQuery(
            BillStatementRow::query()->where('user_id', $user->id)->where('duplicate_state', 'duplicate'),
            self::REASON_DUPLICATE_AUTO
        );
    }

    /**
     * 归档级联：任务归档时名下 pending 行一起划掉。
     *
     * 不这么做的话任务从列表里消失了，行还留在跨任务的待办计数里，
     * 界面上看得见数字却点不进去。
     */
    public function dismissPendingRowsForTask(BillTask $billTask, string $reason = self::REASON_TASK_ARCHIVED): int
    {
        return $this->dismissQuery($billTask->statementRows(), $reason);
    }

    /**
     * 金额为 0 的存量 pending 行。
     *
     * 新解析的行在 applyInitialRules 里就划掉了，这个只给一次性清理用——
     * 规则上线前攒下来的那批还挂着。
     */
    public function dismissZeroAmountRows(User $user): int
    {
        return $this->dismissQuery(
            BillStatementRow::query()
                ->where('user_id', $user->id)
                ->where(static function ($query): void {
                    $query->where('amount', 0)
                        ->orWhere(static function ($fallback): void {
                            // 金额栏没解析出来、但 firefly_amount 落成了 0 的，一样是 0 元。
                            $fallback->whereNull('amount')->where('firefly_amount', 0);
                        });
                }),
            self::REASON_ZERO_AMOUNT
        );
    }

    /**
     * 已归档任务名下的存量 pending 行。归档级联上线前留下的那批。
     */
    public function dismissRowsOfArchivedTasks(User $user): int
    {
        return $this->dismissQuery(
            BillStatementRow::query()
                ->where('user_id', $user->id)
                ->whereHas('billTask', static fn ($task) => $task->where('status', 'cleaned')),
            self::REASON_TASK_ARCHIVED
        );
    }

    /**
     * 恢复：dismissed 回 pending，清掉划掉的痕迹。
     *
     * @param array<int,int> $rowIds
     */
    public function restoreRowIds(User $user, array $rowIds): int
    {
        if ([] === $rowIds) {
            return 0;
        }

        return BillStatementRow::query()
            ->where('user_id', $user->id)
            ->whereIn('id', $rowIds)
            ->where('status', 'dismissed')
            ->update([
                'status'           => 'pending',
                'dismissed_reason' => null,
                'dismissed_at'     => null,
                'updated_at'       => Carbon::now(),
            ])
        ;
    }

    /**
     * @param \Illuminate\Contracts\Database\Query\Builder|\Illuminate\Database\Eloquent\Builder|\Illuminate\Database\Eloquent\Relations\Relation $query
     */
    private function dismissQuery(mixed $query, string $reason): int
    {
        return $query
            ->where('status', 'pending')
            ->update([
                'status'           => 'dismissed',
                'dismissed_reason' => $reason,
                // 批量 update 走查询构造器，绕开模型的 BillStatementLocalDateTimeCast，
                // 所以这里得自己把墙上时钟写成字符串。时区取 cast 认的那一个，不是字面量：
                // 两边一旦不一致，写进去的行读出来就是另一个时刻，还不会报错。
                'dismissed_at'     => Carbon::now(BillStatementLocalDateTimeCast::DEFAULT_TIMEZONE)->format('Y-m-d H:i:s'),
                'updated_at'       => Carbon::now(),
            ])
        ;
    }

    private function firstNumeric(mixed ...$values): ?string
    {
        foreach ($values as $value) {
            if (null === $value) {
                continue;
            }
            $text = trim((string) $value);
            if ('' === $text || !is_numeric($text)) {
                continue;
            }

            return $text;
        }

        return null;
    }
}
