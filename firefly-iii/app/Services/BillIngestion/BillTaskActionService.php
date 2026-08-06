<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillSecretChallenge;
use FireflyIII\Models\BillTask;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

class BillTaskActionService
{
    /**
     * 同一个挑战最多能试几次密码。用完就把挑战关掉、任务转 failed，
     * 只能走 retry 让任务重新排队（那会生成一个新的挑战）。
     */
    public const int MAX_SECRET_ATTEMPTS = 5;

    public function __construct(
        private readonly BillTaskProcessor $taskProcessor,
        private readonly BillSourceChannelRegistry $channelRegistry,
    ) {}

    public function ignore(BillTask $billTask): BillTask
    {
        $billTask->status                      = 'ignored';
        $billTask->error_code                  = null;
        $billTask->error_message               = null;
        $billTask->current_secret_challenge_id = null;
        $billTask->save();

        $this->appendEvent($billTask, 'task.ignored', '任务已忽略');

        return $billTask->refresh();
    }

    public function archive(BillTask $billTask): BillTask
    {
        $metadata                      = is_array($billTask->metadata) ? $billTask->metadata : [];
        $metadata['archived_by_user']   = true;
        $metadata['archived_at']        = Carbon::now()->toAtomString();
        $billTask->status              = 'cleaned';
        $billTask->error_code          = null;
        $billTask->error_message       = null;
        $billTask->metadata            = $metadata;
        $billTask->save();

        $this->appendEvent($billTask, 'task.archived', '账单任务已归档');

        return $billTask->refresh();
    }

    /**
     * @param array<int,int> $taskIds
     */
    public function archiveMany(User $user, array $taskIds): int
    {
        $tasks = BillTask::query()
            ->where('user_id', $user->id)
            ->whereIn('id', $taskIds)
            ->get()
        ;

        foreach ($tasks as $task) {
            $this->archive($task);
        }

        return $tasks->count();
    }

    public function retry(BillTask $billTask): BillTask
    {
        $billTask->status        = 'received';
        $billTask->error_code    = null;
        $billTask->error_message = null;
        $billTask->save();

        $this->appendEvent($billTask, 'task.retry_requested', '任务已重新排队');

        return $billTask->refresh();
    }

    public function cleanupStale(User $user): int
    {
        $tasks = BillTask::query()
            ->where('user_id', $user->id)
            ->where('status', 'needs_secret')
            ->get()
        ;

        foreach ($tasks as $task) {
            $this->archive($task);
        }

        return $tasks->count();
    }

    public function submitSecret(BillTask $billTask, #[\SensitiveParameter] string $secret): BillTask
    {
        if ('' === trim($secret)) {
            throw new RuntimeException('Secret value must not be blank.');
        }

        $challenge = $billTask->currentSecretChallenge;
        if (null === $challenge || 'open' !== $challenge->status) {
            throw new RuntimeException('This bill task has no open secret challenge.');
        }
        if ($challenge->attempts >= self::MAX_SECRET_ATTEMPTS) {
            $message = $this->attemptsMessage($challenge, '密码尝试次数已用完。');
            $this->rejectSecret($billTask, $challenge, $message);

            throw new RuntimeException($message);
        }

        // 这次尝试单独提交一遍。下面解压失败会回滚它自己那个事务，
        // 计数要是还留在同一个事务里就会跟着没掉，试几次都停在 0。
        DB::transaction(function () use ($billTask, $challenge): void {
            ++$challenge->attempts;
            $challenge->save();

            // process() 只认 ready 的任务，状态得先改。但挑战先不动——
            // 密码对不对，要等解压跑完才知道。
            $billTask->status        = 'ready';
            $billTask->error_code    = null;
            $billTask->error_message = null;
            $billTask->save();

            $this->appendEvent($billTask, 'task.ready', '任务已准备处理');
        });

        try {
            $processed = false === $this->shouldProcessAfterSecret($billTask)
                || $this->taskProcessor->process($billTask, $secret);
        } catch (Throwable $e) {
            // 解压这一步抛异常，绝大多数时候就是密码不对。原样把话传回去，
            // 别自己改写成「密码错误」——万一是别的毛病就成了误导。
            $message = $this->attemptsMessage($challenge, $e->getMessage());
            $this->rejectSecret($billTask, $challenge, $message);

            throw new RuntimeException($message, 0, $e);
        }

        if (false === $processed) {
            $billTask->refresh();
            $message = $this->attemptsMessage($challenge, $billTask->error_message ?? '账单处理失败。');
            $this->rejectSecret($billTask, $challenge, $message);

            throw new RuntimeException($message);
        }

        $this->consumeSecret($billTask, $challenge);

        return $billTask->refresh();
    }

    /**
     * 密码验过了才算用掉挑战，任务这时才和它脱钩。
     */
    private function consumeSecret(BillTask $billTask, BillSecretChallenge $challenge): void
    {
        DB::transaction(function () use ($billTask, $challenge): void {
            $challenge->status      = 'consumed';
            $challenge->consumed_at = Carbon::now();
            $challenge->save();

            $billTask->refresh();
            $billTask->current_secret_challenge_id = null;
            $billTask->save();

            $this->appendEvent($billTask, 'challenge.consumed', '验证码/密码已通过');
        });
    }

    /**
     * 密码没过：任务退回等密码那一步，挑战继续开着，用户可以再填一次。
     * 次数用完了才关掉挑战、把任务标成 failed。
     */
    private function rejectSecret(BillTask $billTask, BillSecretChallenge $challenge, string $message): void
    {
        $exhausted = $challenge->attempts >= self::MAX_SECRET_ATTEMPTS;

        DB::transaction(function () use ($billTask, $challenge, $message, $exhausted): void {
            // 处理途中 channel 可能已经往这个模型上写了半截东西（状态、metadata），
            // 它那个事务回滚了但内存里还留着，不 refresh 就会被下面的 save 写回去。
            $billTask->refresh();
            $billTask->status        = $exhausted ? 'failed' : 'needs_secret';
            $billTask->error_code    = $exhausted ? 'secret_exhausted' : 'secret_rejected';
            $billTask->error_message = $message;

            if ($exhausted) {
                $challenge->status                     = 'exhausted';
                $challenge->consumed_at                = Carbon::now();
                $challenge->save();
                $billTask->current_secret_challenge_id = null;
            }
            $billTask->save();

            $this->appendEvent(
                $billTask,
                $exhausted ? 'challenge.exhausted' : 'challenge.rejected',
                $exhausted ? '密码尝试次数已用完' : '密码或验证码未通过',
            );
        });
    }

    private function attemptsMessage(BillSecretChallenge $challenge, string $reason): string
    {
        $left = self::MAX_SECRET_ATTEMPTS - $challenge->attempts;
        if ($left <= 0) {
            return sprintf('%s（已连续失败 %d 次，请重试任务重新获取账单）', $reason, self::MAX_SECRET_ATTEMPTS);
        }

        return sprintf('%s（还可以再试 %d 次）', $reason, $left);
    }

    private function shouldProcessAfterSecret(BillTask $billTask): bool
    {
        return true === $this->channelRegistry
            ->find($billTask->source, $billTask->profile_id)
            ?->shouldProcessAfterSecret($billTask);
    }

    private function appendEvent(BillTask $billTask, string $eventType, string $message): void
    {
        $billTask->events()->create([
            'event_type' => $eventType,
            'message'    => $message,
        ]);
    }
}
