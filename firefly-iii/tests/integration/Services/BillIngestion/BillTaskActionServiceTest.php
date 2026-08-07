<?php

declare(strict_types=1);

namespace Tests\integration\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillSecretChallenge;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillTaskActionService;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Override;
use RuntimeException;
use Tests\integration\TestCase;
use ZipArchive;

/**
 * @internal
 *
 * @covers \FireflyIII\Services\BillIngestion\BillTaskActionService
 */
final class BillTaskActionServiceTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    public function testWrongSecretKeepsChallengeOpenAndOnlyCountsAnAttempt(): void
    {
        $task    = $this->createAlipayTaskAwaitingSecret('zip-secret');
        $service = app(BillTaskActionService::class);

        $message = $this->submitExpectingFailure($service, $task, 'wrong-secret');
        $this->assertStringContainsString('请检查密码是否正确', $message);
        $this->assertStringNotContainsString('再试', $message);

        // 密码错了任务要退回等密码那一步，挑战继续开着——不然只能把整个任务重跑一遍
        $task->refresh();
        $this->assertSame('needs_secret', $task->status);
        $this->assertSame('secret_rejected', $task->error_code);
        $this->assertSame($message, $task->error_message);
        $this->assertNotNull($task->current_secret_challenge_id);
        $this->assertSame('challenge.rejected', $task->events()->latest('id')->first()->event_type);

        $challenge = $task->currentSecretChallenge;
        $this->assertInstanceOf(BillSecretChallenge::class, $challenge);
        $this->assertSame('open', $challenge->status);
        $this->assertSame(1, $challenge->attempts);
        $this->assertNull($challenge->consumed_at);
        $this->assertSame(0, BillStatementRow::query()->count());
    }

    public function testCorrectSecretConsumesTheChallengeAndParsesTheTask(): void
    {
        $task    = $this->createAlipayTaskAwaitingSecret('zip-secret');
        $service = app(BillTaskActionService::class);
        $this->submitExpectingFailure($service, $task, 'wrong-secret');

        $service->submitSecret($task->refresh(), 'zip-secret');

        $task->refresh();
        $this->assertSame('parsed', $task->status);
        $this->assertNull($task->error_code);
        $this->assertNull($task->error_message);
        $this->assertNull($task->current_secret_challenge_id);
        $this->assertSame('challenge.consumed', $task->events()->latest('id')->first()->event_type);
        $this->assertSame(3, BillStatementRow::query()->count());

        // 试错那一次也记在账上，但要密码真的验过了才算用掉
        $challenge = BillSecretChallenge::query()->where('bill_task_id', $task->id)->firstOrFail();
        $this->assertSame('consumed', $challenge->status);
        $this->assertSame(2, $challenge->attempts);
        $this->assertNotNull($challenge->consumed_at);
    }

    public function testWrongSecretCanBeRetriedWithoutAnArtificialLimit(): void
    {
        $task        = $this->createAlipayTaskAwaitingSecret('zip-secret');
        $challengeId = $task->current_secret_challenge_id;
        $service     = app(BillTaskActionService::class);

        for ($attempt = 1; $attempt <= 6; ++$attempt) {
            $this->submitExpectingFailure($service, $task->refresh(), 'wrong-secret');
        }

        $task->refresh();
        $this->assertSame('needs_secret', $task->status);
        $this->assertSame('secret_rejected', $task->error_code);
        $this->assertSame($challengeId, $task->current_secret_challenge_id);
        $this->assertSame('challenge.rejected', $task->events()->latest('id')->first()->event_type);

        $challenge = BillSecretChallenge::query()->findOrFail($challengeId);
        $this->assertSame('open', $challenge->status);
        $this->assertSame(6, $challenge->attempts);

        $service->submitSecret($task, 'zip-secret');
        $this->assertSame('parsed', $task->refresh()->status);
    }

    public function testMissingArtifactFailsTheTaskInsteadOfAskingForAnotherSecret(): void
    {
        $task     = $this->createAlipayTaskAwaitingSecret('zip-secret');
        $artifact = $task->artifacts()->where('encrypted', true)->firstOrFail();
        Storage::disk('local')->delete((string) $artifact->path);

        $message = $this->submitExpectingFailure(app(BillTaskActionService::class), $task, 'zip-secret');
        $this->assertStringContainsString('附件文件不存在', $message);
        $this->assertStringNotContainsString('再试', $message);

        $task->refresh();
        $this->assertSame('failed', $task->status);
        $this->assertSame('processing_failed', $task->error_code);
        $this->assertNull($task->current_secret_challenge_id);
        $this->assertSame('task.failed', $task->events()->latest('id')->first()->event_type);
    }

    #[Override]
    protected function setUp(): void
    {
        parent::setUp();

        $this->user = $this->createAuthenticatedUser();
        Storage::fake('local');
    }

    private function submitExpectingFailure(BillTaskActionService $service, BillTask $task, #[\SensitiveParameter] string $secret): string
    {
        try {
            $service->submitSecret($task, $secret);
        } catch (RuntimeException $e) {
            return $e->getMessage();
        }

        // fail() 要留在 try 外面：它抛的 AssertionFailedError 也是 RuntimeException 的子类，
        // 写在里面会被上面那个 catch 吞掉，测试就永远不会红。
        self::fail('提交这个密码本该失败：'.$secret);
    }

    private function createAlipayTaskAwaitingSecret(#[\SensitiveParameter] string $password): BillTask
    {
        $task    = BillTask::query()->create([
            'user_id'     => $this->user->id,
            'source'      => 'alipay',
            'profile_id'  => 'alipay-statement',
            'status'      => 'received',
            'received_at' => Carbon::parse('2026-06-15 18:53:58', 'Asia/Shanghai'),
            'summary'     => '支付宝交易流水明细',
        ]);
        $zipPath = sprintf('bill-inbox/%d/attachments/01-alipay-statement.zip', $task->id);
        Storage::disk('local')->put($zipPath, $this->encryptedZipBytes($password));
        BillArtifact::query()->create([
            'bill_task_id' => $task->id,
            'kind'         => 'zip',
            'filename'     => '支付宝交易明细(20260515-20260615).zip',
            'path'         => $zipPath,
            'encrypted'    => true,
            'metadata'     => ['password_source' => 'alipay_service_message'],
        ]);

        app(BillTaskProcessor::class)->processBatch(10);
        $task->refresh();
        self::assertSame('needs_secret', $task->status);
        self::assertNotNull($task->current_secret_challenge_id);

        return $task;
    }

    private function encryptedZipBytes(#[\SensitiveParameter] string $password): string
    {
        $path = tempnam(sys_get_temp_dir(), 'alipay-statement-');
        if (false === $path) {
            throw new RuntimeException('Could not create temporary zip file.');
        }

        $zip = new ZipArchive();
        if (true !== $zip->open($path, ZipArchive::OVERWRITE)) {
            throw new RuntimeException('Could not open temporary zip file.');
        }

        $zip->setPassword($password);
        $zip->addFromString('alipay-records.csv', $this->alipayStatementCsv());
        $zip->setEncryptionName('alipay-records.csv', ZipArchive::EM_AES_256, $password);
        $zip->close();

        $bytes = file_get_contents($path);
        unlink($path);

        if (false === $bytes) {
            throw new RuntimeException('Could not read temporary zip file.');
        }

        return $bytes;
    }

    private function alipayStatementCsv(): string
    {
        return mb_convert_encoding(<<<'CSV'
------------------------------------------------------------------------------------
导出信息：
姓名：李昶乐
支付宝账户：15556952328
起始时间：[2026-05-15 00:00:00]    终止时间：[2026-06-15 23:59:59]
导出交易类型：[全部]
导出时间：[2026-06-15 18:53:58]
共3笔记录

特别提示：
1.本明细仅供个人对账使用。

-------------------------支付宝支付科技有限公司  电子客户回单------------------------
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
2026-06-15 17:20:33,充值缴费,中国联通,ah-***@chinaunicom.cn,为155****2328交费20.00元,支出,14.95,招商银行储蓄卡(8705)&支付宝随机立减,交易成功,2026061522001414871443694067,CP0232671781515214344949,
2026-06-15 10:22:14,信用借还,花呗,/,花呗主动还款-2026年07月账单,不计收支,123.00,招商银行储蓄卡(8705),还款成功,2026061529020999870179346714,,
2026-06-15 09:30:52,日用百货,安徽邻几（肥西亚坤大厦店）,209***@qq.com,11400肥西亚坤大厦店,支出,3.32,花呗&花呗青春特惠,交易成功,2026061523001414871431914548,11400A260615093044,
CSV, 'GB18030', 'UTF-8');
    }
}
