<?php

declare(strict_types=1);

namespace FireflyIII\Console\Commands\BillIngestion;

use FireflyIII\Console\Commands\ShowsFriendlyMessages;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillStatementRowDismissalService;
use FireflyIII\Services\BillIngestion\BillStatementRowImportService;
use FireflyIII\User;
use Illuminate\Console\Command;

/**
 * 「划掉」上线前攒下的存量，一次性归位。
 *
 * dismissed 这个终态是后加的，在它之前，机器判出来的重复、0 元流水、归档任务名下
 * 的遗留行，全都以 pending 挂着，一起算进待办。新解析的行现在会自动落到正确的
 * 状态，但历史数据不会自己改，所以跑这一遍。
 *
 * 只碰 pending 的行——已入账、已划掉、人动过的都不动。跑第二遍是安全的。
 */
class CleansBillStatementRows extends Command
{
    use ShowsFriendlyMessages;

    protected $description = '把存量账单流水里的重复行、0 元行、归档任务遗留行划掉，并重跑任务完成判定。';

    protected $signature   = 'bill-inbox:cleanup-rows {--user= : 只处理这个用户 id，不给就是全部}';

    public function handle(
        BillStatementRowDismissalService $dismissalService,
        BillStatementRowImportService $importService,
    ): int {
        $userId = $this->option('user');
        $users  = User::query()
            ->when(null !== $userId && '' !== $userId, static fn ($query) => $query->where('id', (int) $userId))
            ->orderBy('id')
            ->get()
        ;

        foreach ($users as $user) {
            $duplicates = $dismissalService->dismissMachineDuplicates($user);
            $zeros      = $dismissalService->dismissZeroAmountRows($user);
            $archived   = $dismissalService->dismissRowsOfArchivedTasks($user);
            $completed  = $this->recheckParsedTasks($user, $importService);

            if (0 === $duplicates + $zeros + $archived + $completed) {
                continue;
            }

            $this->friendlyInfo(sprintf(
                '用户 #%d：划掉重复 %d 条、0 元 %d 条、归档遗留 %d 条，%d 个任务转为已入账。',
                $user->id,
                $duplicates,
                $zeros,
                $archived,
                $completed
            ));
        }

        return 0;
    }

    /**
     * 上面划掉一批之后，有些 parsed 任务名下已经没有待处置的行了，让它们收工。
     */
    private function recheckParsedTasks(User $user, BillStatementRowImportService $importService): int
    {
        $taskIds = BillTask::query()
            ->where('user_id', $user->id)
            ->where('status', 'parsed')
            ->pluck('id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all()
        ;

        $completed = 0;
        foreach ($taskIds as $taskId) {
            $importService->completeTaskWhenNoActionableRowsRemain($user, $taskId);
            $status = BillTask::query()->where('user_id', $user->id)->where('id', $taskId)->value('status');
            if ('imported' === $status) {
                ++$completed;
            }
        }

        return $completed;
    }
}
