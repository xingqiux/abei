<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\User;

final class BillStatementRowReclassificationService
{
    public function __construct(
        private readonly BillStatementRowSummaryService $summaryService,
        private readonly CrossChannelPairingService $pairingService,
    ) {}

    /**
     * @return array{rows:int,users:int}
     */
    public function run(?User $user = null): array
    {
        $query = BillStatementRow::query()->orderBy('id');
        if ($user instanceof User) {
            $query->where('user_id', $user->id);
        }

        $rows = 0;
        $query->chunkById(500, function ($chunk) use (&$rows): void {
            foreach ($chunk as $row) {
                $this->summaryService->classifyRow($row);
                ++$rows;
            }
        });

        $users = $user instanceof User
            ? collect([$user])
            : User::query()->whereHas('billStatementRows')->orderBy('id')->get();
        foreach ($users as $rowUser) {
            $this->pairingService->pairOpenRows($rowUser);
        }

        return ['rows' => $rows, 'users' => $users->count()];
    }
}
