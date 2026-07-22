<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

final readonly class BillMailboxConfig
{
    /**
     * @param array<int, array<string, mixed>> $rules
     */
    public function __construct(
        public bool $enabled,
        public string $provider,
        public string $email,
        public string $host,
        public int $port,
        public string $encryption,
        public string $username,
        #[\SensitiveParameter] public string $password,
        public string $folder,
        public array $rules,
        public string $gmailLabel = '',
    ) {}

    public function isUsable(): bool
    {
        return $this->enabled
            && '' !== $this->host
            && '' !== $this->username
            && '' !== $this->password
            && '' !== $this->folder;
    }
}
