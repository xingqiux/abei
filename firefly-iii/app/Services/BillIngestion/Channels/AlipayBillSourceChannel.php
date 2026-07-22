<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use FireflyIII\Models\BillTask;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Services\BillIngestion\AlipayStatementArchiveExtractor;
use FireflyIII\Services\BillIngestion\BillMailAttachment;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use Illuminate\Support\Facades\DB;

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

    public function settingsDescription(): string
    {
        return '会自动识别 service@mail.alipay.com 发来的“支付宝交易流水明细”邮件；不需要配置 Gmail 标签或自定义规则。';
    }

    /**
     * @return array<int, string>
     */
    public function profileIds(): array
    {
        return ['alipay-statement'];
    }

    /**
     * @return array<int, string>
     */
    public function mailboxSearchCriteria(): array
    {
        return ['FROM "service@mail.alipay.com"'];
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function matches(BillMailMessage $mail, array $attachments): bool
    {
        $from    = strtolower((string) $mail->from_address);
        $subject = (string) $mail->subject;

        return str_contains($from, 'service@mail.alipay.com')
            && str_contains($subject, '支付宝交易流水明细');
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function ingest(BillMailMessage $mail, array $attachments): BillTask
    {
        return DB::transaction(function () use ($mail, $attachments): BillTask {
            /** @var BillTask $task */
            $task = BillTask::query()->create([
                'user_id'              => $mail->user_id,
                'bill_mail_message_id' => $mail->id,
                'source'               => $this->source(),
                'profile_id'           => 'alipay-statement',
                'status'               => 'received',
                'received_at'          => $mail->received_at,
                'summary'              => '支付宝交易流水明细',
                'metadata'             => [
                    'mail_subject'     => $mail->subject,
                    'password_source'  => 'alipay_service_message',
                    'sender'           => $mail->from_address,
                ],
            ]);

            foreach ($attachments as $attachment) {
                $task->artifacts()->create([
                    'kind'      => $this->artifactKind($attachment->filename),
                    'filename'  => $attachment->filename,
                    'path'      => $attachment->path,
                    'checksum'  => $attachment->checksum,
                    'encrypted' => true,
                    'metadata'  => [
                        'source'          => 'mail_attachment',
                        'password_source' => 'alipay_service_message',
                        'size'            => $attachment->size,
                    ],
                ]);
            }

            $task->events()->create([
                'event_type' => 'task.created',
                'message'    => '已识别支付宝交易流水邮件，等待解压密码',
                'metadata'   => [
                    'source' => 'mailbox',
                ],
            ]);

            return $task;
        });
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

    /**
     * @return array<string, mixed>
     */
    public function processingRule(): array
    {
        return [
            'enabled'               => true,
            'name'                  => $this->displayName(),
            'source'                => $this->source(),
            'from_contains'         => 'service@mail.alipay.com',
            'subject_contains'      => '支付宝交易流水明细',
            'attachment_extensions' => ['zip'],
            'gmail_label'           => '',
            'keywords'              => ['支付宝', '交易流水'],
            'built_in'              => true,
        ];
    }

    private function artifactKind(string $filename): string
    {
        $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        return '' === $extension ? 'attachment' : $extension;
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
