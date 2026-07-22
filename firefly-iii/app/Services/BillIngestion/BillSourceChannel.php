<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillTask;

interface BillSourceChannel
{
    public function source(): string;

    public function displayName(): string;

    public function settingsDescription(): string;

    /**
     * @return array<int, string>
     */
    public function profileIds(): array;

    /**
     * @return array<int, string>
     */
    public function mailboxSearchCriteria(): array;

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function matches(BillMailMessage $mail, array $attachments): bool;

    /**
     * @param array<int, BillMailAttachment> $attachments
     */
    public function ingest(BillMailMessage $mail, array $attachments): BillTask;

    public function prepare(BillTask $task): bool;

    public function needsSecret(BillTask $task): bool;

    public function secretPrompt(BillTask $task): string;

    public function process(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool;

    public function shouldProcessAfterSecret(BillTask $task): bool;

    /**
     * @return array<string, mixed>
     */
    public function processingRule(): array;
}
