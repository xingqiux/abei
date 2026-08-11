<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use FireflyIII\Services\BillIngestion\CmbStatementArchiveExtractor;

class CmbTransactionBillSourceChannel implements BillSourceChannel
{
    public function __construct(private readonly CmbStatementArchiveExtractor $extractor) {}

    public function source(): string
    {
        return 'cmb';
    }

    public function displayName(): string
    {
        return '招商银行交易流水';
    }

    /**
     * @return array<int, string>
     */
    public function profileIds(): array
    {
        return ['cmb-transaction-statement'];
    }

    public function prepare(BillTask $task): bool
    {
        return true;
    }

    public function needsSecret(BillTask $task): bool
    {
        return $task->artifacts()->where('encrypted', true)->exists();
    }

    public function secretPrompt(BillTask $task): string
    {
        return '请输入招商银行App“流水打印-申请记录”中的账单解压码';
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

        $rowCount = $task->statementRows()->count();

        $metadata                          = is_array($task->metadata) ? $task->metadata : [];
        $metadata['parsed_artifact_count'] = $created;
        $metadata['parser_status']         = $rowCount > 0 ? 'parsed' : 'waiting_for_sample_structure';
        $metadata['parsed_row_count']      = $rowCount;
        $task->metadata                    = $metadata;
        $task->status                      = 'parsed';
        $task->error_code                  = null;
        $task->error_message               = null;
        $task->save();
        $message = $rowCount > 0
            ? sprintf('招商银行账单已解析，生成 %d 条流水明细', $rowCount)
            : sprintf('招商银行账单已解压，生成 %d 个账单文件', $created);
        $this->appendEvent($task, 'task.parsed', $message);

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
