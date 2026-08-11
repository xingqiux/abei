<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use Carbon\CarbonInterface;
use FireflyIII\Models\BillStatementImport;
use FireflyIII\Models\BillStatementRow;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

class BillStatementRowIdentityService
{
    private const array SYSTEM_REFRESH_FIELDS = [
        'occurred_at',
        'platform_category',
        'counterparty',
        'counterparty_account',
        'description',
        'direction',
        'amount',
        'payment_method',
        'transaction_status',
        'platform_order_no',
        'merchant_order_no',
        'remark',
        'raw_data',
        'editable_data',
        'firefly_type',
        'firefly_date',
        'firefly_amount',
        'firefly_description',
        'source_name',
        'destination_name',
        'category_name',
        'notes',
        'tags',
    ];

    public function __construct(
        private readonly BillStatementRowDismissalService $dismissalService,
        private readonly BillStatementRowSummaryService $summaryService,
    ) {}

    /**
     * @param array<string,mixed> $attributes
     */
    public function upsertRow(BillStatementImport $import, array $attributes): BillStatementRow
    {
        return DB::transaction(function () use ($import, $attributes): BillStatementRow {
            $attributes['external_key'] = $this->externalKey($import->source, $attributes);
            $attributes['fingerprint']  = $this->fingerprint($import->source, $attributes);
            $weakFingerprint            = $this->weakFingerprint($import->source, $attributes);

            $existing = $this->findExistingRow($import, $attributes);
            if (!$existing instanceof BillStatementRow && null === $attributes['external_key']) {
                $existing = $this->findWeakCandidate($import, $attributes, $weakFingerprint);
            }

            if (!$existing instanceof BillStatementRow) {
                $row = BillStatementRow::query()->create($this->attributesForNewRow($import, $attributes, $weakFingerprint));
                $this->summaryService->classifyRow($row);
                $this->recordImportOutcome($import, 'created', $row);

                return $row;
            }

            if (!$this->coreFieldsMatch($existing, $attributes)) {
                $this->markConflict($existing, $import, $attributes, $weakFingerprint);
                $this->summaryService->classifyRow($existing);
                $this->recordImportOutcome($import, 'conflict', $existing);

                return $existing;
            }

            $preservedUserEdits = null !== $existing->user_modified_at;
            $this->mergeExistingRow($existing, $import, $attributes, $weakFingerprint, $preservedUserEdits);
            $this->summaryService->classifyRow($existing);
            $this->recordImportOutcome($import, $preservedUserEdits ? 'preserved_user_edit' : 'duplicate', $existing);

            return $existing;
        });
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function externalKey(string $source, array $attributes): ?string
    {
        if ('cmb' === $source) {
            return null;
        }

        $platformOrder = $this->cleanScalar($attributes['platform_order_no'] ?? null);
        if ('' !== $platformOrder) {
            return sprintf('%s:order:%s', $source, $platformOrder);
        }

        $merchantOrder = $this->cleanScalar($attributes['merchant_order_no'] ?? null);
        if ('' !== $merchantOrder) {
            return sprintf('%s:merchant:%s', $source, $merchantOrder);
        }

        return null;
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function fingerprint(string $source, array $attributes): string
    {
        return 'sha256:'.hash('sha256', implode('|', [
            $source,
            $this->dateTimeKey($attributes['occurred_at'] ?? null),
            $this->amountKey($attributes['amount'] ?? null),
            $this->normalText($attributes['direction'] ?? null),
            $this->normalText($attributes['counterparty'] ?? null),
            $this->normalText($attributes['description'] ?? null),
            $this->normalText($attributes['platform_category'] ?? null),
            $this->normalText($attributes['payment_method'] ?? null),
        ]));
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function weakFingerprint(string $source, array $attributes): string
    {
        return 'sha256:'.hash('sha256', implode('|', [
            $source,
            $this->dateTimeKey($attributes['occurred_at'] ?? null),
            $this->normalText($attributes['counterparty'] ?? null),
            $this->normalText($attributes['description'] ?? null),
            $this->normalText($attributes['platform_category'] ?? null),
            $this->normalText($attributes['payment_method'] ?? null),
        ]));
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function findExistingRow(BillStatementImport $import, array $attributes): ?BillStatementRow
    {
        $query = BillStatementRow::query()
            ->where('user_id', $import->user_id)
            ->where('bill_statement_import_id', '<>', $import->id)
            ->whereHas('import', static fn (Builder $query): Builder => $query->where('source', $import->source))
        ;

        $externalKey = $attributes['external_key'] ?? null;
        if (is_string($externalKey) && '' !== $externalKey) {
            $row = (clone $query)->where('external_key', $externalKey)->orderBy('id')->first();
            if ($row instanceof BillStatementRow) {
                return $row;
            }

            foreach (['platform_order_no', 'merchant_order_no'] as $field) {
                $orderNumber = $this->cleanScalar($attributes[$field] ?? null);
                if ('' === $orderNumber) {
                    continue;
                }

                $row = (clone $query)->where($field, $orderNumber)->orderBy('id')->first();
                if ($row instanceof BillStatementRow) {
                    return $row;
                }
            }
        }

        $fingerprint = $attributes['fingerprint'] ?? null;
        if (is_string($fingerprint) && '' !== $fingerprint) {
            $row = (clone $query)->where('fingerprint', $fingerprint)->orderBy('id')->first();
            if ($row instanceof BillStatementRow) {
                return $row;
            }
        }

        return null;
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function findWeakCandidate(BillStatementImport $import, array $attributes, string $weakFingerprint): ?BillStatementRow
    {
        $query = BillStatementRow::query()
            ->where('user_id', $import->user_id)
            ->where('bill_statement_import_id', '<>', $import->id)
            ->whereHas('import', static fn (Builder $query): Builder => $query->where('source', $import->source))
            ->orderBy('id')
        ;

        $date = $this->dateKey($attributes['occurred_at'] ?? null);
        if (null !== $date) {
            $query->whereDate('occurred_at', $date);
        }

        /** @var BillStatementRow $row */
        foreach ($query->get() as $row) {
            if ($weakFingerprint === $this->weakFingerprint($import->source, $this->attributesFromRow($row))) {
                return $row;
            }
        }

        return null;
    }

    /**
     * @param array<string,mixed> $attributes
     *
     * @return array<string,mixed>
     */
    private function attributesForNewRow(BillStatementImport $import, array $attributes, string $weakFingerprint): array
    {
        $metadata = is_array($attributes['metadata'] ?? null) ? $attributes['metadata'] : [];
        unset($attributes['metadata']);

        // 五个渠道的 ImportService 建行都从这里过，0 元流水的判定就搁这一处。
        $attributes = $this->dismissalService->applyInitialRules($attributes);

        return $attributes + [
            'user_id'                  => $import->user_id,
            'bill_task_id'             => $import->bill_task_id,
            'bill_statement_import_id' => $import->id,
            'duplicate_state'          => 'unique',
            'metadata'                 => $this->mergeIdentityMetadata($metadata, $import, $attributes, $weakFingerprint),
        ];
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function mergeExistingRow(BillStatementRow $row, BillStatementImport $import, array $attributes, string $weakFingerprint, bool $preserveUserEdits): void
    {
        if (!$preserveUserEdits) {
            foreach (self::SYSTEM_REFRESH_FIELDS as $field) {
                if (array_key_exists($field, $attributes)) {
                    $row->{$field} = $attributes[$field];
                }
            }
        }

        $row->external_key    = $attributes['external_key'];
        $row->fingerprint     = $attributes['fingerprint'];
        $row->duplicate_state = 'duplicate';
        $row->metadata        = $this->mergeIdentityMetadata(
            is_array($row->metadata) ? $row->metadata : [],
            $import,
            $attributes,
            $weakFingerprint,
            $preserveUserEdits ? 'preserved_user_edit' : 'duplicate'
        );
        $row->save();
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function markConflict(BillStatementRow $row, BillStatementImport $import, array $attributes, string $weakFingerprint): void
    {
        if (null === $row->external_key && is_string($attributes['external_key'] ?? null)) {
            $row->external_key = $attributes['external_key'];
        }
        if (null === $row->fingerprint && is_string($attributes['fingerprint'] ?? null)) {
            $row->fingerprint = $attributes['fingerprint'];
        }

        $row->duplicate_state = 'conflict';
        $row->metadata        = $this->mergeIdentityMetadata(
            is_array($row->metadata) ? $row->metadata : [],
            $import,
            $attributes,
            $weakFingerprint,
            'conflict'
        );
        $row->save();
    }

    /**
     * @param array<string,mixed> $metadata
     * @param array<string,mixed> $attributes
     *
     * @return array<string,mixed>
     */
    private function mergeIdentityMetadata(array $metadata, BillStatementImport $import, array $attributes, string $weakFingerprint, string $state = 'created'): array
    {
        $identity = is_array($metadata['identity'] ?? null) ? $metadata['identity'] : [];

        $identity['weak_fingerprint']  = $weakFingerprint;
        $identity['seen_import_ids']   = $this->appendUniqueInt($identity['seen_import_ids'] ?? [], $import->id);
        $identity['seen_task_ids']     = $this->appendUniqueInt($identity['seen_task_ids'] ?? [], $import->bill_task_id);
        $identity['seen_artifact_ids'] = $this->appendUniqueInt($identity['seen_artifact_ids'] ?? [], $import->bill_artifact_id);
        $identity['appearances']       = $this->appendAppearance($identity['appearances'] ?? [], [
            'bill_task_id'             => $import->bill_task_id,
            'bill_statement_import_id' => $import->id,
            'bill_artifact_id'         => $import->bill_artifact_id,
            'row_number'               => (int) ($attributes['row_number'] ?? 0),
            'state'                    => $state,
        ]);

        $metadata['identity'] = $identity;

        return $metadata;
    }

    private function recordImportOutcome(BillStatementImport $import, string $state, BillStatementRow $row): void
    {
        $metadata = is_array($import->metadata) ? $import->metadata : [];
        $identity = is_array($metadata['identity'] ?? null) ? $metadata['identity'] : [];

        if ('created' === $state) {
            $identity['created_row_ids'] = $this->appendUniqueInt($identity['created_row_ids'] ?? [], $row->id);
        }
        if ('duplicate' === $state || 'preserved_user_edit' === $state) {
            $identity['duplicate_row_ids'] = $this->appendUniqueInt($identity['duplicate_row_ids'] ?? [], $row->id);
        }
        if ('conflict' === $state) {
            $identity['conflict_row_ids'] = $this->appendUniqueInt($identity['conflict_row_ids'] ?? [], $row->id);
        }
        if ('preserved_user_edit' === $state) {
            $identity['preserved_user_edit_row_ids'] = $this->appendUniqueInt($identity['preserved_user_edit_row_ids'] ?? [], $row->id);
        }

        $identity['stats'] = [
            'created'              => count($identity['created_row_ids'] ?? []),
            'duplicate'            => count($identity['duplicate_row_ids'] ?? []),
            'conflict'             => count($identity['conflict_row_ids'] ?? []),
            'preserved_user_edits' => count($identity['preserved_user_edit_row_ids'] ?? []),
        ];

        $metadata['identity'] = $identity;
        $import->metadata     = $metadata;
        $import->save();
    }

    /**
     * @param array<string,mixed> $attributes
     */
    private function coreFieldsMatch(BillStatementRow $row, array $attributes): bool
    {
        return $this->dateTimeKey($row->occurred_at) === $this->dateTimeKey($attributes['occurred_at'] ?? null)
            && $this->amountKey($row->amount) === $this->amountKey($attributes['amount'] ?? null)
            && $this->normalText($row->direction) === $this->normalText($attributes['direction'] ?? null)
        ;
    }

    /**
     * @return array<string,mixed>
     */
    private function attributesFromRow(BillStatementRow $row): array
    {
        return [
            'occurred_at'        => $row->occurred_at,
            'amount'             => $row->amount,
            'direction'          => $row->direction,
            'counterparty'       => $row->counterparty,
            'description'        => $row->description,
            'platform_category'  => $row->platform_category,
            'payment_method'     => $row->payment_method,
            'platform_order_no'  => $row->platform_order_no,
            'merchant_order_no'  => $row->merchant_order_no,
        ];
    }

    /**
     * @param mixed $values
     *
     * @return array<int,int>
     */
    private function appendUniqueInt(mixed $values, int $value): array
    {
        $items = is_array($values) ? array_map('intval', $values) : [];
        if (!in_array($value, $items, true)) {
            $items[] = $value;
        }

        return array_values($items);
    }

    /**
     * @param mixed               $appearances
     * @param array<string,mixed> $appearance
     *
     * @return array<int,array<string,mixed>>
     */
    private function appendAppearance(mixed $appearances, array $appearance): array
    {
        $items = is_array($appearances) ? $appearances : [];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            if ((int) ($item['bill_statement_import_id'] ?? 0) === $appearance['bill_statement_import_id']
                && (int) ($item['row_number'] ?? 0) === $appearance['row_number']) {
                return $items;
            }
        }

        $items[] = $appearance;

        return $items;
    }

    private function dateTimeKey(mixed $value): string
    {
        if ($value instanceof CarbonInterface) {
            return $value->format('Y-m-d H:i:s');
        }
        if (is_string($value) && '' !== trim($value)) {
            return Carbon::parse($value, 'Asia/Shanghai')->format('Y-m-d H:i:s');
        }

        return '';
    }

    private function dateKey(mixed $value): ?string
    {
        $dateTime = $this->dateTimeKey($value);
        if ('' === $dateTime) {
            return null;
        }

        return substr($dateTime, 0, 10);
    }

    private function amountKey(mixed $value): string
    {
        if (null === $value || '' === trim((string) $value)) {
            return '';
        }

        return number_format((float) $value, 2, '.', '');
    }

    private function cleanScalar(mixed $value): string
    {
        if (null === $value) {
            return '';
        }

        $text = trim((string) $value);

        return in_array($text, ['/', '-', '--'], true) ? '' : $text;
    }

    private function normalText(mixed $value): string
    {
        $text = mb_strtolower($this->cleanScalar($value));

        return trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
    }
}
