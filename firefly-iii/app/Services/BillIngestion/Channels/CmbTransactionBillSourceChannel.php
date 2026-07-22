<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use Carbon\Carbon;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillMailAttachment;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use FireflyIII\Services\BillIngestion\CmbStatementArchiveExtractor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

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

    public function settingsDescription(): string
    {
        return '会自动识别 95555@message.cmbchina.com 发来的招商银行交易流水邮件，并处理加密账单附件。';
    }

    /**
     * @return array<int, string>
     */
    public function profileIds(): array
    {
        return ['cmb-transaction-statement'];
    }

    /**
     * @return array<int, string>
     */
    public function mailboxSearchCriteria(): array
    {
        return ['FROM "95555@message.cmbchina.com"'];
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function matches(BillMailMessage $mail, array $attachments): bool
    {
        $from    = strtolower((string) $mail->from_address);
        $subject = (string) $mail->subject;
        $body    = $this->mailBody($mail);

        return str_contains($from, '95555@message.cmbchina.com')
            && (str_contains($subject, '招商银行交易流水') || str_contains($body, '电子版交易流水'))
            && (str_contains($body, '招商银行App') || str_contains($body, '流水打印') || $this->hasZipAttachment($attachments));
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function ingest(BillMailMessage $mail, array $attachments): BillTask
    {
        return DB::transaction(function () use ($mail, $attachments): BillTask {
            $body      = $this->mailBody($mail);
            $appliedAt = $this->appliedAt((string) $mail->subject."\n".$body);

            /** @var BillTask $task */
            $task = BillTask::query()->create([
                'user_id'              => $mail->user_id,
                'bill_mail_message_id' => $mail->id,
                'source'               => $this->source(),
                'profile_id'           => 'cmb-transaction-statement',
                'status'               => 'received',
                'received_at'          => $mail->received_at,
                'summary'              => '招商银行交易流水',
                'metadata'             => [
                    'mail_subject'     => $mail->subject,
                    'password_source'  => 'cmb_app_statement_record',
                    'sender'           => $mail->from_address,
                    'applied_at'       => $appliedAt,
                ],
            ]);

            foreach ($attachments as $attachment) {
                $task->artifacts()->create([
                    'kind'      => $this->artifactKind($attachment->filename),
                    'filename'  => $this->safeFilename($attachment->filename),
                    'path'      => $attachment->path,
                    'checksum'  => $attachment->checksum,
                    'encrypted' => true,
                    'metadata'  => [
                        'source'          => 'mail_attachment',
                        'password_source' => 'cmb_app_statement_record',
                        'size'            => $attachment->size,
                    ],
                ]);
            }

            $task->events()->create([
                'event_type' => 'task.created',
                'message'    => '已识别招商银行交易流水邮件，等待解压码',
                'metadata'   => ['source' => 'mailbox'],
            ]);

            return $task;
        });
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

    /**
     * @return array<string, mixed>
     */
    public function processingRule(): array
    {
        return [
            'enabled'               => true,
            'name'                  => $this->displayName(),
            'source'                => $this->source(),
            'from_contains'         => '95555@message.cmbchina.com',
            'subject_contains'      => '招商银行交易流水',
            'attachment_extensions' => ['zip'],
            'gmail_label'           => '',
            'keywords'              => ['招商银行', '交易流水'],
            'built_in'              => true,
        ];
    }

    private function appliedAt(string $content): ?string
    {
        if (1 !== preg_match('/(\d{4})年(\d{2})月(\d{2})日(\d{2}):(\d{2}):(\d{2})/u', $content, $matches)) {
            return null;
        }

        return Carbon::create(
            (int) $matches[1],
            (int) $matches[2],
            (int) $matches[3],
            (int) $matches[4],
            (int) $matches[5],
            (int) $matches[6],
            'Asia/Shanghai'
        )->format('Y-m-d H:i:s');
    }

    private function artifactKind(string $filename): string
    {
        $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        return '' === $extension ? 'attachment' : $extension;
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    private function hasZipAttachment(array $attachments): bool
    {
        foreach ($attachments as $attachment) {
            if ('zip' === $this->artifactKind($attachment->filename)) {
                return true;
            }
        }

        return false;
    }

    private function mailBody(BillMailMessage $mail): string
    {
        $parts = [];
        foreach ([$mail->body_html_path, $mail->body_text_path] as $path) {
            if (null !== $path && '' !== $path && Storage::disk('local')->exists($path)) {
                $parts[] = Storage::disk('local')->get($path);
            }
        }

        return implode("\n", $parts);
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

    private function safeFilename(string $filename): string
    {
        $filename = preg_replace('/[\/\\\\]+/', '_', basename($filename));
        if (null === $filename || '' === $filename || '0' === $filename) {
            $filename = 'cmb-transaction-statement.zip';
        }

        return '' === pathinfo($filename, PATHINFO_EXTENSION) ? $filename.'.zip' : $filename;
    }

    private function appendEvent(BillTask $task, string $eventType, string $message): void
    {
        $task->events()->create([
            'event_type' => $eventType,
            'message'    => $message,
        ]);
    }
}
