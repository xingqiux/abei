<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillMailMessage;
use FireflyIII\Models\BillSecretChallenge;
use FireflyIII\Models\BillStatementImport;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Models\BillTaskEvent;
use Illuminate\Database\Eloquent\Collection as EloquentCollection;
use Illuminate\Pagination\LengthAwarePaginator;
use Symfony\Component\Mime\MimeTypes;

trait BillTaskResponse
{
    /**
     * @param array<int, array{total:int,pending:int,imported:int,duplicate:int,conflict:int}> $rowCounts
     */
    protected function collectionResponse(LengthAwarePaginator $paginator, array $rowCounts = []): array
    {
        return [
            'data'  => $paginator->getCollection()->map(fn (BillTask $task): array => $this->taskResource($task, $rowCounts[$task->id] ?? null))->values()->all(),
            'meta'  => [
                'pagination' => [
                    'total'        => $paginator->total(),
                    'count'        => $paginator->count(),
                    'per_page'     => $paginator->perPage(),
                    'current_page' => $paginator->currentPage(),
                    'total_pages'  => $paginator->lastPage(),
                ],
            ],
            'links' => [
                'self'  => $paginator->url($paginator->currentPage()),
                'first' => $paginator->url(1),
                'last'  => $paginator->url($paginator->lastPage()),
                'prev'  => $paginator->previousPageUrl(),
                'next'  => $paginator->nextPageUrl(),
            ],
        ];
    }

    /**
     * @param null|array{total:int,pending:int,imported:int,duplicate:int,conflict:int} $rowCounts
     */
    protected function itemResponse(BillTask $task, bool $includeRelated = false, ?array $rowCounts = null): array
    {
        $response = [
            'data' => $this->taskResource($task, $rowCounts),
        ];

        if ($includeRelated) {
            $included             = [];
            $mailMessage          = $task->mailMessage;
            $currentChallenge     = $task->currentSecretChallenge;
            if ($mailMessage instanceof BillMailMessage) {
                $included[] = $this->mailMessageResource($mailMessage);
            }
            foreach ($task->artifacts as $artifact) {
                $included[] = $this->artifactResource($artifact);
            }
            foreach ($task->statementImports as $import) {
                $included[] = $this->statementImportResource($import);
            }
            if ($currentChallenge instanceof BillSecretChallenge) {
                $included[] = $this->secretChallengeResource($currentChallenge);
            }
            foreach ($task->events as $event) {
                $included[] = $this->eventResource($event);
            }
            $response['included'] = $included;
        }

        return $response;
    }

    /**
     * @param EloquentCollection<int, BillArtifact> $artifacts
     */
    protected function artifactCollectionResponse(EloquentCollection $artifacts): array
    {
        return [
            'data' => $artifacts->map(fn (BillArtifact $artifact): array => $this->artifactResource($artifact))->values()->all(),
        ];
    }

    /**
     * @param EloquentCollection<int, BillTaskEvent> $events
     */
    protected function eventCollectionResponse(EloquentCollection $events): array
    {
        return [
            'data' => $events->map(fn (BillTaskEvent $event): array => $this->eventResource($event))->values()->all(),
        ];
    }

    /**
     * @param EloquentCollection<int, BillStatementRow> $rows
     */
    protected function rowCollectionResponse(EloquentCollection $rows): array
    {
        return [
            'data' => $rows->map(fn (BillStatementRow $row): array => $this->statementRowResource($row))->values()->all(),
        ];
    }

    /**
     * @param null|array{total:int,pending:int,imported:int,duplicate:int,conflict:int} $rowCounts
     */
    protected function taskResource(BillTask $task, ?array $rowCounts = null): array
    {
        $rowCounts ??= ['total' => 0, 'pending' => 0, 'imported' => 0, 'duplicate' => 0, 'conflict' => 0];

        return [
            'type'          => 'bill-tasks',
            'id'            => (string) $task->id,
            'attributes'    => [
                'source'                      => $task->source,
                'profile_id'                  => $task->profile_id,
                'status'                      => $task->status,
                'received_at'                 => optional($task->received_at)->toAtomString(),
                'summary'                     => $task->summary,
                'current_secret_challenge_id' => null === $task->current_secret_challenge_id ? null : (string) $task->current_secret_challenge_id,
                'error_code'                  => $task->error_code,
                'error_message'               => $task->error_message,
                'metadata'                    => $this->publicMetadata($task->metadata),
                // Cheap DB-aggregation counts (see BillStatementRowSummaryService::countsForTasks).
                // 'pending' is the "候选行数" (rows still waiting to be stored); 'duplicate'/'conflict'
                // are rows already flagged by the same-source dedup pass. Cross-source match counts
                // are NOT included here (too expensive to compute per row on a list page) -- fetch
                // GET /api/v1/bill-tasks/{id}/review for the full cross-source picture.
                'row_counts'                  => [
                    'total'     => $rowCounts['total'],
                    'pending'   => $rowCounts['pending'],
                    'imported'  => $rowCounts['imported'],
                    'duplicate' => $rowCounts['duplicate'],
                    'conflict'  => $rowCounts['conflict'],
                ],
                'created_at'                  => optional($task->created_at)->toAtomString(),
                'updated_at'                  => optional($task->updated_at)->toAtomString(),
            ],
            'relationships' => [
                'mail_message'      => [
                    'data' => null === $task->bill_mail_message_id ? null : [
                        'type' => 'bill-mail-messages',
                        'id'   => (string) $task->bill_mail_message_id,
                    ],
                ],
                'current_challenge' => [
                    'data' => null === $task->current_secret_challenge_id ? null : [
                        'type' => 'bill-secret-challenges',
                        'id'   => (string) $task->current_secret_challenge_id,
                    ],
                ],
            ],
        ];
    }

    protected function mailMessageResource(BillMailMessage $message): array
    {
        return [
            'type'       => 'bill-mail-messages',
            'id'         => (string) $message->id,
            'attributes' => [
                'message_id'     => $message->message_id,
                'mailbox'        => $message->mailbox,
                'from_address'   => $message->from_address,
                'to_address'     => $message->to_address,
                'subject'        => $message->subject,
                'received_at'    => optional($message->received_at)->toAtomString(),
                'checksum'       => $message->checksum,
                'sync_cursor'    => $message->sync_cursor,
            ],
        ];
    }

    protected function artifactResource(BillArtifact $artifact): array
    {
        $metadata = $this->publicMetadata($artifact->metadata);
        $metadata = is_array($metadata) ? $metadata : [];
        $source   = is_string($metadata['source'] ?? null) ? $metadata['source'] : '';
        $mimeType = is_string($metadata['content_type'] ?? null) ? $metadata['content_type'] : null;
        if (null === $mimeType && is_string($artifact->filename)) {
            $extension = strtolower(pathinfo($artifact->filename, PATHINFO_EXTENSION));
            $mimeType  = MimeTypes::getDefault()->getMimeTypes($extension)[0] ?? null;
        }

        return [
            'type'       => 'bill-artifacts',
            'id'         => (string) $artifact->id,
            'attributes' => [
                'bill_task_id'             => (string) $artifact->bill_task_id,
                'kind'                     => $artifact->kind,
                'filename'                 => $artifact->filename,
                'checksum'                 => $artifact->checksum,
                'encrypted'                => $artifact->encrypted,
                'derived_from_artifact_id' => null === $artifact->derived_from_artifact_id ? null : (string) $artifact->derived_from_artifact_id,
                'metadata'                 => $metadata,
                'mime_type'                => $mimeType ?? 'application/octet-stream',
                'size'                     => is_numeric($metadata['size'] ?? null) ? (int) $metadata['size'] : null,
                'generation_stage'         => match (true) {
                    str_contains($source, 'extract') => 'extracted',
                    'remote_download' === $source    => 'downloaded',
                    null !== $artifact->derived_from_artifact_id => 'derived',
                    default => 'received',
                },
                'download_url'             => route('api.v1.bill-artifacts.download', [$artifact->id]),
                'created_at'               => optional($artifact->created_at)->toAtomString(),
            ],
        ];
    }

    protected function secretChallengeResource(BillSecretChallenge $challenge): array
    {
        return [
            'type'       => 'bill-secret-challenges',
            'id'         => (string) $challenge->id,
            'attributes' => [
                'bill_task_id' => (string) $challenge->bill_task_id,
                'kind'         => $challenge->kind,
                'prompt'       => $challenge->prompt,
                'status'       => $challenge->status,
                'attempts'     => $challenge->attempts,
                'created_at'   => optional($challenge->created_at)->toAtomString(),
                'consumed_at'  => optional($challenge->consumed_at)->toAtomString(),
            ],
        ];
    }

    protected function eventResource(BillTaskEvent $event): array
    {
        return [
            'type'       => 'bill-task-events',
            'id'         => (string) $event->id,
            'attributes' => [
                'bill_task_id' => (string) $event->bill_task_id,
                'event_type'   => $event->event_type,
                'message'      => $event->message,
                'metadata'     => $this->publicMetadata($event->metadata),
                'created_at'   => optional($event->created_at)->toAtomString(),
            ],
        ];
    }

    protected function statementImportResource(BillStatementImport $import): array
    {
        return [
            'type'       => 'bill-statement-imports',
            'id'         => (string) $import->id,
            'attributes' => [
                'bill_task_id'      => (string) $import->bill_task_id,
                'bill_artifact_id'  => (string) $import->bill_artifact_id,
                'source'            => $import->source,
                'profile_id'        => $import->profile_id,
                'archived_filename' => $import->archived_filename,
                'exported_at'       => optional($import->exported_at)->toAtomString(),
                'period_start'      => optional($import->period_start)->toDateString(),
                'period_end'        => optional($import->period_end)->toDateString(),
                'row_count'         => $import->row_count,
                'status'            => $import->status,
                'metadata'          => $this->publicMetadata($import->metadata),
            ],
        ];
    }

    protected function statementRowResource(BillStatementRow $row): array
    {
        $currency = $this->currencyResolver->resolve(auth()->user(), $row);

        return [
            'type'       => 'bill-statement-rows',
            'id'         => (string) $row->id,
            'attributes' => [
                'bill_task_id'             => (string) $row->bill_task_id,
                'bill_statement_import_id' => (string) $row->bill_statement_import_id,
                'row_number'               => $row->row_number,
                'status'                   => $row->status,
                'occurred_at'              => optional($row->occurred_at)->toAtomString(),
                'platform_category'        => $row->platform_category,
                'counterparty'             => $row->counterparty,
                'counterparty_account'     => $row->counterparty_account,
                'description'              => $row->description,
                'direction'                => $row->direction,
                'amount'                   => null === $row->amount ? null : (string) $row->amount,
                'payment_method'           => $row->payment_method,
                'transaction_status'       => $row->transaction_status,
                'platform_order_no'        => $row->platform_order_no,
                'merchant_order_no'        => $row->merchant_order_no,
                'external_key'             => $row->external_key,
                'fingerprint'              => $row->fingerprint,
                'duplicate_state'          => $row->duplicate_state,
                'duplicate_of_row_id'      => null === $row->duplicate_of_row_id ? null : (string) $row->duplicate_of_row_id,
                'user_modified_at'         => optional($row->user_modified_at)->toAtomString(),
                'remark'                   => $row->remark,
                'editable_data'            => $row->editable_data,
                'firefly_type'             => $row->firefly_type,
                'firefly_date'             => optional($row->firefly_date)->toAtomString(),
                'firefly_amount'           => null === $row->firefly_amount ? null : (string) $row->firefly_amount,
                'currency_code'            => $currency->code,
                'currency_symbol'          => $currency->symbol,
                'firefly_description'      => $row->firefly_description,
                'source_name'              => $row->source_name,
                'destination_name'         => $row->destination_name,
                'category_name'            => $row->category_name,
                'notes'                    => $row->notes,
                'tags'                     => $row->tags,
                'transaction_group_id'     => null === $row->transaction_group_id ? null : (string) $row->transaction_group_id,
                'error_message'            => $row->error_message,
                'metadata'                 => $this->publicMetadata($row->metadata),
                'created_at'               => optional($row->created_at)->toAtomString(),
                'updated_at'               => optional($row->updated_at)->toAtomString(),
            ],
        ];
    }

    private function publicMetadata(mixed $metadata): mixed
    {
        if (!is_array($metadata)) {
            return $metadata;
        }

        $public = [];
        foreach ($metadata as $key => $value) {
            if (is_string($key) && $this->isSensitiveMetadataKey($key)) {
                continue;
            }
            if (is_string($value) && str_contains($value, 'tenpay.wechatpay.cn/userroll/userbilldownload/downloadfilefromemail')) {
                continue;
            }

            $public[$key] = $this->publicMetadata($value);
        }

        return $public;
    }

    private function isSensitiveMetadataKey(string $key): bool
    {
        $normalized = strtolower(str_replace('-', '_', $key));
        foreach (['path', 'token', 'secret', 'password', 'credential', 'encrypted_file_data'] as $sensitivePart) {
            if (str_contains($normalized, $sensitivePart)) {
                return true;
            }
        }

        return 'url' === $normalized || str_ends_with($normalized, '_url');
    }
}
