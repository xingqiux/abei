<?php

declare(strict_types=1);

namespace Tests\integration\Console\Commands\System;

use Carbon\Carbon;
use FireflyIII\Jobs\CreateRecurringTransactions;
use FireflyIII\Models\Recurrence;
use FireflyIII\Support\Facades\Preferences;
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
            '--email'                => 'granary-primary@example.test',
            '--token-path'           => $primaryToken,
            '--secondary-email'      => 'granary-secondary@example.test',
            '--secondary-token-path' => $secondaryToken
        ];

        $this
            ->artisan('system:seed-e2e', $arguments + ['--send-mail' => true])
            ->expectsOutput('E2E users, tokens and primary mailbox fixture are ready.')
            ->assertExitCode(0);
        $this->artisan('system:seed-e2e', $arguments)->assertExitCode(0);

        $this->assertSyntheticBillAttachment();
        $this->assertFileExists($primaryToken);
        $this->assertFileExists($secondaryToken);
        $this->assertNotSame('', trim((string) file_get_contents($primaryToken)));
        $this->assertNotSame(trim((string) file_get_contents($primaryToken)), trim((string) file_get_contents($secondaryToken)));

        $primary   = User::query()->where('email', 'granary-primary@example.test')->firstOrFail();
        $secondary = User::query()->where('email', 'granary-secondary@example.test')->firstOrFail();
        $this->assertSame(1, $primary->tokens()->where('name', 'granary-e2e')->where('revoked', false)->count());
        $this->assertSame(1, $secondary->tokens()->where('name', 'granary-e2e')->where('revoked', false)->count());
        $this->assertTrue((bool) Preferences::getForUser($primary, 'bill_inbox_mailbox_enabled')?->data);
        $this->assertNull(Preferences::getForUser($secondary, 'bill_inbox_mailbox_enabled'));
        $this->assertSame('CNY', $primary->userGroup->currencies()->wherePivot('group_default', true)->firstOrFail()->code);
        $this->assertSame('CNY', $secondary->userGroup->currencies()->wherePivot('group_default', true)->firstOrFail()->code);

        $group = $primary->ruleGroups()->where('title', 'Granary E2E Synthetic Rules')->firstOrFail();
        $rule  = $primary->rules()->where('title', 'Granary E2E Tag Synthetic Lunch')->firstOrFail();
        $this->assertSame(1, $primary->ruleGroups()->where('title', $group->title)->count());
        $this->assertSame(1, $primary->rules()->where('title', $rule->title)->count());
        $this->assertSame($group->id, $rule->rule_group_id);
        $this->assertTrue($group->active);
        $this->assertTrue($rule->active);
        $this->assertSame('manual-activation', $rule->ruleTriggers()->where('trigger_type', 'user_action')->firstOrFail()->trigger_value);
        $this->assertSame('合成午餐', $rule->ruleTriggers()->where('trigger_type', 'description_contains')->firstOrFail()->trigger_value);
        $this->assertSame('granary-e2e-reviewed', $rule->ruleActions()->where('action_type', 'add_tag')->firstOrFail()->action_value);

        $recurrence  = $primary->recurrences()->where('title', 'Granary E2E Daily Synthetic Subscription')->firstOrFail();
        $transaction = $recurrence->recurrenceTransactions()->firstOrFail();
        $this->assertSame(1, $primary->recurrences()->where('title', $recurrence->title)->count());
        $this->assertTrue($recurrence->active);
        $this->assertSame('daily', $recurrence->recurrenceRepetitions()->firstOrFail()->repetition_type);
        $this->assertSame('Granary E2E Synthetic Subscription Charge', $transaction->description);
        $this->assertSame('CNY', $transaction->transactionCurrency->code);
        $this->assertSame($primary->id, $transaction->sourceAccount->user_id);
        $this->assertSame($primary->id, $transaction->destinationAccount->user_id);
        $this->assertRecurrenceCanTrigger($recurrence);

        $this->assertSame(0, $secondary->ruleGroups()->where('title', $group->title)->count());
        $this->assertSame(0, $secondary->rules()->where('title', $rule->title)->count());
        $this->assertSame(0, $secondary->recurrences()->where('title', $recurrence->title)->count());
        $this->assertSame(
            0,
            $secondary
                ->accounts()
                ->whereIn('name', [
                    'Granary E2E Recurrence Source',
                    'Granary E2E Recurrence Merchant'
                ])
                ->count()
        );
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->tokenDirectory = sys_get_temp_dir() . '/granary-e2e-command-' . bin2hex(random_bytes(8));
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
        $this->assertCount(1, $messages);
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
