<?php

declare(strict_types=1);

namespace Tests\integration\Http\BillInbox;

final class FakeBillInboxImapMessage
{
    public function __construct(
        public readonly string $uid,
        public readonly string $raw,
    ) {}
}
