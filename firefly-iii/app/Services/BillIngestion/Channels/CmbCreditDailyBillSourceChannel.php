<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use FireflyIII\Services\BillIngestion\CmbCreditDailyImportService;
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

    /**
     * @return array<int,string>
     */
    public function profileIds(): array
    {
        return ['cmb-credit-card-daily'];
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

}
