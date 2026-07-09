<?php

declare(strict_types=1);

namespace Tests\integration\Api\Models\BillTask;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Override;
use Tests\integration\TestCase;

/**
 * @internal
 *
 * @covers \FireflyIII\Api\V1\Controllers\Models\BillTask\BillInboxController
 * @covers \FireflyIII\Services\BillIngestion\BillInboxSummaryService
 */
final class BillInboxSummaryControllerTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    public function testSummaryAggregatesChannelCountsForCurrentUser(): void
    {
        $alipayTask = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'parsed',
            'received_at' => Carbon::parse('2026-06-22 12:07:37', 'Asia/Shanghai'),
            'summary'     => '支付宝交易流水明细',
        ]);
        BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'wechat',
            'profile_id'  => 'wechat-pay-statement',
            'status'      => 'needs_secret',
            'received_at' => Carbon::parse('2026-06-20 09:00:00', 'Asia/Shanghai'),
            'summary'     => '微信支付账单流水',
        ]);
        BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'cmb',
            'profile_id'  => 'cmb-transaction-statement',
            'status'      => 'failed',
            'received_at' => Carbon::parse('2026-06-16 17:44:59', 'Asia/Shanghai'),
            'summary'     => '招商银行交易流水',
        ]);

        $artifact = BillArtifact::query()->create([
            'bill_task_id' => $alipayTask->id,
            'kind'         => 'csv',
            'filename'     => 'alipay.csv',
            'path'         => 'artifacts/derived/task-summary/alipay.csv',
            'checksum'     => 'alipay-summary-checksum',
            'encrypted'    => false,
        ]);
        $import   = BillStatementImport::query()->create([
            'user_id'           => $this->user->id,
            'bill_task_id'      => $alipayTask->id,
            'bill_artifact_id'  => $artifact->id,
            'source'            => 'alipay',
            'profile_id'        => 'alipay-statement',
            'original_filename' => 'alipay.csv',
            'archived_filename' => 'alipay-archived.csv',
            'exported_at'       => Carbon::parse('2026-06-22 12:07:37', 'Asia/Shanghai'),
            'period_start'      => Carbon::parse('2026-06-01', 'Asia/Shanghai'),
            'period_end'        => Carbon::parse('2026-06-22', 'Asia/Shanghai'),
            'row_count'         => 1,
            'status'            => 'parsed',
        ]);
        BillStatementRow::query()->create([
            'user_id'                  => $this->user->id,
            'bill_task_id'             => $alipayTask->id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => 1,
            'status'                   => 'pending',
            'occurred_at'              => Carbon::parse('2026-06-22 12:00:00', 'Asia/Shanghai'),
            'direction'                => '支出',
            'amount'                   => '9.90',
            'raw_data'                 => ['交易对方' => 'luckin coffee'],
            'editable_data'            => ['交易对方' => 'luckin coffee'],
            'firefly_type'             => 'withdrawal',
            'firefly_amount'           => '9.90',
        ]);

        $otherUser = $this->createOtherUser();
        BillTask::query()->create([
            'user_id'     => $otherUser->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'needs_secret',
            'received_at' => Carbon::parse('2026-06-10 11:00:00', 'Asia/Shanghai'),
            'summary'     => '其他用户账单',
        ]);

        $this->actingAs($this->user, 'api');
        $response = $this->getJson(route('api.v1.bill-inbox.summary'));

        $response->assertStatus(200);
        $response->assertJsonPath('needs_code', 1);
        $response->assertJsonPath('unprocessed', 0);
        $response->assertJsonPath('failed', 1);
        $response->assertJsonPath('pending_total', 2);
        $response->assertJsonCount(4, 'channels');

        $channels = collect($response->json('channels'))->keyBy('key');
        $this->assertSame('支付宝交易流水', $channels['alipay']['name']);
        $this->assertSame(0, $channels['alipay']['needs_code']);
        $this->assertSame('parsed', $channels['alipay']['last_status']);
        $this->assertSame(1, $channels['alipay']['parsed']);
        $this->assertSame(1, $channels['alipay']['to_store']);
        $this->assertNotNull($channels['alipay']['last_received_at']);

        $this->assertSame(1, $channels['wechat']['needs_code']);
        $this->assertSame('needs_secret', $channels['wechat']['last_status']);

        $this->assertSame(1, $channels['cmb']['failed']);
        $this->assertSame('failed', $channels['cmb']['last_status']);

        $this->assertSame(0, $channels['boc']['needs_code']);
        $this->assertSame(0, $channels['boc']['unprocessed']);
        $this->assertSame(0, $channels['boc']['failed']);
        $this->assertNull($channels['boc']['last_status']);
        $this->assertNull($channels['boc']['last_received_at']);
    }

    public function testSummaryRequiresAuthentication(): void
    {
        $response = $this->get(route('api.v1.bill-inbox.summary'), ['Accept' => 'application/json']);

        $response->assertStatus(401);
        $response->assertHeader('Content-Type', 'application/json');
        $response->assertContent('{"message":"Unauthenticated.","exception":"AuthenticationException"}');
    }

    private function createOtherUser(): User
    {
        $email = 'other-bill-inbox-summary@example.com';
        $group = UserGroup::create(['title' => $email]);
        $role  = UserRole::where('title', 'owner')->first();
        $user  = User::create(['email' => $email, 'password' => 'password', 'user_group_id' => $group->id]);

        GroupMembership::create(['user_id' => $user->id, 'user_group_id' => $group->id, 'user_role_id' => $role->id]);

        return $user;
    }

    #[Override]
    protected function setUp(): void
    {
        parent::setUp();

        $this->user = $this->createAuthenticatedUser();
    }
}
