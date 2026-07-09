<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Services\BillIngestion\BillInboxSummaryService;
use FireflyIII\Services\BillIngestion\BillMailboxSyncService;
use FireflyIII\Services\BillIngestion\BillSourceChannelRegistry;
use FireflyIII\Services\BillIngestion\BillTaskActionService;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use FireflyIII\Support\Facades\Preferences;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class BillInboxController extends Controller
{
    public function __construct(
        private readonly BillMailboxSyncService $mailboxSyncService,
        private readonly BillTaskProcessor $taskProcessor,
        private readonly BillTaskActionService $actionService,
        private readonly BillSourceChannelRegistry $channelRegistry,
        private readonly BillInboxSummaryService $summaryService,
    ) {}

    /**
     * 账单收件箱首页/侧栏用的渠道计数汇总，供 granary-web 新前端使用。
     */
    public function summary(): JsonResponse
    {
        return response()->json($this->summaryService->apiSummary(auth()->user()));
    }

    public function settings(): JsonResponse
    {
        return response()->json($this->settingsResponse());
    }

    public function updateSettings(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'enabled'    => ['nullable', 'boolean'],
            'provider'   => ['nullable', 'string', 'in:gmail,imap'],
            'email'      => ['nullable', 'string', 'max:255'],
            'host'       => ['nullable', 'string', 'max:255'],
            'port'       => ['nullable', 'integer', 'min:1', 'max:65535'],
            'encryption' => ['nullable', 'string', 'in:none,ssl,tls,starttls'],
            'username'   => ['nullable', 'string', 'max:255'],
            'password'   => ['nullable', 'string', 'max:1024'],
            'folder'     => ['nullable', 'string', 'max:255'],
        ]);

        $current    = $this->mailboxSettings();
        $provider   = (string) ($validated['provider'] ?? $current['provider']);
        $email      = (string) ($validated['email'] ?? $current['email']);
        $host       = trim((string) ($validated['host'] ?? $current['host']));
        $port       = (int) ($validated['port'] ?? $current['port']);
        $encryption = (string) ($validated['encryption'] ?? $current['encryption']);
        $folder     = trim((string) ($validated['folder'] ?? $current['folder']));
        $username   = trim((string) ($validated['username'] ?? $current['username']));

        if ('gmail' === $provider) {
            $host       = 'imap.gmail.com';
            $port       = 993;
            $encryption = 'ssl';
            $folder     = '' === $folder ? 'INBOX' : $folder;
            $username   = '' === $username ? $email : $username;
        }

        $folder = '' === $folder ? 'INBOX' : $folder;

        Preferences::set('bill_inbox_mailbox_enabled', (bool) ($validated['enabled'] ?? $current['enabled']));
        Preferences::set('bill_inbox_mailbox_provider', $provider);
        Preferences::set('bill_inbox_mailbox_email', $email);
        Preferences::set('bill_inbox_mailbox_host', $host);
        Preferences::set('bill_inbox_mailbox_port', $port);
        Preferences::set('bill_inbox_mailbox_encryption', $encryption);
        Preferences::set('bill_inbox_mailbox_username', $username);
        Preferences::set('bill_inbox_mailbox_folder', $folder);
        Preferences::set('bill_inbox_processing_rules', $this->channelRegistry->processingRules());
        Preferences::set('bill_inbox_quick_gmail_label', '');
        Preferences::set('bill_inbox_quick_keywords', '');

        if (array_key_exists('password', $validated) && '' !== (string) $validated['password']) {
            Preferences::setEncrypted('bill_inbox_mailbox_password', (string) $validated['password']);
        }
        Preferences::mark();

        return response()->json($this->settingsResponse());
    }

    public function sync(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);
        $limit     = (int) ($validated['limit'] ?? 25);
        $result    = $this->mailboxSyncService->syncForUser(auth()->user(), $limit);
        $processed = $this->taskProcessor->processBatch($limit, auth()->user());

        return response()->json([
            'data' => [
                'type'       => 'bill-inbox-sync-result',
                'attributes' => [
                    'scanned'        => $result->scanned,
                    'created'        => $result->created,
                    'ignored'        => $result->ignored,
                    'duplicates'     => $result->duplicates,
                    'failed'         => $result->failed,
                    'processed'      => $processed->processed,
                    'process_failed' => $processed->failed,
                    'errors'         => $result->errors,
                ],
            ],
        ]);
    }

    public function process(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:500'],
        ]);
        $result    = $this->taskProcessor->processBatch((int) ($validated['limit'] ?? 25), auth()->user());

        return response()->json([
            'data' => [
                'type'       => 'bill-inbox-process-result',
                'attributes' => [
                    'processed' => $result->processed,
                    'failed'    => $result->failed,
                ],
            ],
        ]);
    }

    public function cleanupStale(): JsonResponse
    {
        $archived = $this->actionService->cleanupStale(auth()->user());

        return response()->json([
            'data' => [
                'type'       => 'bill-inbox-cleanup-result',
                'attributes' => [
                    'archived' => $archived,
                ],
            ],
        ]);
    }

    /**
     * @return array{enabled:bool,provider:string,email:string,host:string,port:int,encryption:string,username:string,folder:string}
     */
    private function mailboxSettings(): array
    {
        return [
            'enabled'    => true === Preferences::get('bill_inbox_mailbox_enabled', false)->data,
            'provider'   => (string) Preferences::get('bill_inbox_mailbox_provider', 'gmail')->data,
            'email'      => (string) Preferences::get('bill_inbox_mailbox_email', '')->data,
            'host'       => (string) Preferences::get('bill_inbox_mailbox_host', 'imap.gmail.com')->data,
            'port'       => (int) Preferences::get('bill_inbox_mailbox_port', 993)->data,
            'encryption' => (string) Preferences::get('bill_inbox_mailbox_encryption', 'ssl')->data,
            'username'   => (string) Preferences::get('bill_inbox_mailbox_username', '')->data,
            'folder'     => (string) Preferences::get('bill_inbox_mailbox_folder', 'INBOX')->data,
        ];
    }

    /**
     * @return array<string,mixed>
     */
    private function settingsResponse(): array
    {
        $settings = $this->mailboxSettings();

        return [
            'data' => [
                'type'       => 'bill-inbox-settings',
                'attributes' => [
                    ...$settings,
                    'has_password'      => '' !== (string) Preferences::getEncrypted('bill_inbox_mailbox_password', '')->data,
                    'built_in_channels' => $this->channelRegistry->settingsChannels(),
                ],
            ],
        ];
    }
}
