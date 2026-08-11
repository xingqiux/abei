<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

class BillSourceChannelRegistry
{
    /**
     * @param array<int, BillSourceChannel> $channels
     */
    public function __construct(private readonly array $channels) {}

    /** @return array<int, BillSourceChannel> */
    public function channels(): array
    {
        return $this->channels;
    }

    public function find(string $source, ?string $profileId): ?BillSourceChannel
    {
        foreach ($this->channels as $channel) {
            if ($channel->source() !== $source) {
                continue;
            }
            if (null === $profileId || in_array($profileId, $channel->profileIds(), true)) {
                return $channel;
            }
        }

        return null;
    }
}
