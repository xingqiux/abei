<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillTask;
use FireflyIII\User;
use Illuminate\Support\Facades\DB;
use RuntimeException;

class BillTaskActionService
{
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

        DB::transaction(function () use ($billTask, $challenge): void {
            $challenge->status      = 'consumed';
            $challenge->attempts    += 1;
            $challenge->consumed_at = Carbon::now();
            $challenge->save();

            $billTask->status                      = 'ready';
            $billTask->current_secret_challenge_id = null;
            $billTask->error_code                  = null;
            $billTask->error_message               = null;
            $billTask->save();

            $this->appendEvent($billTask, 'task.ready', '任务已准备处理');
            $this->appendEvent($billTask, 'challenge.consumed', '验证码/密码已提交');
        });

        if ($this->shouldProcessAfterSecret($billTask) && false === $this->taskProcessor->process($billTask, $secret)) {
            $billTask->refresh();

            throw new RuntimeException($billTask->error_message ?? '账单处理失败。');
        }

        return $billTask->refresh();
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
