<?php

declare(strict_types=1);

namespace FireflyIII\Console\Commands\Tools;

use FireflyIII\Console\Commands\ShowsFriendlyMessages;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use Illuminate\Console\Command;

class ProcessesBillTasks extends Command
{
    use ShowsFriendlyMessages;

    protected $description = 'Processes generic bill ingestion tasks stored in Firefly III.';
    protected $signature   = 'firefly-iii:process-bill-tasks
        {--limit=25 : Maximum number of bill tasks to process.}
        ';

    public function handle(BillTaskProcessor $processor): int
    {
        $limit  = (int) $this->option('limit');
        $result = $processor->processBatch($limit);

        $this->friendlyInfo(sprintf('Processed %d bill task(s), %d failed.', $result->processed, $result->failed));

        return $result->failed > 0 ? Command::FAILURE : Command::SUCCESS;
    }
}
