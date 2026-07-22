<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillTask;
use FireflyIII\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class BillTaskProcessor
{
    private const array PROCESSABLE_STATUSES = ['received', 'ready'];

    public function __construct(private readonly BillSourceChannelRegistry $channelRegistry) {}

    public function processBatch(int $limit = 25, ?User $user = null): BillTaskBatchResult
    {
        $limit     = max(1, min($limit, 500));
        $processed = 0;
        $failed    = 0;

        $this->nextTasks($limit, $user)->each(function (BillTask $task) use (&$processed, &$failed): void {
            ++$processed;
            if (false === $this->process($task)) {
                ++$failed;
            }
        });

        return new BillTaskBatchResult($processed, $failed);
    }

    public function process(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool
    {
        return DB::transaction(function () use ($task, $secret): bool {
            $task->refresh();

            if ('received' === $task->status) {
                if (false === $this->routeReceivedTask($task)) {
                    return false;
                }
                $task->refresh();
                if ('ready' === $task->status) {
                    return $this->processReadyTask($task, $secret);
                }

                return true;
            }
            if ('ready' === $task->status) {
                return $this->processReadyTask($task, $secret);
            }

            return true;
        });
    }

    /**
     * @return Collection<int, BillTask>
     */
    private function nextTasks(int $limit, ?User $user = null): Collection
    {
        $query = BillTask::query()
            ->whereIn('status', self::PROCESSABLE_STATUSES)
            ->orderBy('received_at')
            ->orderBy('id')
            ->limit($limit)
        ;
        if (null !== $user) {
            $query->where('user_id', $user->id);
        }

        return $query->get();
    }

    private function routeReceivedTask(BillTask $task): bool
    {
        $channel = $this->channelRegistry->find($task->source, $task->profile_id);
        if (null === $channel) {
            $task->status = 'unknown';
            $task->save();
            $this->appendEvent($task, 'task.unknown', '未匹配到账单处理配置');

            return true;
        }

        if (false === $channel->prepare($task)) {
            return false;
        }

        $task->refresh();

        if ($channel->needsSecret($task)) {
            $challenge = $task->secretChallenges()->create([
                'kind'     => 'password',
                'prompt'   => $channel->secretPrompt($task),
                'status'   => 'open',
                'attempts' => 0,
            ]);

            $task->status                      = 'needs_secret';
            $task->current_secret_challenge_id = $challenge->id;
            $task->save();
            $this->appendEvent($task, 'challenge.created', '任务需要密码或验证码');

            return true;
        }

        $task->status = 'ready';
        $task->save();
        $this->appendEvent($task, 'task.ready', '任务已准备处理');

        return true;
    }

    private function processReadyTask(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool
    {
        $channel = $this->channelRegistry->find($task->source, $task->profile_id);
        if (null !== $channel) {
            return $channel->process($task, $secret);
        }

        return $this->failMissingProcessor($task);
    }

    private function failMissingProcessor(BillTask $task): bool
    {
        $task->status        = 'failed';
        $task->error_code    = 'processor_missing';
        $task->error_message = 'No source-specific bill processor is registered for this task yet.';
        $task->save();
        $this->appendEvent($task, 'task.failed', '缺少来源处理器，任务暂时无法解析');

        return false;
    }

    private function appendEvent(BillTask $task, string $eventType, string $message): void
    {
        $task->events()->create([
            'event_type' => $eventType,
            'message'    => $message,
        ]);
    }
}
