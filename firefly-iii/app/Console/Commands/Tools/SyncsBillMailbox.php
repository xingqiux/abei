<?php

declare(strict_types=1);

namespace FireflyIII\Console\Commands\Tools;

use FireflyIII\Console\Commands\ShowsFriendlyMessages;
use FireflyIII\Services\BillIngestion\BillMailboxSyncService;
use FireflyIII\User;
use Illuminate\Console\Command;

class SyncsBillMailbox extends Command
{
    use ShowsFriendlyMessages;

    protected $description = 'Syncs configured bill mailbox messages into Firefly III bill tasks.';
    protected $signature   = 'firefly-iii:sync-bill-mailbox
        {--user= : User ID or email address to sync. Defaults to all users.}
        {--limit=25 : Maximum number of mailbox messages per user.}
        ';

    public function handle(BillMailboxSyncService $syncService): int
    {
        $limit = (int) $this->option('limit');
        $users = $this->users();

        $totalScanned    = 0;
        $totalCreated    = 0;
        $totalIgnored    = 0;
        $totalDuplicates = 0;
        $totalFailed     = 0;

        foreach ($users as $user) {
            $result          = $syncService->syncForUser($user, $limit);
            $totalScanned    += $result->scanned;
            $totalCreated    += $result->created;
            $totalIgnored    += $result->ignored;
            $totalDuplicates += $result->duplicates;
            $totalFailed     += $result->failed;
            foreach ($result->errors as $error) {
                $this->friendlyError(sprintf('User #%d: %s', $user->id, $error));
            }
        }

        $this->friendlyInfo(sprintf(
            'Scanned %d mail message(s), created %d task(s), ignored %d, duplicates %d, failed %d.',
            $totalScanned,
            $totalCreated,
            $totalIgnored,
            $totalDuplicates,
            $totalFailed
        ));

        return $totalFailed > 0 ? Command::FAILURE : Command::SUCCESS;
    }

    /**
     * @return array<int, User>
     */
    private function users(): array
    {
        $selector = trim((string) $this->option('user'));
        if ('' === $selector) {
            return User::query()->orderBy('id')->get()->all();
        }

        $isId  = ctype_digit($selector);
        $query = User::query()->where($isId ? 'id' : 'email', $isId ? (int) $selector : $selector);

        $user = $query->first();
        if (!$user instanceof User) {
            $this->friendlyWarning(sprintf('No user found for "%s".', $selector));

            return [];
        }

        return [$user];
    }
}
