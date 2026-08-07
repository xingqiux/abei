<?php

declare(strict_types=1);

namespace Tests\integration\Services\BillIngestion;

use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillMailboxSyncResult;
use FireflyIII\Services\BillIngestion\BillMailboxSyncService;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use FireflyIII\Services\BillIngestion\ImapBillMailboxClient;
use FireflyIII\Support\Facades\Preferences;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Override;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Services\BillIngestion\BillMailboxConfig
 * @covers \FireflyIII\Services\BillIngestion\BillMailboxSyncResult
 * @covers \FireflyIII\Services\BillIngestion\BillMailboxSyncService
 */
final class BillMailboxSyncServiceTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    public function testBuiltInChannelsExposeMailboxSearchCriteriaThroughRegistry(): void
    {
        $registryClass = 'FireflyIII\Services\BillIngestion\BillSourceChannelRegistry';
        $channelClass  = 'FireflyIII\Services\BillIngestion\Channels\AlipayBillSourceChannel';

        $this->assertTrue(class_exists($registryClass));
        $this->assertTrue(class_exists($channelClass));

        $registry = app($registryClass);

        $this->assertSame([
            'FROM "service@mail.alipay.com"',
            'FROM "wechatpay@tencent.com"',
            'FROM "95555@message.cmbchina.com"',
            'FROM "ccsvc@message.cmbchina.com" SUBJECT "每日信用管家"',
            'X-GM-RAW "filename:pdf"',
            'SUBJECT "中国银行交易流水"',
        ], $registry->mailboxSearchCriteria());
        $this->assertSame('alipay', $registry->find('alipay', 'alipay-statement')?->source());
        $this->assertSame('wechat', $registry->find('wechat', 'wechat-pay-statement')?->source());
        $this->assertSame('cmb', $registry->find('cmb', 'cmb-transaction-statement')?->source());
        $this->assertSame('cmb', $registry->find('cmb', 'cmb-credit-card-daily')?->source());
        $this->assertSame('boc', $registry->find('boc', 'boc-transaction-statement')?->source());
    }

    public function testSyncCreatesAlipayTaskFromConfiguredGmailMailbox(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('42', $this->alipayRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertInstanceOf(BillMailboxSyncResult::class, $result);
        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->ignored);
        $this->assertSame(0, $result->duplicates);
        $this->assertSame(0, $result->failed);
        $this->assertSame(['INBOX'], $client->selectedFolders);
        $this->assertContains('FROM "service@mail.alipay.com"', $client->searches);
        $this->assertSame(['42'], $client->seenUids);

        $mail = BillMailMessage::query()->first();
        $this->assertSame('<alipay-statement-20260612@mail.alipay.com>', $mail->message_id);
        $this->assertSame('ziyufg@gmail.com', $mail->mailbox);
        $this->assertSame('service@mail.alipay.com', $mail->from_address);
        $this->assertSame('ziyufg@gmail.com', $mail->to_address);
        $this->assertSame('李昶乐的支付宝交易流水明细', $mail->subject);
        $this->assertSame('gmail:42', $mail->sync_cursor);
        $this->assertNotNull($mail->raw_path);
        Storage::disk('local')->assertExists($mail->raw_path);

        $task = BillTask::query()->first();
        $this->assertSame('alipay', $task->source);
        $this->assertSame('alipay-statement', $task->profile_id);
        $this->assertSame('received', $task->status);
        $this->assertSame($mail->id, $task->bill_mail_message_id);

        $artifact = BillArtifact::query()->first();
        $this->assertSame($task->id, $artifact->bill_task_id);
        $this->assertSame('zip', $artifact->kind);
        $this->assertSame('支付宝交易明细(20260601-20260612).zip', $artifact->filename);
        $this->assertTrue($artifact->encrypted);
        $this->assertSame('alipay_service_message', $artifact->metadata['password_source']);
        $this->assertNotNull($artifact->path);
        Storage::disk('local')->assertExists($artifact->path);
    }

    public function testSyncCreatesWechatTaskFromDownloadedLinkMail(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('88', $this->wechatRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->failed);
        $this->assertContains('FROM "wechatpay@tencent.com"', $client->searches);
        $this->assertSame(['88'], $client->seenUids);

        $mail = BillMailMessage::query()->first();
        $this->assertSame('<wechat-pay-statement-20260615@tencent.com>', $mail->message_id);
        $this->assertSame('wechatpay@tencent.com', $mail->from_address);
        $this->assertSame('微信支付-账单流水文件(20260515-20260615)', $mail->subject);
        $this->assertNotNull($mail->body_text_path);
        $this->assertNotNull($mail->body_html_path);
        Storage::disk('local')->assertExists($mail->body_text_path);
        Storage::disk('local')->assertExists($mail->body_html_path);

        $task = BillTask::query()->first();
        $this->assertSame('wechat', $task->source);
        $this->assertSame('wechat-pay-statement', $task->profile_id);
        $this->assertSame('received', $task->status);
        $this->assertSame('微信支付账单流水', $task->summary);
        $this->assertSame('2026-05-15', $task->metadata['statement_period']['start']);
        $this->assertSame('2026-06-15', $task->metadata['statement_period']['end']);
        $this->assertSame('wechat_pay_official_account', $task->metadata['password_source']);
        $this->assertSame('tenpay_download', $task->metadata['remote_file']['source']);
        $this->assertArrayNotHasKey('url', $task->metadata['remote_file']);
        $this->assertArrayNotHasKey('encrypted_file_data', $task->metadata['remote_file']);
    }

    public function testSyncCreatesCmbTaskFromEncryptedAttachmentMail(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('95', $this->cmbRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->failed);
        $this->assertContains('FROM "95555@message.cmbchina.com"', $client->searches);
        $this->assertSame(['95'], $client->seenUids);

        $mail = BillMailMessage::query()->first();
        $this->assertSame('<cmb-transaction-statement-20260616@cmbchina.com>', $mail->message_id);
        $this->assertSame('95555@message.cmbchina.com', $mail->from_address);
        $this->assertSame('招商银行交易流水', $mail->subject);
        $this->assertNotNull($mail->body_text_path);
        Storage::disk('local')->assertExists($mail->body_text_path);

        $task = BillTask::query()->first();
        $this->assertSame('cmb', $task->source);
        $this->assertSame('cmb-transaction-statement', $task->profile_id);
        $this->assertSame('received', $task->status);
        $this->assertSame('招商银行交易流水', $task->summary);
        $this->assertSame('cmb_app_statement_record', $task->metadata['password_source']);
        $this->assertSame('95555@message.cmbchina.com', $task->metadata['sender']);
        $this->assertSame('2026-06-16 17:44:37', $task->metadata['applied_at']);

        $artifact = BillArtifact::query()->first();
        $this->assertSame($task->id, $artifact->bill_task_id);
        $this->assertSame('zip', $artifact->kind);
        $this->assertStringEndsWith('.zip', (string) $artifact->filename);
        $this->assertTrue($artifact->encrypted);
        $this->assertSame('cmb_app_statement_record', $artifact->metadata['password_source']);
        $this->assertNotNull($artifact->path);
        Storage::disk('local')->assertExists($artifact->path);
    }

    public function testSyncParsesCmbCreditDailyHtmlWithoutSecret(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('96', $this->cmbCreditDailyRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);
        $batch  = app(BillTaskProcessor::class)->processBatch(10, $this->user);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->failed);
        $this->assertSame(1, $batch->processed);
        $this->assertSame(0, $batch->failed);
        $this->assertContains('FROM "ccsvc@message.cmbchina.com" SUBJECT "每日信用管家"', $client->searches);
        $this->assertSame(['96'], $client->seenUids);

        $mail = BillMailMessage::query()->firstOrFail();
        $this->assertSame('ccsvc@message.cmbchina.com', $mail->from_address);
        $this->assertSame('每日信用管家', $mail->subject);
        $this->assertNotNull($mail->body_html_path);
        $this->assertNull($mail->body_text_path);
        Storage::disk('local')->assertExists($mail->body_html_path);

        $task = BillTask::query()->firstOrFail();
        $this->assertSame('cmb', $task->source);
        $this->assertSame('cmb-credit-card-daily', $task->profile_id);
        $this->assertSame('parsed', $task->status);
        $this->assertSame(4, $task->metadata['parsed_row_count']);
        $this->assertNull($task->current_secret_challenge_id);
        $this->assertSame(0, $task->secretChallenges()->count());

        $artifact = $task->artifacts()->firstOrFail();
        $this->assertSame('html', $artifact->kind);
        $this->assertSame('cmb-credit-daily-20260804.html', $artifact->filename);
        $this->assertFalse($artifact->encrypted);
        $this->assertSame('mail_body', $artifact->metadata['source']);

        $import = $task->statementImports()->firstOrFail();
        $this->assertSame('cmb-credit-card-daily', $import->profile_id);
        $this->assertSame('2026-08-04', $import->period_start->toDateString());
        $this->assertSame('2026-08-04', $import->period_end->toDateString());
        $this->assertSame(4, $import->row_count);

        $rows = $task->statementRows()->orderBy('row_number')->get();
        $this->assertCount(4, $rows);
        $this->assertSame('2026-08-04 09:33:08', $rows[0]->occurred_at->format('Y-m-d H:i:s'));
        $this->assertSame('+08:00', $rows[0]->occurred_at->format('P'));
        $this->assertSame('9.75', (string) $rows[0]->amount);
        $this->assertSame('支出', $rows[0]->direction);
        $this->assertSame('withdrawal', $rows[0]->firefly_type);
        $this->assertSame('招商银行信用卡(1234)', $rows[0]->source_name);
        $this->assertSame('财付通-测试咖啡', $rows[0]->destination_name);
        $this->assertSame('2026-08-04 20:27:44', $rows[3]->occurred_at->format('Y-m-d H:i:s'));
        $this->assertSame('支付宝-测试水果店', $rows[3]->counterparty);

        $structuredData = json_encode([
            $task->metadata,
            $import->metadata,
            $rows->pluck('raw_data')->all(),
            $rows->pluck('metadata')->all(),
        ], JSON_UNESCAPED_UNICODE);
        $this->assertIsString($structuredData);
        $this->assertStringNotContainsString('积分余额', $structuredData);
        $this->assertStringNotContainsString('可用额度', $structuredData);
        $this->assertStringNotContainsString('points_balance', $structuredData);
        $this->assertStringNotContainsString('available_credit', $structuredData);
    }

    public function testSyncCreatesBocTaskFromEncryptedPdfMailAndRequestsPassword(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('66', $this->bocRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);
        app(BillTaskProcessor::class)->processBatch(10, $this->user);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->failed);
        $this->assertContains('SUBJECT "中国银行交易流水"', $client->searches);
        $this->assertSame(['66'], $client->seenUids);

        $mail = BillMailMessage::query()->first();
        $this->assertSame('<boc-statement-20260617@mail.example>', $mail->message_id);
        $this->assertSame('service@bank-of-china.example', $mail->from_address);
        $this->assertSame('中国银行交易流水', $mail->subject);
        $this->assertNotNull($mail->body_text_path);
        Storage::disk('local')->assertExists($mail->body_text_path);

        $task = BillTask::query()->where('source', 'boc')->first();
        $this->assertInstanceOf(BillTask::class, $task);
        $this->assertSame('boc-transaction-statement', $task->profile_id);
        $this->assertSame('needs_secret', $task->status);
        $this->assertSame('中国银行交易流水', $task->summary);
        $this->assertSame('boc_app_statement_record', $task->metadata['password_source']);
        $this->assertSame('service@bank-of-china.example', $task->metadata['sender']);
        $this->assertSame('请输入中国银行APP“交易流水打印”申请记录中的打开密码', $task->currentSecretChallenge->prompt);

        $artifact = BillArtifact::query()->first();
        $this->assertSame($task->id, $artifact->bill_task_id);
        $this->assertSame('pdf', $artifact->kind);
        $this->assertSame('KA020003687d1a432d8001.pdf', $artifact->filename);
        $this->assertTrue($artifact->encrypted);
        $this->assertSame('boc_app_statement_record', $artifact->metadata['password_source']);
        $this->assertNotNull($artifact->path);
        Storage::disk('local')->assertExists($artifact->path);
    }

    public function testSyncFindsBocPdfMailWhenChineseSubjectSearchDoesNotReturnUid(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient(
            [new FakeImapMailMessage('66', $this->bocRawMessage())],
            [],
            [
                'X-GM-RAW "filename:pdf"' => ['66'],
                'SUBJECT "中国银行交易流水"'   => [],
            ],
        );
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertContains('X-GM-RAW "filename:pdf"', $client->searches);
        $this->assertContains('SUBJECT "中国银行交易流水"', $client->searches);
        $this->assertSame(1, BillTask::query()->where('source', 'boc')->count());
    }

    public function testSyncContinuesWhenMailboxDoesNotSupportOneSearchCriterion(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient(
            [new FakeImapMailMessage('66', $this->bocRawMessage())],
            [],
            ['SUBJECT "中国银行交易流水"' => ['66']],
            ['X-GM-RAW "filename:pdf"'],
        );
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->failed);
        $this->assertSame(1, BillTask::query()->where('source', 'boc')->count());
    }

    public function testSyncSkipsDuplicateMessages(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('42', $this->alipayRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        BillMailMessage::query()->create([
            'user_id'     => $this->user->id,
            'message_id'  => '<alipay-statement-20260612@mail.alipay.com>',
            'mailbox'     => 'ziyufg@gmail.com',
            'subject'     => '李昶乐的支付宝交易流水明细',
            'sync_cursor' => 'gmail:42',
        ]);

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->scanned);
        $this->assertSame(0, $result->created);
        $this->assertSame(1, $result->duplicates);
        $this->assertSame(1, BillMailMessage::query()->count());
        $this->assertSame(0, BillTask::query()->count());
        $this->assertSame([], $client->seenUids);
    }

    public function testBuiltInAlipayChannelIgnoresConfiguredGmailLabelAndUsesInbox(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('42', $this->alipayRawMessage()),
        ], ['buii']);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox(quickLabel: 'buii');

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->created);
        $this->assertSame(0, $result->failed);
        $this->assertSame([], $result->errors);
        $this->assertSame(['INBOX'], $client->selectedFolders);
        $this->assertContains('FROM "service@mail.alipay.com"', $client->searches);
        $this->assertContains('FROM "wechatpay@tencent.com"', $client->searches);
        $this->assertContains('FROM "95555@message.cmbchina.com"', $client->searches);
        $this->assertContains('FROM "ccsvc@message.cmbchina.com" SUBJECT "每日信用管家"', $client->searches);
        $this->assertContains('X-GM-RAW "filename:pdf"', $client->searches);
        $this->assertContains('SUBJECT "中国银行交易流水"', $client->searches);
    }

    public function testBuiltInAlipayChannelDoesNotDependOnCustomProcessingRules(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('42', $this->alipayRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox(quickLabel: 'buii');
        Preferences::set('bill_inbox_processing_rules', [[
            'enabled'          => true,
            'name'             => '自定义测试规则',
            'source'           => 'bank',
            'from_contains'    => 'bank@example.com',
            'subject_contains' => '信用卡账单',
            'gmail_label'      => 'buii',
        ]]);

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->created);
        $this->assertSame(['INBOX'], $client->selectedFolders);
        $this->assertContains('FROM "service@mail.alipay.com"', $client->searches);
        $this->assertContains('FROM "wechatpay@tencent.com"', $client->searches);
        $this->assertContains('FROM "95555@message.cmbchina.com"', $client->searches);
        $this->assertContains('FROM "ccsvc@message.cmbchina.com" SUBJECT "每日信用管家"', $client->searches);
        $this->assertContains('X-GM-RAW "filename:pdf"', $client->searches);
        $this->assertContains('SUBJECT "中国银行交易流水"', $client->searches);
    }

    public function testSyncDoesNothingWhenMailboxIsDisabled(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('42', $this->alipayRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox(false);

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(0, $result->scanned);
        $this->assertSame(0, $result->created);
        $this->assertFalse($client->connected);
        $this->assertSame(0, BillMailMessage::query()->count());
    }

    public function testEnabledMailboxWithMissingPasswordReportsFailure(): void
    {
        $client = new FakeImapBillMailboxClient([]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();
        Preferences::set('bill_inbox_mailbox_password', '');

        $result = app(BillMailboxSyncService::class)->syncForUser($this->user, 10);

        $this->assertSame(1, $result->failed);
        $this->assertSame(['邮箱已启用，但登录信息不完整；请重新保存邮箱密码。'], $result->errors);
        $this->assertFalse($client->connected);
    }

    public function testArtisanCommandRunsMailboxSync(): void
    {
        Storage::fake('local');
        $client = new FakeImapBillMailboxClient([
            new FakeImapMailMessage('42', $this->alipayRawMessage()),
        ]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();

        $this->artisan('firefly-iii:sync-bill-mailbox', [
            '--user'  => (string) $this->user->id,
            '--limit' => '10',
        ])->expectsOutputToContain('Scanned 1 mail message')
            ->assertExitCode(0)
        ;

        $this->assertSame(1, BillTask::query()->where('source', 'alipay')->count());
    }

    public function testArtisanCommandFailsForIncompleteEnabledMailbox(): void
    {
        $client = new FakeImapBillMailboxClient([]);
        $this->app->instance(ImapBillMailboxClient::class, $client);
        $this->configureMailbox();
        Preferences::set('bill_inbox_mailbox_password', '');

        $this->artisan('firefly-iii:sync-bill-mailbox', ['--user' => (string) $this->user->id])
            ->expectsOutputToContain('邮箱已启用，但登录信息不完整')
            ->assertExitCode(1)
        ;
    }

    #[Override]
    protected function setUp(): void
    {
        parent::setUp();

        $this->user = $this->createAuthenticatedUser();
    }

    private function configureMailbox(bool $enabled = true, string $quickLabel = ''): void
    {
        $this->actingAs($this->user);

        Preferences::set('bill_inbox_mailbox_enabled', $enabled);
        Preferences::set('bill_inbox_mailbox_provider', 'gmail');
        Preferences::set('bill_inbox_mailbox_email', 'ziyufg@gmail.com');
        Preferences::set('bill_inbox_mailbox_host', 'imap.gmail.com');
        Preferences::set('bill_inbox_mailbox_port', 993);
        Preferences::set('bill_inbox_mailbox_encryption', 'ssl');
        Preferences::set('bill_inbox_mailbox_username', 'ziyufg@gmail.com');
        Preferences::setEncrypted('bill_inbox_mailbox_password', 'gmail-app-password');
        Preferences::set('bill_inbox_mailbox_folder', 'INBOX');
        Preferences::set('bill_inbox_quick_gmail_label', $quickLabel);
        Preferences::set('bill_inbox_quick_keywords', '支付宝, 交易流水');
        Preferences::set('bill_inbox_processing_rules', [[
            'enabled'          => true,
            'name'             => '支付宝交易流水',
            'source'           => 'alipay',
            'from_contains'    => 'service@mail.alipay.com',
            'subject_contains' => '支付宝交易流水明细',
            'gmail_label'      => '',
            'keywords'         => ['支付宝', '交易流水'],
        ]]);
    }

    private function alipayRawMessage(): string
    {
        $email = (new \Symfony\Component\Mime\Email())
            ->from('支付宝提醒 <service@mail.alipay.com>')
            ->to('ziyufg@gmail.com')
            ->subject('李昶乐的支付宝交易流水明细')
            ->date(new \DateTimeImmutable('2026-06-12 18:26:00 +0800'))
            ->text('附件已加密，解压密码已通过支付宝服务消息发送。')
            ->attach('encrypted zip bytes', '支付宝交易明细(20260601-20260612).zip', 'application/zip')
        ;
        $email->getHeaders()->addIdHeader('Message-ID', 'alipay-statement-20260612@mail.alipay.com');

        return $email->toString();
    }

    private function wechatRawMessage(): string
    {
        $downloadUrl = 'https://tenpay.wechatpay.cn/userroll/userbilldownload/downloadfilefromemail?encrypted_file_data=encrypted-token-123';
        $text        = <<<TEXT
你好，

微信用户 x******ux 申请的微信支付账单流水文件(20260515-20260615)已生成，请下载查阅（若手机无法下载，请在电脑端下载）。基于安全考虑，文件已加密。
解压密码已通过【微信支付】公众号发送至申请人微信。
如非本人操作，请忽略。
点击下载 {$downloadUrl}
7天内有效
TEXT;
        $html        = <<<HTML
<html><body>
<p>你好，</p>
<p>微信用户 x******ux 申请的微信支付账单流水文件(20260515-20260615)已生成，请下载查阅（若手机无法下载，请在电脑端下载）。基于安全考虑，文件已加密。</p>
<p>解压密码已通过【微信支付】公众号发送至申请人微信。</p>
<a href="{$downloadUrl}">点击下载</a>
<p>7天内有效</p>
</body></html>
HTML;

        $email = (new \Symfony\Component\Mime\Email())
            ->from('微信支付 <wechatpay@tencent.com>')
            ->to('ziyufg@gmail.com')
            ->subject('微信支付-账单流水文件(20260515-20260615)')
            ->date(new \DateTimeImmutable('2026-06-15 19:14:00 +0800'))
            ->text($text)
            ->html($html)
        ;
        $email->getHeaders()->addIdHeader('Message-ID', 'wechat-pay-statement-20260615@tencent.com');

        return $email->toString();
    }

    private function cmbRawMessage(): string
    {
        $text = <<<TEXT
尊敬的李昶乐：

您好！附件是您2026年06月16日17:44:37通过招商银行App申请的电子版交易流水，请查收。

基于安全考虑，附件已加密，解压码请通过“招商银行App-流水打印-申请记录“查询，如您存在多条申请记录，请使用与本条记录申请时间对应的解压码解压。

温馨提示：您下载的是压缩文件，建议从电脑端解压查阅。

招商银行
2026年06月16日
TEXT;

        $email = (new \Symfony\Component\Mime\Email())
            ->from('招商银行 <95555@message.cmbchina.com>')
            ->to('ziyufg@gmail.com')
            ->subject('招商银行交易流水')
            ->date(new \DateTimeImmutable('2026-06-16 17:45:00 +0800'))
            ->text($text)
            ->attach('cmb encrypted zip bytes', '交易流水(申请时间2026年06月16日17时44分37秒).zip', 'application/zip')
        ;
        $email->getHeaders()->addIdHeader('Message-ID', 'cmb-transaction-statement-20260616@cmbchina.com');

        return $email->toString();
    }

    private function cmbCreditDailyRawMessage(): string
    {
        $html = <<<'HTML'
<html><body>
<table>
<tr><td>尊敬的客户，截至昨日最后一笔交易，您的额度和积分信息如下：</td></tr>
<tr><td>可用额度</td><td>￥16,841.25</td><td>积分余额</td><td>109</td></tr>
<tr><td>2026/08/04 您的消费明细如下：</td></tr>
<tr><td>09:33:08</td><td>CNY 9.75</td><td>尾号1234 消费 财付通-测试咖啡</td></tr>
<tr><td>17:42:58</td><td>CNY 27.00</td><td>尾号1234 消费 支付宝-测试餐饮公司</td></tr>
<tr><td>20:13:26</td><td>CNY 8.80</td><td>尾号1234 消费 支付宝-测试便利店</td></tr>
<tr><td>20:27:44</td><td>CNY 12.20</td><td>尾号1234 消费 支付宝-测试水果店</td></tr>
</table>
</body></html>
HTML;
        $boundary = '----=_Part_cmb_credit_daily_test';
        $headers  = [
            'From: CMB Credit Card <ccsvc@message.cmbchina.com>',
            'To: bills@example.test',
            'Subject: =?UTF-8?B?'.base64_encode('每日信用管家').'?=',
            'Date: Wed, 05 Aug 2026 16:19:48 +0800',
            'Message-ID: <cmb-credit-daily-20260805@cmbchina.test>',
            'MIME-Version: 1.0',
            sprintf('Content-Type: multipart/mixed; boundary="%s"', $boundary),
            '',
            '--'.$boundary,
            'Content-Type: text/html; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            rtrim(chunk_split(base64_encode($html), 76, "\r\n")),
            '--'.$boundary.'--',
            '',
        ];

        return implode("\r\n", $headers);
    }

    private function bocRawMessage(): string
    {
        $text = <<<TEXT
尊敬的用户：

您好！附件是您通过中国银行APP申请的电子版交易流水，请查收。

基于安全考虑，附件已加密，打开密码请在中国银行APP“交易流水打印”功能的申请记录中查询。如果您存有对应的打开密码打开。
TEXT;

        $email = (new \Symfony\Component\Mime\Email())
            ->from('中国银行 <service@bank-of-china.example>')
            ->to('ziyufg@gmail.com')
            ->subject('中国银行交易流水')
            ->date(new \DateTimeImmutable('2026-06-17 16:44:00 +0800'))
            ->text($text)
            ->attach('encrypted pdf bytes', 'KA020003687d1a432d8001.pdf', 'application/pdf')
        ;
        $email->getHeaders()->addIdHeader('Message-ID', 'boc-statement-20260617@mail.example');

        return $email->toString();
    }
}
