<?php

declare(strict_types=1);

namespace Tests\integration\Api\Models\BillTask;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillSecretChallenge;
use FireflyIII\Models\BillStatementImport;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Models\BillTaskEvent;
use FireflyIII\Models\Account;
use FireflyIII\Models\AccountType;
use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\TransactionGroup;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\Repositories\TransactionGroup\TransactionGroupRepository;
use FireflyIII\Repositories\TransactionGroup\TransactionGroupRepositoryInterface;
use FireflyIII\Support\Facades\Preferences;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Override;
use RuntimeException;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\Models\BillTask\ActionController
 * @covers \FireflyIII\Api\V1\Controllers\Models\BillTask\BillInboxController
 * @covers \FireflyIII\Api\V1\Controllers\Models\BillTask\ListController
 * @covers \FireflyIII\Api\V1\Controllers\Models\BillTask\ShowController
 */
final class BillTaskControllerTest extends TestCase
{
    use RefreshDatabase;

    private User $user;
    private BillTask $task;

    public function testIndexListsCurrentUsersBillTasks(): void
    {
        $otherUser = $this->createUser('other-bills@example.com');
        BillTask::query()->create([
            'user_id'       => $otherUser->id,
            'source'        => 'alipay',
            'status'        => 'received',
            'received_at'   => Carbon::parse('2026-06-10 11:00:00', 'Asia/Shanghai'),
            'summary'       => '其他用户账单',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->getJson(route('api.v1.bill-tasks.index'));

        $response->assertStatus(200);
        $response->assertJsonPath('meta.pagination.total', 1);
        $response->assertJsonPath('data.0.id', (string) $this->task->id);
        $response->assertJsonPath('data.0.attributes.source', 'cmb');
        $response->assertJsonPath('data.0.attributes.status', 'needs_secret');
    }

    public function testIndexFiltersBillTasksBySourceAndStatus(): void
    {
        $alipay = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'parsed',
            'received_at' => Carbon::parse('2026-06-12 18:26:00', 'Asia/Shanghai'),
            'summary'     => '支付宝交易流水',
        ]);
        BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'needs_secret',
            'received_at' => Carbon::parse('2026-06-11 18:26:00', 'Asia/Shanghai'),
            'summary'     => '未解析支付宝交易流水',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->getJson(route('api.v1.bill-tasks.index', [
            'source' => 'alipay',
            'status' => 'parsed',
        ]));

        $response->assertStatus(200);
        $response->assertJsonPath('meta.pagination.total', 1);
        $response->assertJsonPath('data.0.id', (string) $alipay->id);
        $response->assertJsonPath('data.0.attributes.source', 'alipay');
        $response->assertJsonPath('data.0.attributes.status', 'parsed');
    }

    public function testIndexAndShowExposeRowCountsPerTask(): void
    {
        $transactionGroup = $this->createTransactionGroup();
        $pending   = $this->createStatementRow();
        $duplicate = $this->createStatementRow([
            'row_number'        => 2,
            'status'            => 'pending',
            'duplicate_state'   => 'duplicate',
            'platform_order_no' => 'row-counts-duplicate-0001',
            'merchant_order_no' => 'row-counts-duplicate-merchant-0001',
            'external_key'      => 'alipay:order:row-counts-duplicate-0001',
            'fingerprint'       => 'fp-row-counts-duplicate',
        ]);
        $imported  = $this->createStatementRow([
            'row_number'        => 3,
            'status'            => 'imported',
            'transaction_group_id' => $transactionGroup->id,
            'platform_order_no' => 'row-counts-imported-0001',
            'merchant_order_no' => 'row-counts-imported-merchant-0001',
            'external_key'      => 'alipay:order:row-counts-imported-0001',
            'fingerprint'       => 'fp-row-counts-imported',
        ]);

        $this->actingAs($this->user, 'api');

        $index = $this->getJson(route('api.v1.bill-tasks.index'));
        $index->assertStatus(200);
        $index->assertJsonPath('data.0.attributes.row_counts.total', 3);
        $index->assertJsonPath('data.0.attributes.row_counts.pending', 2);
        $index->assertJsonPath('data.0.attributes.row_counts.imported', 1);
        $index->assertJsonPath('data.0.attributes.row_counts.duplicate', 1);
        $index->assertJsonPath('data.0.attributes.row_counts.conflict', 0);

        $show = $this->getJson(route('api.v1.bill-tasks.show', ['billTask' => $this->task->id]));
        $show->assertStatus(200);
        $show->assertJsonPath('data.attributes.row_counts.total', 3);
        $show->assertJsonPath('data.attributes.row_counts.pending', 2);
        $show->assertJsonPath('data.attributes.row_counts.imported', 1);
        $show->assertJsonPath('data.attributes.row_counts.duplicate', 1);

        unset($pending, $duplicate, $imported);
    }

    public function testEntryEndpointsRequireAuthentication(): void
    {
        // setUp() already calls actingAs() for the happy-path tests in this class;
        // forget the resolved guards so these requests hit the controllers unauthenticated.
        $this->app['auth']->forgetGuards();

        $index = $this->get(route('api.v1.bill-tasks.index'), ['Accept' => 'application/json']);
        $index->assertStatus(401);

        $show = $this->get(route('api.v1.bill-tasks.show', ['billTask' => $this->task->id]), ['Accept' => 'application/json']);
        $show->assertStatus(401);

        $import = $this->post(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [], ['Accept' => 'application/json']);
        $import->assertStatus(401);

        $ignore = $this->post(route('api.v1.bill-tasks.ignore', ['billTask' => $this->task->id]), [], ['Accept' => 'application/json']);
        $ignore->assertStatus(401);
    }

    public function testShowIncludesMailArtifactsEventsAndCurrentChallenge(): void
    {
        $this->actingAs($this->user, 'api');
        $response = $this->getJson(route('api.v1.bill-tasks.show', ['billTask' => $this->task->id]));

        $response->assertStatus(200);
        $response->assertJsonPath('data.id', (string) $this->task->id);
        $response->assertJsonPath('included.0.type', 'bill-mail-messages');
        $response->assertJsonPath('included.1.type', 'bill-artifacts');
        $response->assertJsonPath('included.2.type', 'bill-secret-challenges');
        $response->assertJsonPath('included.3.type', 'bill-task-events');
    }

    public function testApiRedactsWechatRemoteDownloadTokensFromMetadata(): void
    {
        $downloadUrl = 'https://tenpay.wechatpay.cn/userroll/userbilldownload/downloadfilefromemail?encrypted_file_data=secret-token-123';

        $task = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'wechat',
            'profile_id'  => 'wechat-pay-statement',
            'status'      => 'needs_secret',
            'received_at' => Carbon::parse('2026-06-15 19:14:00', 'Asia/Shanghai'),
            'summary'     => '微信支付账单流水',
            'metadata'    => [
                'remote_file' => [
                    'status'              => 'pending',
                    'url'                 => $downloadUrl,
                    'encrypted_file_data' => 'secret-token-123',
                    'storage_path'        => '/srv/private/wechat.zip',
                    'access_token'        => 'access-token-456',
                    'password_hint'       => 'private-password-hint',
                    'host'                => 'tenpay.wechatpay.cn',
                ],
            ],
        ]);

        BillArtifact::query()->create([
            'bill_task_id' => $task->id,
            'kind'         => 'zip',
            'filename'     => 'wechat-pay-statement.zip',
            'path'         => 'bill-inbox/1/remote/wechat-pay-statement.zip',
            'checksum'     => 'wechat-artifact-checksum',
            'encrypted'    => true,
            'metadata'     => [
                'source'      => 'remote_download',
                'remote_file' => [
                    'url'                 => $downloadUrl,
                    'encrypted_file_data' => 'secret-token-123',
                    'temporary_path'      => 'bill-inbox/1/private/wechat.zip',
                    'download_token'      => 'download-token-789',
                ],
            ],
        ]);

        $task->events()->create([
            'event_type' => 'remote_file.pending',
            'message'    => '等待下载',
            'metadata'   => [
                'safe_status' => 'pending',
                'request_url' => $downloadUrl,
                'api_secret'  => 'event-secret-321',
            ],
        ]);

        $this->actingAs($this->user, 'api');

        $show = $this->getJson(route('api.v1.bill-tasks.show', ['billTask' => $task->id]));
        $show->assertStatus(200);
        $show->assertJsonPath('data.attributes.metadata.remote_file.status', 'pending');
        $show->assertJsonPath('data.attributes.metadata.remote_file.host', 'tenpay.wechatpay.cn');
        $show->assertJsonMissingPath('data.attributes.metadata.remote_file.url');
        $show->assertJsonMissingPath('data.attributes.metadata.remote_file.encrypted_file_data');
        $show->assertJsonMissingPath('data.attributes.metadata.remote_file.storage_path');
        $show->assertJsonMissingPath('data.attributes.metadata.remote_file.access_token');
        $show->assertJsonMissingPath('data.attributes.metadata.remote_file.password_hint');

        $artifacts = $this->getJson(route('api.v1.bill-tasks.artifacts', ['billTask' => $task->id]));
        $artifacts->assertStatus(200);
        $artifacts->assertJsonMissingPath('data.0.attributes.metadata.remote_file.url');
        $artifacts->assertJsonMissingPath('data.0.attributes.metadata.remote_file.encrypted_file_data');
        $artifacts->assertJsonMissingPath('data.0.attributes.metadata.remote_file.temporary_path');
        $artifacts->assertJsonMissingPath('data.0.attributes.metadata.remote_file.download_token');

        $events = $this->getJson(route('api.v1.bill-tasks.events', ['billTask' => $task->id]));
        $events->assertOk();
        $events->assertJsonPath('data.0.attributes.metadata.safe_status', 'pending');
        $events->assertJsonMissingPath('data.0.attributes.metadata.request_url');
        $events->assertJsonMissingPath('data.0.attributes.metadata.api_secret');

        $this->assertStringNotContainsString('secret-token-123', $show->getContent());
        $this->assertStringNotContainsString('encrypted_file_data', $show->getContent());
        $this->assertStringNotContainsString('downloadfilefromemail', $show->getContent());
        $this->assertStringNotContainsString('secret-token-123', $artifacts->getContent());
        $this->assertStringNotContainsString('encrypted_file_data', $artifacts->getContent());
        $this->assertStringNotContainsString('downloadfilefromemail', $artifacts->getContent());
        $this->assertStringNotContainsString('/srv/private', $show->getContent());
        $this->assertStringNotContainsString('access-token-456', $show->getContent());
        $this->assertStringNotContainsString('download-token-789', $artifacts->getContent());
        $this->assertStringNotContainsString('event-secret-321', $events->getContent());
    }

    public function testListsArtifactsAndEvents(): void
    {
        $this->actingAs($this->user, 'api');

        $artifacts = $this->getJson(route('api.v1.bill-tasks.artifacts', ['billTask' => $this->task->id]));
        $artifacts->assertStatus(200);
        $artifacts->assertJsonPath('data.0.type', 'bill-artifacts');
        $artifacts->assertJsonPath('data.0.attributes.filename', 'statement.zip');
        $artifacts->assertJsonPath('data.0.attributes.mime_type', 'application/zip');
        $artifacts->assertJsonPath('data.0.attributes.size', 1234);
        $artifacts->assertJsonPath('data.0.attributes.generation_stage', 'received');

        $events = $this->getJson(route('api.v1.bill-tasks.events', ['billTask' => $this->task->id]));
        $events->assertStatus(200);
        $events->assertJsonPath('data.0.type', 'bill-task-events');
        $events->assertJsonPath('data.0.attributes.event_type', 'task.created');
    }

    public function testDoesNotExposeInternalBocTextExtractionArtifact(): void
    {
        $original = $this->task->artifacts()->firstOrFail();
        $internal = BillArtifact::query()->create([
            'bill_task_id'              => $this->task->id,
            'derived_from_artifact_id'  => $original->id,
            'kind'                      => 'txt',
            'filename'                  => 'statement.txt',
            'path'                      => 'artifacts/internal/task-1/statement.txt',
            'checksum'                  => 'internal-text-checksum',
            'encrypted'                 => false,
            'metadata'                  => [
                'source'   => 'boc_pdf_text_extract',
                'internal' => true,
            ],
        ]);

        $list = $this->getJson(route('api.v1.bill-tasks.artifacts', ['billTask' => $this->task->id]));
        $list->assertStatus(200);
        $list->assertJsonCount(1, 'data');
        $list->assertJsonPath('data.0.attributes.filename', 'statement.zip');
        $list->assertJsonMissingPath('data.1');
        $this->assertStringNotContainsString('statement.txt', $list->getContent());

        $show = $this->getJson(route('api.v1.bill-tasks.show', ['billTask' => $this->task->id]));
        $show->assertStatus(200);
        $this->assertStringNotContainsString('statement.txt', $show->getContent());

        Storage::fake('local');
        Storage::disk('local')->put((string) $internal->path, 'internal text');
        $download = $this->get(route('api.v1.bill-artifacts.download', ['billArtifact' => $internal->id]));
        $download->assertStatus(404);
    }

    public function testSecretSubmitConsumesChallengeAndMarksTaskReady(): void
    {
        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.secret', ['billTask' => $this->task->id]), [
            'value' => '123456',
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('data.attributes.status', 'ready');
        $this->assertStringNotContainsString('123456', $response->getContent());

        $this->task->refresh();
        $this->assertSame('ready', $this->task->status);
        $this->assertNull($this->task->current_secret_challenge_id);
        $this->assertSame('consumed', $this->task->secretChallenges()->first()->status);
        $this->assertSame(1, $this->task->secretChallenges()->first()->attempts);
        $this->assertSame('challenge.consumed', $this->task->events()->latest('id')->first()->event_type);
    }

    public function testIgnoreAndRetryMoveTaskState(): void
    {
        $this->actingAs($this->user, 'api');

        $ignored = $this->postJson(route('api.v1.bill-tasks.ignore', ['billTask' => $this->task->id]));
        $ignored->assertStatus(200);
        $ignored->assertJsonPath('data.attributes.status', 'ignored');

        $retried = $this->postJson(route('api.v1.bill-tasks.retry', ['billTask' => $this->task->id]));
        $retried->assertStatus(200);
        $retried->assertJsonPath('data.attributes.status', 'unknown');

        $this->task->refresh();
        $this->assertSame('unknown', $this->task->status);
        $this->assertSame('task.unknown', $this->task->events()->latest('id')->first()->event_type);
    }

    public function testRejectsBlankSecret(): void
    {
        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.secret', ['billTask' => $this->task->id]), [
            'value' => '',
        ]);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors(['value']);
    }

    public function testListsAndUpdatesStatementRows(): void
    {
        $row = $this->createStatementRow();

        $this->actingAs($this->user, 'api');
        $list = $this->getJson(route('api.v1.bill-tasks.rows', ['billTask' => $this->task->id, 'status' => 'pending']));
        $list->assertStatus(200);
        $list->assertJsonPath('data.0.type', 'bill-statement-rows');
        $list->assertJsonPath('data.0.id', (string) $row->id);
        $list->assertJsonPath('data.0.attributes.counterparty', '中国联通');

        $show = $this->getJson(route('api.v1.bill-statement-rows.show', ['billStatementRow' => $row->id]));
        $show->assertStatus(200);
        $show->assertJsonPath('data.id', (string) $row->id);
        $show->assertJsonPath('data.attributes.platform_order_no', '2026061522001414871443694067');
        $show->assertJsonPath('data.attributes.external_key', 'alipay:order:2026061522001414871443694067');
        $show->assertJsonPath('data.attributes.fingerprint', 'fp-existing-row');
        $show->assertJsonPath('data.attributes.duplicate_state', 'unique');
        $show->assertJsonPath('data.attributes.duplicate_of_row_id', null);
        $show->assertJsonPath('data.attributes.user_modified_at', null);

        $updated = $this->patchJson(route('api.v1.bill-statement-rows.update', ['billStatementRow' => $row->id]), [
            'counterparty'        => '中国联通线上营业厅',
            'firefly_description' => '手机充值',
            'source_name'         => '招商银行',
            'destination_name'    => '中国联通',
            'category_name'       => '通讯',
        ]);
        $updated->assertStatus(200);
        $updated->assertJsonPath('data.attributes.counterparty', '中国联通线上营业厅');
        $updated->assertJsonPath('data.attributes.firefly_description', '手机充值');

        $row->refresh();
        $this->assertSame('中国联通线上营业厅', $row->counterparty);
        $this->assertSame('中国联通线上营业厅', $row->editable_data['交易对方']);
        $this->assertSame('手机充值', $row->firefly_description);
        $this->assertNotNull($row->user_modified_at);
        $updated->assertJsonPath('data.attributes.user_modified_at', $row->user_modified_at->toAtomString());
    }

    public function testUpdateRowForBillInboxReturnsCompleteDraftJsonAndValidatesFields(): void
    {
        $row = $this->createStatementRow();

        $this->actingAs($this->user, 'api');

        $updated = $this->patchJson(route('api.v1.bill-statement-rows.update', ['billStatementRow' => $row->id]), [
            'firefly_type'         => 'deposit',
            'firefly_date'         => '2026-06-15 18:00:00',
            'firefly_amount'       => '25.75',
            'firefly_description'  => '话费充值',
            'source_name'          => '招商银行',
            'destination_name'     => '中国联通',
            'category_name'        => '通讯',
            'notes'                => '人工复核备注',
        ]);

        $updated->assertStatus(200);
        // the response must carry the full statement-row resource so the row-editor
        // can refresh every displayed field (both the read-only original values and
        // the just-saved Firefly draft) without a second round-trip.
        $updated->assertJsonStructure([
            'data' => [
                'id',
                'attributes' => [
                    'status', 'duplicate_state', 'occurred_at', 'counterparty', 'platform_category',
                    'description', 'direction', 'amount', 'payment_method', 'transaction_status',
                    'firefly_type', 'firefly_date', 'firefly_amount', 'firefly_description',
                    'source_name', 'destination_name', 'category_name', 'notes',
                ],
            ],
        ]);
        $updated->assertJsonPath('data.id', (string) $row->id);
        $updated->assertJsonPath('data.attributes.status', 'pending');
        $updated->assertJsonPath('data.attributes.duplicate_state', 'unique');
        $updated->assertJsonPath('data.attributes.firefly_type', 'deposit');
        $updated->assertJsonPath('data.attributes.firefly_amount', '25.75');
        $updated->assertJsonPath('data.attributes.firefly_description', '话费充值');
        $updated->assertJsonPath('data.attributes.source_name', '招商银行');
        $updated->assertJsonPath('data.attributes.destination_name', '中国联通');
        $updated->assertJsonPath('data.attributes.category_name', '通讯');
        $updated->assertJsonPath('data.attributes.notes', '人工复核备注');
        // untouched original fields must still be present in the same payload.
        $updated->assertJsonPath('data.attributes.counterparty', '中国联通');
        $updated->assertJsonPath('data.attributes.platform_category', '充值缴费');
        $updated->assertJsonPath('data.attributes.direction', '支出');
        $updated->assertJsonPath('data.attributes.amount', '14.95');
        $updated->assertJsonPath('data.attributes.payment_method', '招商银行储蓄卡(8705)');
        $updated->assertJsonPath('data.attributes.transaction_status', '交易成功');

        $invalid = $this->patchJson(route('api.v1.bill-statement-rows.update', ['billStatementRow' => $row->id]), [
            'firefly_type'   => 'not-a-real-type',
            'firefly_amount' => 'not-a-number',
        ]);
        $invalid->assertStatus(422);
        $invalid->assertJsonValidationErrors(['firefly_type', 'firefly_amount']);

        $zero = $this->patchJson(route('api.v1.bill-statement-rows.update', ['billStatementRow' => $row->id]), [
            'amount'         => '0',
            'firefly_amount' => '0.00',
        ]);
        $zero->assertStatus(422);
        $zero->assertJsonValidationErrors(['amount', 'firefly_amount']);

        // a rejected update must not silently apply partial changes.
        $row->refresh();
        $this->assertSame('deposit', $row->firefly_type);
        $this->assertSame('25.75', (string) $row->firefly_amount);
    }

    public function testRowsSummaryReturnsCompactRedactedPreview(): void
    {
        $first = $this->createStatementRow([
            'description'            => '为15512345678交费20.00元',
            'firefly_description'    => '为15512345678交费20.00元',
            'platform_order_no'      => '2026061522001414871443694067',
            'merchant_order_no'      => 'CP0232671781515214344949',
            'counterparty_account'   => 'ah-15512345678@chinaunicom.cn',
        ]);
        $this->createStatementRow([
            'row_number'          => 2,
            'direction'           => '收入',
            'amount'              => '88.00',
            'firefly_type'        => 'deposit',
            'firefly_amount'      => '88.00',
            'source_name'         => '退款商户',
            'destination_name'    => '招商银行',
            'counterparty'        => '退款商户',
            'description'         => '订单2026061522001414871443694067退款',
            'platform_order_no'   => '2026061522001414871443694999',
            'merchant_order_no'   => 'CP0232671781515214999999',
            'external_key'        => 'alipay:order:2026061522001414871443694999',
            'fingerprint'         => 'fp-refund-row',
            'duplicate_state'     => 'duplicate',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->getJson(route('api.v1.bill-tasks.rows', [
            'billTask' => $this->task->id,
            'summary'  => true,
            'limit'    => 1,
        ]));

        $response->assertStatus(200);
        $response->assertJsonPath('summary.total', 2);
        $response->assertJsonPath('summary.by_status.pending', 2);
        $response->assertJsonPath('summary.by_direction.支出', 1);
        $response->assertJsonPath('summary.by_direction.收入', 1);
        $response->assertJsonPath('summary.by_firefly_type.withdrawal', 1);
        $response->assertJsonPath('summary.by_firefly_type.deposit', 1);
        $response->assertJsonPath('summary.by_duplicate_state.unique', 1);
        $response->assertJsonPath('summary.by_duplicate_state.duplicate', 1);
        $response->assertJsonPath('summary.amounts.expense', '14.95');
        $response->assertJsonPath('summary.amounts.income', '88.00');
        $response->assertJsonPath('summary.amounts.net', '73.05');
        $response->assertJsonPath('data.0.row_id', (string) $first->id);
        $response->assertJsonPath('data.0.description_preview', '为15****78交费20.00元');
        $response->assertJsonMissingPath('data.0.platform_order_no');
        $response->assertJsonMissingPath('data.0.merchant_order_no');
        $response->assertJsonMissingPath('data.0.counterparty_account');
        $response->assertJsonMissingPath('data.0.raw_data');
        $response->assertJsonMissingPath('data.0.editable_data');
        $this->assertStringNotContainsString('2026061522001414871443694067', $response->getContent());
        $this->assertStringNotContainsString('CP0232671781515214344949', $response->getContent());
        $this->assertStringNotContainsString('15512345678', $response->getContent());
    }

    public function testArchivesTaskWithoutDeletingFiles(): void
    {
        Storage::fake('local');
        Storage::disk('local')->put('artifacts/original/task-1/statement.zip', 'zip bytes');

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.archive', ['billTask' => $this->task->id]));

        $response->assertStatus(200);
        $response->assertJsonPath('data.attributes.status', 'cleaned');

        $this->task->refresh();
        $this->assertSame('cleaned', $this->task->status);
        $this->assertDatabaseHas('bill_artifacts', ['bill_task_id' => $this->task->id]);
        Storage::disk('local')->assertExists('artifacts/original/task-1/statement.zip');
    }

    public function testArchivesMultipleTasksWithoutDeletingFiles(): void
    {
        Storage::fake('local');
        Storage::disk('local')->put('artifacts/original/task-1/statement.zip', 'zip bytes');

        $secondTask = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'parsed',
            'received_at' => Carbon::parse('2026-06-12 18:26:00', 'Asia/Shanghai'),
            'summary'     => '支付宝交易流水',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.archive-many'), [
            'ids' => [$this->task->id, $secondTask->id],
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('data.archived', 2);

        $this->task->refresh();
        $secondTask->refresh();
        $this->assertSame('cleaned', $this->task->status);
        $this->assertSame('cleaned', $secondTask->status);
        Storage::disk('local')->assertExists('artifacts/original/task-1/statement.zip');
    }

    public function testDownloadsOwnedArtifact(): void
    {
        Storage::fake('local');
        Storage::disk('local')->put('artifacts/original/task-1/statement.zip', 'zip bytes');
        $artifact = $this->task->artifacts()->first();

        $this->actingAs($this->user, 'api');
        $response = $this->get(route('api.v1.bill-artifacts.download', ['billArtifact' => $artifact->id]));

        $response->assertStatus(200);
        $response->assertHeader('content-disposition');
        $this->assertSame('zip bytes', $response->streamedContent());
    }

    public function testShowsBillInboxSettings(): void
    {
        Preferences::set('bill_inbox_mailbox_enabled', true);
        Preferences::set('bill_inbox_mailbox_provider', 'gmail');
        Preferences::set('bill_inbox_mailbox_email', 'money@example.com');
        Preferences::set('bill_inbox_mailbox_host', 'imap.gmail.com');
        Preferences::set('bill_inbox_mailbox_port', 993);
        Preferences::set('bill_inbox_mailbox_encryption', 'ssl');
        Preferences::set('bill_inbox_mailbox_username', 'money@example.com');
        Preferences::setEncrypted('bill_inbox_mailbox_password', 'gmail-app-password');
        Preferences::set('bill_inbox_mailbox_folder', 'INBOX');

        $this->actingAs($this->user, 'api');
        $response = $this->getJson(route('api.v1.bill-inbox.settings'));

        $response->assertStatus(200);
        $response->assertJsonPath('data.type', 'bill-inbox-settings');
        $response->assertJsonPath('data.attributes.enabled', true);
        $response->assertJsonPath('data.attributes.provider', 'gmail');
        $response->assertJsonPath('data.attributes.email', 'money@example.com');
        $response->assertJsonPath('data.attributes.has_password', true);
        $response->assertJsonPath('data.attributes.built_in_channels.0.source', 'alipay');
        $response->assertJsonPath('data.attributes.built_in_channels.1.source', 'wechat');
        $response->assertJsonPath('data.attributes.built_in_channels.2.source', 'cmb');
        $response->assertJsonPath('data.attributes.built_in_channels.3.source', 'boc');
    }

    public function testUpdatesBillInboxSettings(): void
    {
        $this->actingAs($this->user, 'api');
        $response = $this->putJson(route('api.v1.bill-inbox.settings.update'), [
            'enabled'  => true,
            'provider' => 'gmail',
            'email'    => 'money@example.com',
            'password' => 'app-password',
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('data.attributes.enabled', true);
        $response->assertJsonPath('data.attributes.provider', 'gmail');
        $response->assertJsonPath('data.attributes.email', 'money@example.com');
        $response->assertJsonPath('data.attributes.host', 'imap.gmail.com');
        $response->assertJsonPath('data.attributes.port', 993);
        $response->assertJsonPath('data.attributes.encryption', 'ssl');
        $response->assertJsonPath('data.attributes.username', 'money@example.com');
        $response->assertJsonPath('data.attributes.folder', 'INBOX');
        $response->assertJsonPath('data.attributes.has_password', true);

        $this->assertSame('money@example.com', Preferences::get('bill_inbox_mailbox_email')->data);
        $this->assertSame('app-password', Preferences::getEncrypted('bill_inbox_mailbox_password')->data);
        $this->assertSame('', Preferences::get('bill_inbox_quick_gmail_label')->data);
        $this->assertSame('', Preferences::get('bill_inbox_quick_keywords')->data);
        $this->assertCount(4, Preferences::get('bill_inbox_processing_rules')->data);
    }

    public function testSyncBillInboxReturnsMailboxAndProcessingCounts(): void
    {
        Preferences::set('bill_inbox_mailbox_enabled', false);

        $task = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'unknown',
            'profile_id'  => null,
            'status'      => 'received',
            'received_at' => Carbon::parse('2026-06-12 18:26:00', 'Asia/Shanghai'),
            'summary'     => '未知账单',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-inbox.sync'), ['limit' => 25]);

        $response->assertStatus(200);
        $response->assertJsonPath('data.type', 'bill-inbox-sync-result');
        $response->assertJsonPath('data.attributes.scanned', 0);
        $response->assertJsonPath('data.attributes.created', 0);
        $response->assertJsonPath('data.attributes.processed', 1);
        $response->assertJsonPath('data.attributes.process_failed', 0);

        $task->refresh();
        $this->assertSame('unknown', $task->status);
    }

    public function testProcessesQueuedBillTasks(): void
    {
        $otherUser = $this->createUser('other-process@example.com');
        $otherTask = BillTask::query()->create([
            'user_id'     => $otherUser->id,
            'source'      => 'unknown',
            'profile_id'  => null,
            'status'      => 'received',
            'received_at' => Carbon::parse('2026-06-11 18:26:00', 'Asia/Shanghai'),
            'summary'     => '其他用户未知账单',
        ]);
        $task = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'unknown',
            'profile_id'  => null,
            'status'      => 'received',
            'received_at' => Carbon::parse('2026-06-12 18:26:00', 'Asia/Shanghai'),
            'summary'     => '未知账单',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-inbox.process'), ['limit' => 10]);

        $response->assertStatus(200);
        $response->assertJsonPath('data.type', 'bill-inbox-process-result');
        $response->assertJsonPath('data.attributes.processed', 1);
        $response->assertJsonPath('data.attributes.failed', 0);

        $task->refresh();
        $otherTask->refresh();
        $this->assertSame('unknown', $task->status);
        $this->assertSame('received', $otherTask->status);
    }

    public function testCleansUpStaleBillInboxTasks(): void
    {
        $stale = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'needs_secret',
            'received_at' => Carbon::parse('2026-06-12 18:26:00', 'Asia/Shanghai'),
            'summary'     => '支付宝交易流水',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-inbox.cleanup-stale'));

        $response->assertStatus(200);
        $response->assertJsonPath('data.type', 'bill-inbox-cleanup-result');
        $response->assertJsonPath('data.attributes.archived', 2);

        $this->task->refresh();
        $stale->refresh();
        $this->assertSame('cleaned', $this->task->status);
        $this->assertSame('cleaned', $stale->status);
    }

    public function testImportsStatementRowsIntoFireflyTransactions(): void
    {
        $row = $this->createStatementRow();
        $this->createAccount('招商银行', 'Asset account');

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$row->id],
            'confirm' => true,
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('summary.imported', 1);
        $response->assertJsonPath('summary.skipped', 0);

        $row->refresh();
        $this->assertSame('imported', $row->status);
        $this->assertSame('imported', $this->task->refresh()->status);
        $this->assertNotNull($row->transaction_group_id);
        $this->assertDatabaseHas('transaction_journals', [
            'id'          => $row->transactionGroup->transactionJournals()->first()->id,
            'description' => '为155****2328交费20.00元',
        ]);

        $again = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$row->id],
            'confirm' => true,
        ]);

        $again->assertStatus(200);
        $again->assertJsonPath('summary.imported', 0);
        $again->assertJsonPath('summary.skipped', 1);
    }

    public function testImportUsesFundingAccountCurrencyInRowsPreviewAndTransaction(): void
    {
        $currency = TransactionCurrency::query()->where('code', 'USD')->firstOrFail();
        $this->createAccount('USD checking', 'Asset account', $currency->id);
        $row = $this->createStatementRow(['source_name' => 'USD checking']);

        $this->actingAs($this->user, 'api');
        $rows = $this->getJson(route('api.v1.bill-tasks.rows', ['billTask' => $this->task->id]));
        $rows->assertOk();
        $rows->assertJsonPath('data.0.attributes.currency_code', 'USD');
        $rows->assertJsonPath('data.0.attributes.currency_symbol', '$');

        $dryRun = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids'         => [$row->id],
            'confirm'         => false,
            'include_payload' => true,
        ]);
        $dryRun->assertOk();
        $dryRun->assertJsonPath('rows.0.action', 'would_import');
        $dryRun->assertJsonPath('rows.0.currency_code', 'USD');
        $dryRun->assertJsonPath('rows.0.currency_symbol', '$');
        $dryRun->assertJsonPath('rows.0.payload.transactions.0.currency_code', 'USD');

        $import = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$row->id],
            'confirm' => true,
        ]);
        $import->assertOk();
        $import->assertJsonPath('summary.imported', 1);

        $journal = $row->refresh()->transactionGroup->transactionJournals()->with('transactionCurrency')->firstOrFail();
        $this->assertSame('USD', $journal->transactionCurrency->code);
    }

    public function testImportDoesNotExposeUnexpectedInternalExceptionDetails(): void
    {
        $row = $this->createStatementRow();
        $this->createAccount('招商银行', 'Asset account');
        $repository = new class extends TransactionGroupRepository {
            public function store(array $data): TransactionGroup
            {
                throw new RuntimeException('access-token-456 at /srv/private/import.csv');
            }
        };
        $this->app->instance(TransactionGroupRepositoryInterface::class, $repository);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$row->id],
            'confirm' => true,
        ]);

        $response->assertOk();
        $response->assertJsonPath('summary.failed', 1);
        $response->assertJsonPath('rows.0.error', '导入失败，请检查账户和账单行后重试。');
        $this->assertStringNotContainsString('access-token-456', $response->getContent());
        $this->assertStringNotContainsString('/srv/private', $response->getContent());
        $this->assertSame('导入失败，请检查账户和账单行后重试。', $row->refresh()->error_message);
    }

    public function testImportDryRunReturnsCompactRowsByDefault(): void
    {
        $row = $this->createStatementRow([
            'description'         => '为15512345678交费20.00元',
            'firefly_description' => '为15512345678交费20.00元',
            'platform_order_no'   => '2026061522001414871443694067',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$row->id],
            'confirm' => false,
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('summary.total', 1);
        $response->assertJsonPath('summary.skipped', 1);
        $response->assertJsonPath('rows.0.row_id', (string) $row->id);
        $response->assertJsonPath('rows.0.row_number', 1);
        $response->assertJsonPath('rows.0.status', 'skipped');
        $response->assertJsonPath('rows.0.action', 'would_import');
        $response->assertJsonPath('rows.0.error', null);
        $response->assertJsonPath('rows.0.description_preview', '为15****78交费20.00元');
        $response->assertJsonMissingPath('rows.0.payload');
        $this->assertStringNotContainsString('user_group', $response->getContent());
        $this->assertStringNotContainsString('2026061522001414871443694067', $response->getContent());
        $this->assertStringNotContainsString('15512345678', $response->getContent());
    }

    public function testImportDryRunPayloadIsExplicitAndDoesNotExposeInternalUserObjects(): void
    {
        $row = $this->createStatementRow();

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids'         => [$row->id],
            'confirm'         => false,
            'include_payload' => true,
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('rows.0.payload.transactions.0.type', 'withdrawal');
        $response->assertJsonMissingPath('rows.0.payload.user');
        $response->assertJsonMissingPath('rows.0.payload.user_group');
        $this->assertStringNotContainsString('user_group', $response->getContent());
    }

    public function testImportSkipsRowsWithoutFireflyType(): void
    {
        $row = $this->createStatementRow();
        $row->firefly_type = null;
        $row->direction    = '不计收支';
        $row->save();

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$row->id],
            'confirm' => true,
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('summary.imported', 0);
        $response->assertJsonPath('summary.skipped', 1);
        $response->assertJsonPath('rows.0.status', 'skipped');

        $row->refresh();
        $this->assertSame('pending', $row->status);
        $this->assertNull($row->transaction_group_id);
    }

    public function testImportSkipsDuplicateAndConflictStatementRows(): void
    {
        $duplicate = $this->createStatementRow([
            'row_number'      => 1,
            'duplicate_state' => 'duplicate',
            'external_key'    => 'alipay:order:duplicate-import-0001',
            'fingerprint'     => 'fp-duplicate-import-0001',
        ]);
        $conflict  = $this->createStatementRow([
            'row_number'        => 2,
            'duplicate_state'   => 'conflict',
            'platform_order_no' => 'conflict-import-0001',
            'merchant_order_no' => 'conflict-import-merchant-0001',
            'external_key'      => 'alipay:order:conflict-import-0001',
            'fingerprint'       => 'fp-conflict-import-0001',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'confirm' => true,
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('summary.imported', 0);
        $response->assertJsonPath('summary.skipped', 2);
        $response->assertJsonPath('rows.0.status', 'skipped');
        $response->assertJsonPath('rows.0.error', '这条流水已识别为重复或冲突，不自动导入。');
        $response->assertJsonPath('rows.1.status', 'skipped');
        $response->assertJsonPath('rows.1.error', '这条流水已识别为重复或冲突，不自动导入。');

        $this->assertSame('pending', $duplicate->refresh()->status);
        $this->assertSame('pending', $conflict->refresh()->status);
        $this->assertNull($duplicate->transaction_group_id);
        $this->assertNull($conflict->transaction_group_id);
    }

    public function testSplitsComboPaymentStatementRow(): void
    {
        $row = $this->createStatementRow([
            'status'              => 'needs_split',
            'amount'              => '23.80',
            'payment_method'      => '招商银行储蓄卡(8705)&花呗',
            'firefly_type'        => null,
            'firefly_amount'      => null,
            'source_name'         => null,
            'destination_name'    => null,
            'counterparty'        => '淘宝闪购',
            'platform_order_no'   => '2026061823001114871453041742',
            'merchant_order_no'   => '13110600726061845616321068857',
            'metadata'            => [
                'payment_split' => [
                    'status'  => 'needs_split',
                    'methods' => ['招商银行储蓄卡(8705)', '花呗'],
                    'reason'  => '支付宝组合支付需要先拆分实际扣款账户和金额',
                ],
            ],
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-statement-rows.split', ['billStatementRow' => $row->id]), [
            'splits' => [
                ['payment_method' => '招商银行储蓄卡(8705)', 'amount' => '9.72', 'description' => '午餐银行部分', 'category_name' => '餐饮'],
                ['payment_method' => '花呗', 'amount' => '14.08', 'description' => '午餐花呗部分', 'category_name' => '外卖'],
            ],
        ]);

        $response->assertStatus(200);
        $response->assertJsonPath('parent.attributes.status', 'split');
        $response->assertJsonPath('data.0.attributes.status', 'pending');
        $response->assertJsonPath('data.0.attributes.source_name', '招商银行');
        $response->assertJsonPath('data.0.attributes.destination_name', '淘宝闪购');
        $response->assertJsonPath('data.0.attributes.firefly_amount', '9.72');
        $response->assertJsonPath('data.0.attributes.firefly_description', '午餐银行部分');
        $response->assertJsonPath('data.0.attributes.category_name', '餐饮');
        $response->assertJsonPath('data.1.attributes.source_name', '花呗');
        $response->assertJsonPath('data.1.attributes.destination_name', '淘宝闪购');
        $response->assertJsonPath('data.1.attributes.firefly_amount', '14.08');
        $response->assertJsonPath('data.1.attributes.firefly_description', '午餐花呗部分');
        $response->assertJsonPath('data.1.attributes.category_name', '外卖');

        $row->refresh();
        $this->assertSame('split', $row->status);
        $this->assertSame(2, BillStatementRow::query()->where('metadata->payment_split->parent_row_id', $row->id)->count());
    }

    public function testDoesNotSplitAlreadyImportedComboPaymentRow(): void
    {
        $transactionGroup = $this->createTransactionGroup();
        $row = $this->createStatementRow([
            'status'               => 'needs_split',
            'amount'               => '23.80',
            'payment_method'       => '招商银行储蓄卡(8705)&花呗',
            'firefly_type'         => null,
            'firefly_amount'       => null,
            'transaction_group_id' => $transactionGroup->id,
            'metadata'             => [
                'payment_split' => [
                    'status'  => 'needs_split',
                    'methods' => ['招商银行储蓄卡(8705)', '花呗'],
                ],
            ],
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->postJson(route('api.v1.bill-statement-rows.split', ['billStatementRow' => $row->id]), [
            'splits' => [
                ['payment_method' => '招商银行储蓄卡(8705)', 'amount' => '9.72', 'description' => '银行部分'],
                ['payment_method' => '花呗', 'amount' => '14.08', 'description' => '花呗部分'],
            ],
        ]);

        $response->assertStatus(422);
        $this->assertSame(1, BillStatementRow::query()->count());
    }

    public function testReviewStatementRowsBuildsImportDecisionLists(): void
    {
        $this->createAccount('招商银行', 'Asset account');
        $existing = $this->createStatementRow([
            'platform_order_no' => '2026061522001414871443600001',
            'merchant_order_no' => 'CP-existing-0001',
        ]);

        $this->actingAs($this->user, 'api');
        $this->postJson(route('api.v1.bill-tasks.import', ['billTask' => $this->task->id]), [
            'row_ids' => [$existing->id],
            'confirm' => true,
        ])->assertStatus(200);

        $duplicate = $this->createStatementRow([
            'row_number'        => 2,
            'platform_order_no' => '2026061522001414871443600001',
            'merchant_order_no' => 'CP-existing-0001-copy',
            'external_key'      => 'alipay:order:2026061522001414871443600001',
            'fingerprint'       => 'fp-duplicate-row',
            'duplicate_state'   => 'duplicate',
        ]);
        $preserved = $this->createStatementRow([
            'row_number'        => 7,
            'platform_order_no' => 'manual-edit-0001',
            'merchant_order_no' => 'manual-edit-merchant-0001',
            'external_key'      => 'alipay:order:manual-edit-0001',
            'fingerprint'       => 'fp-preserved-row',
            'duplicate_state'   => 'duplicate',
            'category_name'     => '人工分类',
            'user_modified_at'  => Carbon::parse('2026-06-16 10:00:00', 'Asia/Shanghai'),
        ]);
        $conflict = $this->createStatementRow([
            'row_number'        => 8,
            'platform_order_no' => 'conflict-0001',
            'merchant_order_no' => 'conflict-merchant-0001',
            'external_key'      => 'alipay:order:conflict-0001',
            'fingerprint'       => 'fp-conflict-row',
            'duplicate_state'   => 'conflict',
        ]);
        $transfer = $this->createStatementRow([
            'row_number'             => 3,
            'counterparty'           => '李昶乐',
            'description'            => '向李昶乐转账',
            'platform_category'      => '转账',
            'firefly_type'           => 'transfer',
            'source_name'            => '招商银行',
            'destination_name'       => '李昶乐',
            'platform_order_no'      => 'transfer-0001',
            'merchant_order_no'      => 'transfer-merchant-0001',
        ]);
        $needsNote = $this->createStatementRow([
            'row_number'             => 4,
            'counterparty'           => '微信转账',
            'description'            => '微信转账',
            'platform_category'      => '',
            'category_name'          => null,
            'notes'                  => null,
            'platform_order_no'      => 'needs-note-0001',
            'merchant_order_no'      => 'needs-note-merchant-0001',
        ]);
        $refundExpense = $this->createStatementRow([
            'row_number'             => 5,
            'counterparty'           => '测试商户',
            'description'            => '测试消费',
            'amount'                 => '20.00',
            'firefly_amount'         => '20.00',
            'platform_order_no'      => 'refund-expense-0001',
            'merchant_order_no'      => 'refund-expense-merchant-0001',
        ]);
        $refundIncome = $this->createStatementRow([
            'row_number'             => 6,
            'counterparty'           => '测试商户',
            'description'            => '测试退款',
            'direction'              => '收入',
            'amount'                 => '20.00',
            'firefly_type'           => 'deposit',
            'firefly_amount'         => '20.00',
            'source_name'            => '测试商户',
            'destination_name'       => '招商银行',
            'platform_order_no'      => 'refund-income-0001',
            'merchant_order_no'      => 'refund-income-merchant-0001',
        ]);
        $normalExpense = $this->createStatementRow([
            'row_number'             => 9,
            'platform_category'      => '餐饮美食',
            'counterparty'           => '测试餐厅',
            'description'            => '午餐',
            'category_name'          => '餐饮美食',
            'payment_method'         => '招商银行储蓄卡(8705)',
            'platform_order_no'      => 'normal-expense-0001',
            'merchant_order_no'      => 'normal-expense-merchant-0001',
            'external_key'           => 'alipay:order:normal-expense-0001',
            'fingerprint'            => 'fp-normal-expense-row',
        ]);

        $response = $this->getJson(route('api.v1.bill-tasks.review', ['billTask' => $this->task->id]));

        $response->assertStatus(200);
        $response->assertJsonPath('summary.total', 9);
        $response->assertJsonPath('summary.imported', 1);
        $response->assertJsonPath('summary.pending', 8);
        $response->assertJsonPath('summary.duplicate_candidates', 2);
        $response->assertJsonPath('summary.conflict_candidates', 1);
        $response->assertJsonPath('summary.preserved_user_edits', 1);
        $response->assertJsonPath('summary.importable', 1);
        $response->assertJsonPath('existing_candidates.0.row_id', (string) $duplicate->id);
        $response->assertJsonPath('existing_candidates.0.reason', '同订单号已存在 Firefly 交易');
        $response->assertJsonPath('duplicate_candidates.0.row_id', (string) $duplicate->id);
        $response->assertJsonPath('duplicate_candidates.0.reason', '已存在相同账单流水');
        $response->assertJsonPath('preserved_user_edits.0.row_id', (string) $preserved->id);
        $response->assertJsonPath('preserved_user_edits.0.reason', '重复流水已保留你的手动修改');
        $response->assertJsonPath('conflict_candidates.0.row_id', (string) $conflict->id);
        $response->assertJsonPath('conflict_candidates.0.reason', '疑似重复但核心字段冲突');
        $response->assertJsonPath('refund_pairs.0.expense_row_id', (string) $refundExpense->id);
        $response->assertJsonPath('refund_pairs.0.income_row_id', (string) $refundIncome->id);
        $body = $response->json();
        $this->assertNotContains((string) $duplicate->id, array_column($body['new_candidates'], 'row_id'));
        $this->assertNotContains((string) $preserved->id, array_column($body['new_candidates'], 'row_id'));
        $this->assertNotContains((string) $conflict->id, array_column($body['new_candidates'], 'row_id'));
        $this->assertContains((string) $normalExpense->id, array_column($body['new_candidates'], 'row_id'));
        $this->assertContains((string) $transfer->id, array_column($body['transfer_candidates'], 'row_id'));
        $this->assertContains((string) $needsNote->id, array_column($body['needs_user_note'], 'row_id'));
        $this->assertStringNotContainsString('2026061522001414871443600001', $response->getContent());
        $this->assertStringNotContainsString('CP-existing-0001', $response->getContent());
    }

    #[Override]
    protected function setUp(): void
    {
        parent::setUp();

        $this->user = $this->createAuthenticatedUser();
        $this->actingAs($this->user, 'api');

        $mail       = BillMailMessage::query()->create([
            'user_id'     => $this->user->id,
            'message_id'  => '<mail-1@example.com>',
            'mailbox'     => 'bills@example.com',
            'from_address' => 'bank@example.com',
            'to_address'  => 'bills@example.com',
            'subject'     => '招商银行信用卡电子账单',
            'received_at' => Carbon::parse('2026-06-10 09:30:00', 'Asia/Shanghai'),
            'raw_path'    => 'mail/raw/mail-1.eml',
            'checksum'    => 'mail-checksum',
            'sync_cursor' => 'cursor-1',
        ]);

        $this->task = BillTask::query()->create([
            'user_id'              => $this->user->id,
            'bill_mail_message_id' => $mail->id,
            'source'               => 'cmb',
            'profile_id'           => 'cmb-credit-card',
            'status'               => 'needs_secret',
            'received_at'          => Carbon::parse('2026-06-10 09:30:00', 'Asia/Shanghai'),
            'summary'              => '招商银行信用卡电子账单',
        ]);

        BillArtifact::query()->create([
            'bill_task_id' => $this->task->id,
            'kind'         => 'zip',
            'filename'     => 'statement.zip',
            'path'         => 'artifacts/original/task-1/statement.zip',
            'checksum'     => 'artifact-checksum',
            'encrypted'    => true,
            'metadata'     => ['source' => 'mail_attachment', 'size' => 1234],
        ]);

        $challenge = BillSecretChallenge::query()->create([
            'bill_task_id' => $this->task->id,
            'kind'         => 'password',
            'prompt'       => '请输入账单解压密码',
            'status'       => 'open',
            'attempts'     => 0,
        ]);

        $this->task->current_secret_challenge_id = $challenge->id;
        $this->task->save();

        BillTaskEvent::query()->create([
            'bill_task_id' => $this->task->id,
            'event_type'   => 'task.created',
            'message'      => '任务已创建',
            'metadata'     => ['source' => 'mailbox'],
        ]);
    }

    private function createUser(string $email): User
    {
        $group = UserGroup::create(['title' => $email]);
        $role  = UserRole::where('title', 'owner')->first();
        $user  = User::create(['email' => $email, 'password' => 'password', 'user_group_id' => $group->id]);

        GroupMembership::create(['user_id' => $user->id, 'user_group_id' => $group->id, 'user_role_id' => $role->id]);

        return $user;
    }

    /**
     * @param array<string,mixed> $overrides
     */
    private function createStatementRow(array $overrides = []): BillStatementRow
    {
        /** @var BillArtifact $artifact */
        $artifact = $this->task->artifacts()->first();
        $import   = BillStatementImport::query()->firstOrCreate([
            'bill_artifact_id' => $artifact->id,
        ], [
            'user_id'           => $this->user->id,
            'bill_task_id'      => $this->task->id,
            'source'            => 'alipay',
            'profile_id'        => 'alipay-statement',
            'original_filename' => '支付宝交易明细(20260515-20260615).csv',
            'archived_filename' => 'alipay-202606151853-20260515_20260615.csv',
            'exported_at'       => Carbon::parse('2026-06-15 18:53:58', 'Asia/Shanghai'),
            'period_start'      => Carbon::parse('2026-05-15', 'Asia/Shanghai'),
            'period_end'        => Carbon::parse('2026-06-15', 'Asia/Shanghai'),
            'row_count'         => 1,
            'status'            => 'parsed',
        ]);

        $defaults = [
            'user_id'                  => $this->user->id,
            'bill_task_id'             => $this->task->id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => 1,
            'status'                   => 'pending',
            'occurred_at'              => Carbon::parse('2026-06-15 17:20:33', 'Asia/Shanghai'),
            'platform_category'        => '充值缴费',
            'counterparty'             => '中国联通',
            'counterparty_account'     => 'ah-***@chinaunicom.cn',
            'description'              => '为155****2328交费20.00元',
            'direction'                => '支出',
            'amount'                   => '14.95',
            'payment_method'           => '招商银行储蓄卡(8705)',
            'transaction_status'       => '交易成功',
            'platform_order_no'        => '2026061522001414871443694067',
            'merchant_order_no'        => 'CP0232671781515214344949',
            'external_key'             => 'alipay:order:2026061522001414871443694067',
            'fingerprint'              => 'fp-existing-row',
            'duplicate_state'          => 'unique',
            'duplicate_of_row_id'      => null,
            'user_modified_at'         => null,
            'raw_data'                 => ['交易对方' => '中国联通'],
            'editable_data'            => ['交易对方' => '中国联通', '商品说明' => '为155****2328交费20.00元'],
            'firefly_type'             => 'withdrawal',
            'firefly_date'             => Carbon::parse('2026-06-15 17:20:33', 'Asia/Shanghai'),
            'firefly_amount'           => '14.95',
            'firefly_description'      => '为155****2328交费20.00元',
            'source_name'              => '招商银行',
            'destination_name'         => '中国联通',
            'category_name'            => '充值缴费',
            'tags'                     => ['支付宝'],
        ];

        return BillStatementRow::query()->create(array_merge($defaults, $overrides));
    }

    private function createAccount(string $name, string $type, ?int $currencyId = null): Account
    {
        $accountType = AccountType::where('type', $type)->firstOrFail();

        $account = Account::query()->create([
            'user_id'         => $this->user->id,
            'user_group_id'   => $this->user->user_group_id,
            'account_type_id' => $accountType->id,
            'name'            => $name,
            'active'          => true,
            'encrypted'       => false,
            'order'           => 0,
        ]);

        if (null !== $currencyId) {
            $account->accountMeta()->create(['name' => 'currency_id', 'data' => (string) $currencyId]);
        }

        return $account;
    }

    private function createTransactionGroup(): TransactionGroup
    {
        return TransactionGroup::query()->create([
            'user_id'       => $this->user->id,
            'user_group_id' => $this->user->user_group_id,
            'title'         => 'Imported bill transaction',
        ]);
    }
}
