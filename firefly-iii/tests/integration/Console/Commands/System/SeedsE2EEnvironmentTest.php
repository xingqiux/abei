<?php

declare(strict_types=1);

namespace Tests\integration\Console\Commands\System;

use Carbon\Carbon;
use FireflyIII\Jobs\CreateRecurringTransactions;
use FireflyIII\Models\Recurrence;
use FireflyIII\User;
use Illuminate\Mail\Transport\ArrayTransport;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Mail;
use Symfony\Component\Mime\Email;
use Tests\integration\TestCase;
use ZipArchive;

/**
 * @internal
 *
 * @covers \FireflyIII\Console\Commands\System\SeedsE2EEnvironment
 */
final class SeedsE2EEnvironmentTest extends TestCase
{
    private string $tokenDirectory;

    public function testSeedsScopedAutomationFixturesIdempotently(): void
    {
        Carbon::setTestNow('2026-07-21 10:00:00');
        config(['mail.default' => 'array', 'mail.mailers.array' => ['transport' => 'array']]);
        app('mail.manager')->forgetMailers();
        $primaryToken   = $this->tokenDirectory . '/primary-token';
        $secondaryToken = $this->tokenDirectory . '/secondary-token';
        $arguments      = [
            '--email'                => 'abei-primary@example.test',
            '--token-path'           => $primaryToken,
            '--secondary-email'      => 'abei-secondary@example.test',
            '--secondary-token-path' => $secondaryToken
        ];

        $this
            ->artisan('system:seed-e2e', $arguments + ['--send-mail' => true])
            ->expectsOutput('E2E users, tokens and browser fixtures are ready.')
            ->assertExitCode(0);

        // 浏览器用例会把这个账户归档掉，重播必须还原，否则同一套 e2e 第二次跑就没有「归档」按钮可点。
        User::query()
            ->where('email', 'abei-primary@example.test')
            ->firstOrFail()
            ->accounts()
            ->where('name', 'E2E 归档账户')
            ->firstOrFail()
            ->update(['active' => false]);

        $this->artisan('system:seed-e2e', $arguments)->assertExitCode(0);

        $this->assertSyntheticBillAttachment();
        $this->assertFileExists($primaryToken);
        $this->assertFileExists($secondaryToken);
        $this->assertNotSame('', trim((string) file_get_contents($primaryToken)));
        $this->assertNotSame(trim((string) file_get_contents($primaryToken)), trim((string) file_get_contents($secondaryToken)));

        $primary   = User::query()->where('email', 'abei-primary@example.test')->firstOrFail();
        $secondary = User::query()->where('email', 'abei-secondary@example.test')->firstOrFail();
        $this->assertSame(1, $primary->tokens()->where('name', 'abei-e2e')->where('revoked', false)->count());
        $this->assertSame(1, $secondary->tokens()->where('name', 'abei-e2e')->where('revoked', false)->count());
        $this->assertSame('CNY', $primary->userGroup->currencies()->wherePivot('group_default', true)->firstOrFail()->code);
        $this->assertSame('CNY', $secondary->userGroup->currencies()->wherePivot('group_default', true)->firstOrFail()->code);

        $group = $primary->ruleGroups()->where('title', 'Abei E2E Synthetic Rules')->firstOrFail();
        $rule  = $primary->rules()->where('title', 'Abei E2E Tag Synthetic Lunch')->firstOrFail();
        $this->assertSame(1, $primary->ruleGroups()->where('title', $group->title)->count());
        $this->assertSame(1, $primary->rules()->where('title', $rule->title)->count());
        $this->assertSame($group->id, $rule->rule_group_id);
        $this->assertTrue($group->active);
        $this->assertTrue($rule->active);
        $this->assertSame('manual-activation', $rule->ruleTriggers()->where('trigger_type', 'user_action')->firstOrFail()->trigger_value);
        $this->assertSame('合成午餐', $rule->ruleTriggers()->where('trigger_type', 'description_contains')->firstOrFail()->trigger_value);
        $this->assertSame('abei-e2e-reviewed', $rule->ruleActions()->where('action_type', 'add_tag')->firstOrFail()->action_value);

        $recurrence  = $primary->recurrences()->where('title', 'Abei E2E Daily Synthetic Subscription')->firstOrFail();
        $transaction = $recurrence->recurrenceTransactions()->firstOrFail();
        $this->assertSame(1, $primary->recurrences()->where('title', $recurrence->title)->count());
        $this->assertTrue($recurrence->active);
        $this->assertSame('daily', $recurrence->recurrenceRepetitions()->firstOrFail()->repetition_type);
        $this->assertSame('Abei E2E Synthetic Subscription Charge', $transaction->description);
        $this->assertSame('CNY', $transaction->transactionCurrency->code);
        $this->assertSame($primary->id, $transaction->sourceAccount->user_id);
        $this->assertSame($primary->id, $transaction->destinationAccount->user_id);
        // 先验浏览器夹具再触发订阅：触发会多出一笔流水，笔数就对不上了。
        $this->assertBrowserFixtures($primary);
        $this->assertRecurrenceCanTrigger($recurrence);

        $this->assertSame(0, $secondary->ruleGroups()->where('title', $group->title)->count());
        $this->assertSame(0, $secondary->rules()->where('title', $rule->title)->count());
        $this->assertSame(0, $secondary->recurrences()->where('title', $recurrence->title)->count());
        $this->assertSame(
            0,
            $secondary
                ->accounts()
                ->whereIn('name', [
                    'Abei E2E Recurrence Source',
                    'Abei E2E Recurrence Merchant'
                ])
                ->count()
        );
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->tokenDirectory = sys_get_temp_dir() . '/abei-e2e-command-' . bin2hex(random_bytes(8));
    }

    protected function tearDown(): void
    {
        foreach ((array) glob($this->tokenDirectory . '/*') as $path) {
            unlink($path);
        }
        if (is_dir($this->tokenDirectory)) {
            rmdir($this->tokenDirectory);
        }
        Carbon::setTestNow();

        parent::tearDown();
    }

    /**
     * 浏览器主路径要的账本：两个资产账户、一个支出对手方、三笔当天的支出。
     * 命令跑了两次，所以这里同时验重播不会把流水越堆越多、也不会留下上一轮的归档状态。
     */
    private function assertBrowserFixtures(User $user): void
    {
        foreach (['E2E 记账账户', 'E2E 归档账户'] as $name) {
            $account = $user->accounts()->where('name', $name)->firstOrFail();
            $this->assertTrue($account->active, sprintf('%s 应当在重播后回到未归档', $name));
        }
        $this->assertSame(1, $user->accounts()->where('name', 'E2E 商户')->count());

        $journals = $user->transactionJournals()->orderBy('date', 'desc')->get();
        $this->assertCount(3, $journals);

        // 金额比数值不比字符串：小数位数跟着数据库驱动走（pgsql 给 56.000000000000，sqlite 给 56）。
        $expected = [
            ['E2E 打车', 56.0, 'E2E 交通'],
            ['E2E 午餐', 34.0, 'E2E 餐饮'],
            ['E2E 早餐', 12.0, 'E2E 餐饮']
        ];
        foreach ($expected as $index => [$description, $amount, $category]) {
            $journal = $journals[$index];
            $this->assertSame($description, $journal->description);
            $this->assertEqualsWithDelta($amount, (float) $journal->transactions()->where('amount', '>', 0)->firstOrFail()->amount, 0.0001);
            $this->assertSame($category, $journal->categories()->firstOrFail()->name);
            $this->assertSame(Carbon::today(config('app.timezone'))->toDateString(), $journal->date->toDateString());
        }
    }

    private function assertRecurrenceCanTrigger(Recurrence $recurrence): void
    {
        $job = new CreateRecurringTransactions(Carbon::today(config('app.timezone')));
        $job->setRecurrences(new Collection([$recurrence]));
        $job->handle();

        $this->assertSame(1, $job->created);
        $this->assertCount(1, $job->getGroups());
    }

    private function assertSyntheticBillAttachment(): void
    {
        $transport = Mail::getSymfonyTransport();
        $this->assertInstanceOf(ArrayTransport::class, $transport);
        $messages = $transport
            ->messages()
            ->filter(static function ($sent): bool {
                $message = $sent->getOriginalMessage();

                return $message instanceof Email && 0 < count($message->getAttachments());
            });
        $this->assertCount(2, $messages);
        $message = $messages->firstOrFail()->getOriginalMessage();
        $this->assertInstanceOf(Email::class, $message);
        $this->assertCount(1, $message->getAttachments());

        $archivePath = $this->tokenDirectory . '/synthetic-bill.zip';
        file_put_contents($archivePath, (string) $message->getAttachments()[0]->getBody());
        $archive = new ZipArchive();
        $this->assertTrue(true === $archive->open($archivePath));
        $archive->setPassword('e2e-bill-only');
        $csv = $archive->getFromName('支付宝交易明细(20260701-20260731).csv');
        $archive->close();

        $this->assertIsString($csv);
        $this->assertStringContainsString('合成午餐,支出,18.80,E2E Checking', $csv);
        $this->assertStringContainsString('合成拆分午餐,支出,23.80,招商银行储蓄卡(8705)&花呗', $csv);
    }
}
