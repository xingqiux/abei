<?php

declare(strict_types=1);

namespace Tests\integration\Services\BillIngestion;

final class FakeImapMailMessage
{
    public function __construct(
        public readonly string $uid,
        public readonly string $raw,
    ) {}
}
