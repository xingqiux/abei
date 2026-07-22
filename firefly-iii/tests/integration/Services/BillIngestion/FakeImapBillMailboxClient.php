<?php

declare(strict_types=1);

namespace Tests\integration\Services\BillIngestion;

use FireflyIII\Services\BillIngestion\BillMailboxConfig;
use FireflyIII\Services\BillIngestion\ImapBillMailboxClient;

final class FakeImapBillMailboxClient implements ImapBillMailboxClient
{
    /** @var array<int, FakeImapMailMessage> */
    private array $messages;

    /** @var array<int, string> */
    private array $missingFolders;

    /** @var array<string, array<int, string>> */
    private array $criteriaResults;

    /** @var array<int, string> */
    private array $failingCriteria;

    /** @var array<int, string> */
    public array $selectedFolders = [];

    /** @var array<int, string> */
    public array $searches = [];

    /** @var array<int, string> */
    public array $seenUids = [];

    public bool $connected = false;

    /**
     * @param array<int, FakeImapMailMessage>   $messages
     * @param array<int, string>                $missingFolders
     * @param array<string, array<int, string>> $criteriaResults
     * @param array<int, string>                $failingCriteria
     */
    public function __construct(array $messages, array $missingFolders = [], array $criteriaResults = [], array $failingCriteria = [])
    {
        $this->messages        = $messages;
        $this->missingFolders  = $missingFolders;
        $this->criteriaResults = $criteriaResults;
        $this->failingCriteria = $failingCriteria;
    }

    public function connect(BillMailboxConfig $config): void
    {
        $this->connected = true;
    }

    public function selectFolder(string $folder): void
    {
        $this->selectedFolders[] = $folder;
        if (in_array($folder, $this->missingFolders, true)) {
            throw new \RuntimeException(sprintf('IMAP command failed: A0002 NO [NONEXISTENT] Unknown Mailbox: %s (Failure)', $folder));
        }
    }

    public function search(string $criteria, int $limit): array
    {
        $this->searches[] = $criteria;
        if (in_array($criteria, $this->failingCriteria, true)) {
            throw new \RuntimeException(sprintf('Unsupported search criterion: %s', $criteria));
        }
        if (array_key_exists($criteria, $this->criteriaResults)) {
            return array_slice($this->criteriaResults[$criteria], 0, $limit);
        }

        return array_slice(array_map(static fn (FakeImapMailMessage $message): string => $message->uid, $this->messages), 0, $limit);
    }

    public function fetchRawMessage(string $uid): string
    {
        foreach ($this->messages as $message) {
            if ($message->uid === $uid) {
                return $message->raw;
            }
        }

        return '';
    }

    public function markSeen(string $uid): void
    {
        $this->seenUids[] = $uid;
    }

    public function close(): void
    {
        $this->connected = false;
    }
}
