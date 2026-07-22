<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use Carbon\Carbon;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillMailAttachment;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use FireflyIII\Services\BillIngestion\RemoteBillFileDownloader;
use FireflyIII\Services\BillIngestion\WechatPayStatementArchiveExtractor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

class WechatPayBillSourceChannel implements BillSourceChannel
{
    private const string DOWNLOAD_HOST = 'tenpay.wechatpay.cn';
    private const string DOWNLOAD_PATH = '/userroll/userbilldownload/downloadfilefromemail';

    public function __construct(
        private readonly RemoteBillFileDownloader $downloader,
        private readonly WechatPayStatementArchiveExtractor $extractor,
    ) {}

    public function source(): string
    {
        return 'wechat';
    }

    public function displayName(): string
    {
        return '微信支付账单流水';
    }

    public function settingsDescription(): string
    {
        return '会自动识别 wechatpay@tencent.com 发来的微信支付账单流水邮件，并自动下载加密账单文件。';
    }

    /**
     * @return array<int, string>
     */
    public function profileIds(): array
    {
        return ['wechat-pay-statement'];
    }

    /**
     * @return array<int, string>
     */
    public function mailboxSearchCriteria(): array
    {
        return ['FROM "wechatpay@tencent.com"'];
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function matches(BillMailMessage $mail, array $attachments): bool
    {
        $from    = strtolower((string) $mail->from_address);
        $subject = (string) $mail->subject;
        $body    = $this->mailBody($mail);

        return str_contains($from, 'wechatpay@tencent.com')
            && (str_contains($subject, '微信支付账单流水文件') || str_contains($body, '微信支付账单流水文件'))
            && (str_contains($subject, '账单流水文件') || str_contains($body, '点击下载'));
    }

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function ingest(BillMailMessage $mail, array $attachments): BillTask
    {
        return DB::transaction(function () use ($mail): BillTask {
            $body        = $this->mailBody($mail);
            $period      = $this->statementPeriod((string) $mail->subject.' '.$body);
            $this->downloadUrl($body);

            /** @var BillTask $task */
            $task = BillTask::query()->create([
                'user_id'              => $mail->user_id,
                'bill_mail_message_id' => $mail->id,
                'source'               => $this->source(),
                'profile_id'           => 'wechat-pay-statement',
                'status'               => 'received',
                'received_at'          => $mail->received_at,
                'summary'              => '微信支付账单流水',
                'metadata'             => [
                    'mail_subject'      => $mail->subject,
                    'password_source'   => 'wechat_pay_official_account',
                    'sender'            => $mail->from_address,
                    'statement_period'  => [
                        'start' => $period[0],
                        'end'   => $period[1],
                    ],
                    'remote_file'       => [
                        'source' => 'tenpay_download',
                        'status' => 'pending',
                        'host'   => self::DOWNLOAD_HOST,
                        'path'   => self::DOWNLOAD_PATH,
                    ],
                ],
            ]);

            $task->events()->create([
                'event_type' => 'task.created',
                'message'    => '已识别微信支付账单流水邮件，等待自动下载账单文件',
                'metadata'   => ['source' => 'mailbox'],
            ]);

            return $task;
        });
    }

    public function prepare(BillTask $task): bool
    {
        if ($task->artifacts()->whereMetadataSource('remote_download')->exists()) {
            return true;
        }

        $metadata   = is_array($task->metadata) ? $task->metadata : [];
        $remoteFile = is_array($metadata['remote_file'] ?? null) ? $metadata['remote_file'] : [];
        $url        = (string) ($remoteFile['url'] ?? '');
        if ('' === $url) {
            $task->loadMissing('mailMessage');
            if ($task->mailMessage instanceof BillMailMessage) {
                $url = $this->downloadUrl($this->mailBody($task->mailMessage));
            }
        }

        try {
            $this->assertAllowedDownloadUrl($url);
            $file     = $this->downloader->download($url);
            $filename = $this->safeFilename($file->filename);
            $path     = sprintf('bill-inbox/%d/remote/%s', $task->id, $filename);

            Storage::disk('local')->put($path, $file->content);

            $task->artifacts()->create([
                'kind'      => $this->artifactKind($filename, $file->contentType),
                'filename'  => $filename,
                'path'      => $path,
                'checksum'  => hash('sha256', $file->content),
                'encrypted' => true,
                'metadata'  => [
                    'source'          => 'remote_download',
                    'remote_source'   => 'tenpay_download',
                    'password_source' => 'wechat_pay_official_account',
                    'content_type'    => $file->contentType,
                    'size'            => strlen($file->content),
                ],
            ]);

            unset($remoteFile['url']);
            $remoteFile['status']      = 'downloaded';
            $remoteFile['downloaded_at'] = Carbon::now('Asia/Shanghai')->toAtomString();
            $remoteFile['filename']    = $filename;
            $metadata['remote_file']   = $remoteFile;
            $task->metadata            = $metadata;
            $task->error_code          = null;
            $task->error_message       = null;
            $task->save();
            $this->appendEvent($task, 'remote_file.downloaded', '微信支付账单文件已自动下载');

            return true;
        } catch (\Throwable $e) {
            unset($remoteFile['url']);
            $remoteFile['status']    = 'failed';
            $metadata['remote_file'] = $remoteFile;
            $task->status            = 'failed';
            $task->error_code        = 'remote_download_failed';
            $task->error_message     = '微信账单下载失败，请稍后重试。';
            $task->metadata          = $metadata;
            $task->save();
            $this->appendEvent($task, 'remote_file.failed', '微信支付账单文件下载失败');

            return false;
        }
    }

    public function needsSecret(BillTask $task): bool
    {
        return $task->artifacts()->where('encrypted', true)->exists();
    }

    public function secretPrompt(BillTask $task): string
    {
        return '请输入微信支付公众号收到的账单解压密码';
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
        $this->appendEvent($task, 'task.parsed', sprintf('微信支付账单已解压，生成 %d 个流水产物', $created));

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
            'from_contains'         => 'wechatpay@tencent.com',
            'subject_contains'      => '微信支付账单流水文件',
            'attachment_extensions' => ['zip'],
            'gmail_label'           => '',
            'keywords'              => ['微信支付', '账单流水'],
            'built_in'              => true,
        ];
    }

    private function assertAllowedDownloadUrl(string $url): void
    {
        if ('' === trim($url)) {
            throw new RuntimeException('微信支付账单邮件缺少下载链接。');
        }

        $parts = parse_url($url);
        if ('https' !== ($parts['scheme'] ?? null)
            || self::DOWNLOAD_HOST !== ($parts['host'] ?? null)
            || self::DOWNLOAD_PATH !== ($parts['path'] ?? null)
        ) {
            throw new RuntimeException('微信支付账单下载链接不在允许范围内。');
        }

        parse_str((string) ($parts['query'] ?? ''), $query);
        if ('' === (string) ($query['encrypted_file_data'] ?? '')) {
            throw new RuntimeException('微信支付账单下载链接缺少必要参数。');
        }
    }

    private function artifactKind(string $filename, string $contentType): string
    {
        $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        if ('' !== $extension) {
            return $extension;
        }
        if (str_contains(strtolower($contentType), 'zip')) {
            return 'zip';
        }

        return 'attachment';
    }

    private function downloadUrl(string $body): string
    {
        if (1 === preg_match('/https:\/\/tenpay\.wechatpay\.cn\/userroll\/userbilldownload\/downloadfilefromemail\?[^"\'\s<>]+/u', $body, $matches)) {
            $url = html_entity_decode($matches[0], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $this->assertAllowedDownloadUrl($url);

            return $url;
        }

        throw new RuntimeException('微信支付账单邮件缺少下载链接。');
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
            $filename = 'wechat-pay-statement.zip';
        }

        return '' === pathinfo($filename, PATHINFO_EXTENSION) ? $filename.'.zip' : $filename;
    }

    /**
     * @return array{0:null|string,1:null|string}
     */
    private function statementPeriod(string $content): array
    {
        if (1 === preg_match('/账单流水文件\((\d{8})-(\d{8})\)/u', $content, $matches)) {
            return [
                Carbon::createFromFormat('Ymd', $matches[1], 'Asia/Shanghai')?->toDateString(),
                Carbon::createFromFormat('Ymd', $matches[2], 'Asia/Shanghai')?->toDateString(),
            ];
        }

        return [null, null];
    }

    private function appendEvent(BillTask $task, string $eventType, string $message): void
    {
        $task->events()->create([
            'event_type' => $eventType,
            'message'    => $message,
        ]);
    }
}
