<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillTask;

interface BillSourceChannel
{
    public function source(): string;

    public function displayName(): string;

    /**
     * @return array<int, string>
     */
    public function profileIds(): array;

    public function prepare(BillTask $task): bool;

    public function needsSecret(BillTask $task): bool;

    public function secretPrompt(BillTask $task): string;

    public function process(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool;

    public function shouldProcessAfterSecret(BillTask $task): bool;

}
