<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillSecretChallenge;
use FireflyIII\Models\BillTask;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Throwable;

class BillTaskActionService
{
    public function __construct(
        private readonly BillTaskProcessor $taskProcessor,
        private readonly BillSourceChannelRegistry $channelRegistry,
        private readonly BillStatementRowDismissalService $dismissalService = new BillStatementRowDismissalService(),
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

        // 任务归档了，名下没处置完的行不能继续挂在待办里——任务已经从列表消失，
        // 那些行谁也点不到，却还在计数上。级联划掉，之后想找回来在「已划掉」里恢复。
        $dismissed                     = $this->dismissalService->dismissPendingRowsForTask($billTask);

        $this->appendEvent($billTask, 'task.archived', 0 === $dismissed
            ? '账单任务已归档'
            : sprintf('账单任务已归档，%d 条未处置流水一并划掉', $dismissed));

        return $billTask->refresh();
    }

    public function deleteFailed(BillTask $billTask): void
    {
        $paths = $billTask->artifacts()
            ->pluck('path')
            ->filter(static fn (mixed $path): bool => is_string($path) && '' !== $path)
            ->all()
        ;
        $mail       = $billTask->mailMessage;
        $isOnlyTask = null !== $mail && 1 === $mail->billTasks()->count();

        if ($isOnlyTask) {
            $paths = [...$paths, ...array_filter([
                $mail->raw_path,
                $mail->body_text_path,
                $mail->body_html_path,
            ], static fn (mixed $path): bool => is_string($path) && '' !== $path)];
        }

        DB::transaction(static function () use ($billTask, $mail, $isOnlyTask): void {
            $billTask->statementRows()->delete();
            $billTask->statementImports()->delete();
            $billTask->secretChallenges()->delete();
            $billTask->events()->delete();
            $billTask->artifacts()->delete();
            $billTask->delete();

            // 留下邮件指纹防止下次同步又创建同一条失败任务，只清本地正文和附件。
            if ($isOnlyTask && null !== $mail) {
                $mail->raw_path       = null;
                $mail->body_text_path = null;
                $mail->body_html_path = null;
                $mail->save();
            }
        });

        if ([] !== $paths) {
            Storage::disk('local')->delete(array_values(array_unique($paths)));
        }
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

        // 逐个走 archive()，行的级联划掉在那里面，这里不重复一遍。
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
        } catch (InvalidBillSecretException $e) {
            $this->rejectSecret($billTask, $e->getMessage());

            throw $e;
        } catch (Throwable $e) {
            $this->failSecretProcessing($billTask, $challenge, $e->getMessage());

            throw new RuntimeException($e->getMessage(), 0, $e);
        }

        if (false === $processed) {
            $billTask->refresh();
            $message = $billTask->error_message ?? '账单处理失败。';
            $this->failSecretProcessing($billTask, $challenge, $message);

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

    /** 密码没过：任务退回等密码那一步，挑战继续开着。 */
    private function rejectSecret(BillTask $billTask, string $message): void
    {
        DB::transaction(function () use ($billTask, $message): void {
            // 处理途中 channel 可能已经往这个模型上写了半截东西（状态、metadata），
            // 它那个事务回滚了但内存里还留着，不 refresh 就会被下面的 save 写回去。
            $billTask->refresh();
            $billTask->status        = 'needs_secret';
            $billTask->error_code    = 'secret_rejected';
            $billTask->error_message = $message;
            $billTask->save();

            $this->appendEvent($billTask, 'challenge.rejected', '密码或验证码未通过');
        });
    }

    private function failSecretProcessing(BillTask $billTask, BillSecretChallenge $challenge, string $message): void
    {
        DB::transaction(function () use ($billTask, $challenge, $message): void {
            $challenge->status      = 'failed';
            $challenge->consumed_at = Carbon::now();
            $challenge->save();

            $billTask->refresh();
            $billTask->status                      = 'failed';
            $billTask->error_code                  = 'processing_failed';
            $billTask->error_message               = $message;
            $billTask->current_secret_challenge_id = null;
            $billTask->save();

            $this->appendEvent($billTask, 'task.failed', '账单处理失败，请检查附件后重试');
        });
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
