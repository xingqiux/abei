<?php

declare(strict_types=1);

namespace Tests\integration\Http\BillInbox;

use FireflyIII\Services\BillIngestion\BillMailboxConfig;
use FireflyIII\Services\BillIngestion\ImapBillMailboxClient;

final class FakeBillInboxImapClient implements ImapBillMailboxClient
{
    public bool $connected = false;

    /** @var array<int,string> */
    public array $searches = [];

    /** @var array<int, FakeBillInboxImapMessage> */
    private array $messages;

    /** @var array<int, string> */
    private array $missingFolders;

    /**
     * @param array<int, FakeBillInboxImapMessage> $messages
     * @param array<int, string>                   $missingFolders
     */
    public function __construct(array $messages, array $missingFolders = [])
    {
        $this->messages       = $messages;
        $this->missingFolders = $missingFolders;
    }

    public function close(): void
    {
        $this->connected = false;
    }

    public function connect(BillMailboxConfig $config): void
    {
        $this->connected = true;
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

    public function markSeen(string $uid): void {}

    public function search(string $criteria, int $limit): array
    {
        $this->searches[] = $criteria;

        return array_slice(array_map(static fn (FakeBillInboxImapMessage $message): string => $message->uid, $this->messages), 0, $limit);
    }

    public function selectFolder(string $folder): void
    {
        if (in_array($folder, $this->missingFolders, true)) {
            throw new \RuntimeException(sprintf('IMAP command failed: A0002 NO [NONEXISTENT] Unknown Mailbox: %s (Failure)', $folder));
        }
    }
}
