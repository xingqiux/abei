<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillMailAttachment;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use FireflyIII\Services\BillIngestion\CmbCreditDailyImportService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

class CmbCreditDailyBillSourceChannel implements BillSourceChannel
{
    public function __construct(private readonly CmbCreditDailyImportService $importService) {}

    public function source(): string
    {
        return 'cmb';
    }

    public function displayName(): string
    {
        return '招商银行信用卡每日消费';
    }

    public function settingsDescription(): string
    {
        return '会自动识别 ccsvc@message.cmbchina.com 发来的“每日信用管家”邮件，并直接解析 HTML 消费明细，无需验证码。';
    }

    /**
     * @return array<int,string>
     */
    public function profileIds(): array
    {
        return ['cmb-credit-card-daily'];
    }

    /**
     * @return array<int,string>
     */
    public function mailboxSearchCriteria(): array
    {
        // IMAP SEARCH 只接受 US-ASCII，中文主题会被 Gmail 以 BAD 拒绝；主题过滤交给 matches()。
        return ['FROM "ccsvc@message.cmbchina.com"'];
    }

    /**
     * @param array<int,BillMailAttachment> $attachments
     */
    public function matches(BillMailMessage $mail, array $attachments): bool
    {
        $from    = strtolower((string) $mail->from_address);
        $subject = trim((string) $mail->subject);

        return str_contains($from, 'ccsvc@message.cmbchina.com')
            && '每日信用管家' === $subject
            && str_contains($this->bodyHtml($mail), '您的消费明细如下');
    }

    /**
     * @param array<int,BillMailAttachment> $attachments
     */
    public function ingest(BillMailMessage $mail, array $attachments): BillTask
    {
        $htmlPath = (string) $mail->body_html_path;
        $html     = $this->bodyHtml($mail);
        if ('' === $htmlPath || '' === $html) {
            throw new RuntimeException('招商银行每日信用管家邮件缺少 HTML 正文。');
        }

        return DB::transaction(function () use ($mail, $htmlPath, $html): BillTask {
            /** @var BillTask $task */
            $task = BillTask::query()->create([
                'user_id'              => $mail->user_id,
                'bill_mail_message_id' => $mail->id,
                'source'               => $this->source(),
                'profile_id'           => 'cmb-credit-card-daily',
                'status'               => 'received',
                'received_at'          => $mail->received_at,
                'summary'              => '招商银行信用卡每日消费',
                'metadata'             => [
                    'mail_subject' => $mail->subject,
                    'sender'       => $mail->from_address,
                ],
            ]);

            $task->artifacts()->create([
                'kind'      => 'html',
                'filename'  => 'cmb-credit-daily.html',
                'path'      => $htmlPath,
                'checksum'  => hash('sha256', $html),
                'encrypted' => false,
                'metadata'  => [
                    'source'        => 'mail_body',
                    'original_name' => 'body.html',
                    'content_type'  => 'text/html',
                    'size'          => strlen($html),
                ],
            ]);

            $task->events()->create([
                'event_type' => 'task.created',
                'message'    => '已识别招商银行每日信用管家邮件，等待解析消费明细',
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
        return false;
    }

    public function secretPrompt(BillTask $task): string
    {
        return '招商银行每日信用管家邮件无需验证码。';
    }

    public function process(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool
    {
        $artifact = $task->artifacts()->where('kind', 'html')->orderBy('id')->first();
        if (!$artifact instanceof BillArtifact) {
            throw new RuntimeException('招商银行每日信用管家任务缺少 HTML 正文。');
        }

        $import = $this->importService->importArtifact($artifact);
        $metadata                     = is_array($task->metadata) ? $task->metadata : [];
        $metadata['parser_status']     = 'parsed';
        $metadata['parsed_row_count']  = $import->row_count;
        $task->metadata                = $metadata;
        $task->status                  = 'parsed';
        $task->error_code              = null;
        $task->error_message           = null;
        $task->save();
        $task->events()->create([
            'event_type' => 'task.parsed',
            'message'    => sprintf('招商银行信用卡日报已解析，生成 %d 条消费明细', $import->row_count),
        ]);

        return true;
    }

    public function shouldProcessAfterSecret(BillTask $task): bool
    {
        return false;
    }

    /**
     * @return array<string,mixed>
     */
    public function processingRule(): array
    {
        return [
            'enabled'               => true,
            'name'                  => $this->displayName(),
            'source'                => $this->source(),
            'from_contains'         => 'ccsvc@message.cmbchina.com',
            'subject_contains'      => '每日信用管家',
            'attachment_extensions' => [],
            'gmail_label'           => '',
            'keywords'              => ['每日信用管家', '消费明细'],
            'built_in'              => true,
        ];
    }

    private function bodyHtml(BillMailMessage $mail): string
    {
        $path = (string) $mail->body_html_path;
        if ('' === $path || !Storage::disk('local')->exists($path)) {
            return '';
        }

        $html = Storage::disk('local')->get($path);

        return is_string($html) ? $html : '';
    }
}
