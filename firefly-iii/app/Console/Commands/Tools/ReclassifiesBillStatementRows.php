<?php

declare(strict_types=1);

namespace FireflyIII\Console\Commands\Tools;

use FireflyIII\Services\BillIngestion\BillStatementRowReclassificationService;
use Illuminate\Console\Command;

final class ReclassifiesBillStatementRows extends Command
{
    protected $description = 'Backfills bill statement row review states and cross-channel pairing.';
    protected $signature = 'abei:reclassify-rows';

    public function handle(BillStatementRowReclassificationService $service): int
    {
        $result = $service->run();
        $this->info(sprintf('已重分类 %d 条流水，处理 %d 个用户。', $result['rows'], $result['users']));

        return self::SUCCESS;
    }
}
