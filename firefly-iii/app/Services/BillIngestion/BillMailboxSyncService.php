<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillTask;
use FireflyIII\Support\Facades\Preferences;
use FireflyIII\User;
use Illuminate\Support\Facades\Storage;

class BillMailboxSyncService
{
    public function __construct(
        private readonly ImapBillMailboxClient $client,
        private readonly BillMailIngestionService $ingestionService,
        private readonly BillSourceChannelRegistry $channelRegistry,
    ) {}

    public function syncForUser(User $user, int $limit = 25): BillMailboxSyncResult
    {
        $config = $this->configForUser($user);
        $result = new BillMailboxSyncResult();
        if (!$config->enabled) {
            return $result;
        }
        if (!$config->isUsable()) {
            ++$result->failed;
            $result->addError('邮箱已启用，但登录信息不完整；请重新保存邮箱密码。');

            return $result;
        }

        $limit  = max(1, min($limit, 100));
        $uids   = [];

        try {
            $this->client->connect($config);

            foreach ($this->folders($config) as $folder) {
                try {
                    $this->client->selectFolder($folder);
                } catch (\Throwable $e) {
                    ++$result->failed;
                    $result->addError($this->folderErrorMessage($folder, $e));

                    continue;
                }

                foreach ($this->searchCriteria() as $criteria) {
                    try {
                        $foundUids = $this->client->search($criteria, $limit);
                    } catch (\Throwable) {
                        continue;
                    }

                    foreach ($foundUids as $uid) {
                        $uids[$uid] = $uid;
                        if (count($uids) >= $limit) {
                            break 3;
                        }
                    }
                }
            }

            foreach (array_values($uids) as $uid) {
                ++$result->scanned;
                try {
                    $raw = $this->client->fetchRawMessage($uid);
                    if ($this->isDuplicate($user, $uid, $raw)) {
                        ++$result->duplicates;

                        continue;
                    }

                    $task = $this->storeMessage($user, $config, $uid, $raw);
                    if ($task instanceof BillTask) {
                        $this->client->markSeen($uid);
                        ++$result->created;

                        continue;
                    }

                    ++$result->ignored;
                } catch (\Throwable) {
                    ++$result->failed;
                }
            }
        } catch (\Throwable $e) {
            ++$result->failed;
            $result->addError(sprintf('邮箱同步失败：%s', $e->getMessage()));
        } finally {
            $this->client->close();
        }

        return $result;
    }

    private function configForUser(User $user): BillMailboxConfig
    {
        $rules = Preferences::getForUser($user, 'bill_inbox_processing_rules', [])->data ?? [];

        return new BillMailboxConfig(
            enabled: true === Preferences::getForUser($user, 'bill_inbox_mailbox_enabled', false)->data,
            provider: (string) Preferences::getForUser($user, 'bill_inbox_mailbox_provider', 'gmail')->data,
            email: (string) Preferences::getForUser($user, 'bill_inbox_mailbox_email', '')->data,
            host: (string) Preferences::getForUser($user, 'bill_inbox_mailbox_host', 'imap.gmail.com')->data,
            port: (int) Preferences::getForUser($user, 'bill_inbox_mailbox_port', 993)->data,
            encryption: (string) Preferences::getForUser($user, 'bill_inbox_mailbox_encryption', 'ssl')->data,
            username: (string) Preferences::getForUser($user, 'bill_inbox_mailbox_username', '')->data,
            password: (string) Preferences::getEncryptedForUser($user, 'bill_inbox_mailbox_password', '')->data,
            folder: (string) Preferences::getForUser($user, 'bill_inbox_mailbox_folder', 'INBOX')->data,
            rules: is_array($rules) ? $rules : [],
            gmailLabel: (string) Preferences::getForUser($user, 'bill_inbox_quick_gmail_label', '')->data,
        );
    }

    /**
     * @return array<int, string>
     */
    private function folders(BillMailboxConfig $config): array
    {
        $folder = trim($config->folder);

        return ['' === $folder ? 'INBOX' : $folder];
    }

    private function folderErrorMessage(string $folder, \Throwable $exception): string
    {
        if (str_contains($exception->getMessage(), 'NONEXISTENT') || str_contains($exception->getMessage(), 'Unknown Mailbox')) {
            return sprintf('邮箱文件夹不存在：%s。请在邮箱配置里改成已有文件夹，或留空使用 INBOX。', $folder);
        }

        return sprintf('无法打开邮箱文件夹 %s：%s', $folder, $exception->getMessage());
    }

    private function isDuplicate(User $user, string $uid, string $raw): bool
    {
        $messageId = $this->messageId($raw);
        $query     = BillMailMessage::query()->where('user_id', $user->id);
        $query->where(null === $messageId ? 'checksum' : 'message_id', $messageId ?? hash('sha256', $raw));

        if ($query->exists()) {
            return true;
        }

        return BillMailMessage::query()
            ->where('user_id', $user->id)
            ->where('sync_cursor', sprintf('gmail:%s', $uid))
            ->exists()
        ;
    }

    private function messageId(string $raw): ?string
    {
        if (1 === preg_match('/^Message-ID:\s*(.+)$/mi', $raw, $matches)) {
            $value = trim($matches[1]);

            return '' === $value ? null : $value;
        }

        return null;
    }

    /**
     * @return array<int, string>
     */
    private function searchCriteria(): array
    {
        return $this->channelRegistry->mailboxSearchCriteria();
    }

    private function storeMessage(User $user, BillMailboxConfig $config, string $uid, string $raw): ?BillTask
    {
        $message     = $this->parseMessage($raw);
        $basePath    = sprintf('bill-inbox/%d/%s', $user->id, Carbon::now()->format('YmdHisv'));
        $rawPath     = sprintf('%s/message-%s.eml', $basePath, preg_replace('/[^A-Za-z0-9_\-]/', '_', $uid));
        $attachments = [];

        Storage::disk('local')->put($rawPath, $raw);

        $bodyTextPath = $this->storeBodyPart($basePath, 'text', $message['body_text']);
        $bodyHtmlPath = $this->storeBodyPart($basePath, 'html', $message['body_html']);

        foreach ($message['attachments'] as $index => $attachment) {
            $attachmentPath = $this->storeAttachment($basePath, $index, $attachment['filename'], $attachment['content']);
            $attachments[]  = new BillMailAttachment(
                filename: $attachment['filename'],
                path: $attachmentPath,
                checksum: hash('sha256', $attachment['content']),
                size: strlen($attachment['content']),
            );
        }

        $mail = BillMailMessage::query()->create([
            'user_id'      => $user->id,
            'message_id'   => $message['message_id'],
            'mailbox'      => '' === $config->email ? $config->username : $config->email,
            'from_address' => $message['from_address'],
            'to_address'   => $message['to_address'],
            'subject'      => $message['subject'],
            'received_at'  => $message['received_at'],
            'raw_path'     => $rawPath,
            'body_text_path'=> $bodyTextPath,
            'body_html_path'=> $bodyHtmlPath,
            'checksum'     => hash('sha256', $raw),
            'sync_cursor'  => sprintf('gmail:%s', $uid),
        ]);

        return $this->ingestionService->ingest($mail, $attachments);
    }

    private function storeAttachment(string $basePath, int $index, string $filename, string $content): string
    {
        $filename = preg_replace('/[\/\\\\]+/', '_', $filename);
        if (null === $filename || '' === $filename) {
            $filename = sprintf('attachment-%d.bin', $index + 1);
        }
        $path     = sprintf('%s/attachments/%02d-%s', $basePath, $index + 1, $filename);
        Storage::disk('local')->put($path, $content);

        return $path;
    }

    private function storeBodyPart(string $basePath, string $kind, ?string $content): ?string
    {
        if (null === $content || '' === trim($content)) {
            return null;
        }

        $extension = 'html' === $kind ? 'html' : 'txt';
        $path      = sprintf('%s/body.%s', $basePath, $extension);
        Storage::disk('local')->put($path, $content);

        return $path;
    }

    private function decodedHeader(?string $value): ?string
    {
        if (null === $value) {
            return null;
        }

        $decoded = iconv_mime_decode($value, ICONV_MIME_DECODE_CONTINUE_ON_ERROR, 'UTF-8');
        if (false === $decoded && function_exists('mb_decode_mimeheader')) {
            $decoded = mb_decode_mimeheader($value);
        }

        return false === $decoded ? $value : $decoded;
    }

    private function decodePartBody(string $body, string $encoding): string
    {
        $encoding = strtolower($encoding);
        if ('base64' === $encoding) {
            $decoded = base64_decode(preg_replace('/\s+/', '', $body) ?? $body, true);

            return false === $decoded ? $body : $decoded;
        }
        if ('quoted-printable' === $encoding) {
            return quoted_printable_decode($body);
        }

        return $body;
    }

    private function emailAddress(?string $value): ?string
    {
        if (null === $value) {
            return null;
        }
        if (1 === preg_match('/<([^>]+)>/', $value, $matches)) {
            return trim($matches[1]);
        }
        if (1 === preg_match('/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+/i', $value, $matches)) {
            return trim($matches[0]);
        }

        return trim($value);
    }

    private function header(array $headers, string $name): ?string
    {
        return $headers[strtolower($name)] ?? null;
    }

    private function headerParameters(string $value): array
    {
        $parts      = str_getcsv($value, ';', '"', '\\');
        $parameters = [];
        foreach (array_slice($parts, 1) as $part) {
            if (!str_contains($part, '=')) {
                continue;
            }
            [$key, $parameterValue] = explode('=', $part, 2);
            $key                    = strtolower(trim($key));
            $parameterValue         = trim($parameterValue, " \t\n\r\0\x0B\"");
            if (str_ends_with($key, '*')) {
                $key = substr($key, 0, -1);
                if (1 === preg_match("/^[^']*'[^']*'(.+)$/", $parameterValue, $matches)) {
                    $parameterValue = $matches[1];
                }
                $parameterValue = rawurldecode($parameterValue);
            }

            $parameters[$key] = $this->decodedHeader($parameterValue);
        }

        return $parameters;
    }

    private function mainHeaderValue(?string $value): string
    {
        if (null === $value) {
            return '';
        }

        return strtolower(trim(str_getcsv($value, ';', '"', '\\')[0] ?? ''));
    }

    /**
     * @return array<string, string>
     */
    private function parseHeaders(string $headerText): array
    {
        $headers = [];
        $current = null;
        foreach (explode("\n", $headerText) as $line) {
            $line = rtrim($line, "\r");
            if ('' === $line) {
                continue;
            }
            if (null !== $current && preg_match('/^\s+/', $line)) {
                $headers[$current] .= ' '.trim($line);

                continue;
            }
            if (!str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $current        = strtolower(trim($name));
            $headers[$current] = trim($value);
        }

        return $headers;
    }

    /**
     * @return array<int, array{filename: string, content: string}>
     */
    private function parseAttachments(string $body, array $headers): array
    {
        $contentType = $this->header($headers, 'content-type') ?? '';
        $mediaType   = $this->mainHeaderValue($contentType);
        if (str_starts_with($mediaType, 'multipart/')) {
            $parameters = $this->headerParameters($contentType);
            $boundary   = (string) ($parameters['boundary'] ?? '');
            if ('' === $boundary) {
                return [];
            }

            $attachments = [];
            foreach ($this->splitMultipartBody($body, $boundary) as $part) {
                [$partHeaders, $partBody] = $this->splitRawMessage($part);
                $attachments             = array_merge($attachments, $this->parseAttachments($partBody, $this->parseHeaders($partHeaders)));
            }

            return $attachments;
        }

        $disposition = $this->header($headers, 'content-disposition') ?? '';
        $filename    = $this->partFilename($headers);
        if (!str_starts_with($this->mainHeaderValue($disposition), 'attachment') && null === $filename) {
            return [];
        }

        return [[
            'filename' => $filename ?? 'attachment.bin',
            'content'  => $this->decodePartBody($body, (string) ($this->header($headers, 'content-transfer-encoding') ?? '')),
        ]];
    }

    /**
     * @return array{message_id: ?string, from_address: ?string, to_address: ?string, subject: ?string, received_at: ?Carbon, body_text: ?string, body_html: ?string, attachments: array<int, array{filename: string, content: string}>}
     */
    private function parseMessage(string $raw): array
    {
        [$headerText, $body] = $this->splitRawMessage($raw);
        $headers            = $this->parseHeaders($headerText);
        $date               = $this->decodedHeader($this->header($headers, 'date'));

        return [
            'message_id'   => $this->decodedHeader($this->header($headers, 'message-id')),
            'from_address' => $this->emailAddress($this->decodedHeader($this->header($headers, 'from'))),
            'to_address'   => $this->emailAddress($this->decodedHeader($this->header($headers, 'to'))),
            'subject'      => $this->decodedHeader($this->header($headers, 'subject')),
            'received_at'  => null === $date || '' === $date ? null : Carbon::parse($date),
            'body_text'    => $this->parseBodyPart($body, $headers, 'text/plain'),
            'body_html'    => $this->parseBodyPart($body, $headers, 'text/html'),
            'attachments'  => $this->parseAttachments($body, $headers),
        ];
    }

    private function parseBodyPart(string $body, array $headers, string $targetMediaType): ?string
    {
        $contentType = $this->header($headers, 'content-type') ?? '';
        $mediaType   = $this->mainHeaderValue($contentType);
        if (str_starts_with($mediaType, 'multipart/')) {
            $parameters = $this->headerParameters($contentType);
            $boundary   = (string) ($parameters['boundary'] ?? '');
            if ('' === $boundary) {
                return null;
            }

            foreach ($this->splitMultipartBody($body, $boundary) as $part) {
                [$partHeaders, $partBody] = $this->splitRawMessage($part);
                $content                  = $this->parseBodyPart($partBody, $this->parseHeaders($partHeaders), $targetMediaType);
                if (null !== $content) {
                    return $content;
                }
            }

            return null;
        }

        if ($mediaType !== strtolower($targetMediaType)) {
            return null;
        }

        return $this->decodePartBody($body, (string) ($this->header($headers, 'content-transfer-encoding') ?? ''));
    }

    private function partFilename(array $headers): ?string
    {
        $dispositionParameters = $this->headerParameters((string) ($this->header($headers, 'content-disposition') ?? ''));
        $contentTypeParameters = $this->headerParameters((string) ($this->header($headers, 'content-type') ?? ''));
        $filename              = $dispositionParameters['filename'] ?? $contentTypeParameters['name'] ?? null;

        return null === $filename || '' === $filename ? null : $filename;
    }

    /**
     * @return array<int, string>
     */
    private function splitMultipartBody(string $body, string $boundary): array
    {
        $lines   = explode("\n", str_replace(["\r\n", "\r"], "\n", $body));
        $parts   = [];
        $current = null;

        foreach ($lines as $line) {
            $trimmed = rtrim($line, "\n");
            if ('--'.$boundary === $trimmed) {
                if (null !== $current) {
                    $parts[] = implode("\n", $current);
                }
                $current = [];

                continue;
            }
            if ('--'.$boundary.'--' === $trimmed) {
                if (null !== $current) {
                    $parts[] = implode("\n", $current);
                }
                break;
            }
            if (null !== $current) {
                $current[] = $line;
            }
        }

        return $parts;
    }

    /**
     * @return array{0: string, 1: string}
     */
    private function splitRawMessage(string $raw): array
    {
        $normalized = str_replace(["\r\n", "\r"], "\n", $raw);
        $parts      = explode("\n\n", $normalized, 2);

        return [$parts[0] ?? '', $parts[1] ?? ''];
    }
}
