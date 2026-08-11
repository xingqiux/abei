<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\AlipayStatementArchiveExtractor;
use FireflyIII\Services\BillIngestion\BillSourceChannel;

class AlipayBillSourceChannel implements BillSourceChannel
{
    public function __construct(private readonly AlipayStatementArchiveExtractor $extractor) {}

    public function source(): string
    {
        return 'alipay';
    }

    public function displayName(): string
    {
        return '支付宝交易流水';
    }

    /**
     * @return array<int, string>
     */
    public function profileIds(): array
    {
        return ['alipay-statement'];
    }

    public function needsSecret(BillTask $task): bool
    {
        return $task->artifacts()->where('encrypted', true)->exists();
    }

    public function prepare(BillTask $task): bool
    {
        return true;
    }

    public function secretPrompt(BillTask $task): string
    {
        return '请输入支付宝服务消息中的账单解压密码';
    }

    public function process(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool
    {
        $encryptedArchives = $task->artifacts()
            ->where('kind', 'zip')
            ->where('encrypted', true)
            ->orderBy('id')
            ->get()
        ;

        if ($encryptedArchives->isNotEmpty() && (null === $secret || '' === trim($secret))) {
            $this->openSecretChallenge($task);

            return true;
        }

        $created = 0;
        foreach ($encryptedArchives as $archive) {
            $created += count($this->extractor->extract($archive, (string) $secret));
        }

        $metadata                          = is_array($task->metadata) ? $task->metadata : [];
        $metadata['parsed_artifact_count'] = $created;
        $task->metadata                    = $metadata;
        $task->status                      = 'parsed';
        $task->error_code                  = null;
        $task->error_message               = null;
        $task->save();
        $this->appendEvent($task, 'task.parsed', sprintf('支付宝账单已解压，生成 %d 个流水产物', $created));

        return true;
    }

    public function shouldProcessAfterSecret(BillTask $task): bool
    {
        return true;
    }

    private function openSecretChallenge(BillTask $task): void
    {
        $challenge = $task->secretChallenges()->create([
            'kind'     => 'password',
            'prompt'   => $this->secretPrompt($task),
            'status'   => 'open',
            'attempts' => 0,
        ]);

        $task->status                      = 'needs_secret';
        $task->current_secret_challenge_id = $challenge->id;
        $task->save();
        $this->appendEvent($task, 'challenge.created', '任务需要密码或验证码');
    }

    private function appendEvent(BillTask $task, string $eventType, string $message): void
    {
        $task->events()->create([
            'event_type' => $eventType,
            'message'    => $message,
        ]);
    }
}
