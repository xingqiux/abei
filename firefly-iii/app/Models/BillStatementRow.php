<?php

declare(strict_types=1);

namespace FireflyIII\Models;

use FireflyIII\Casts\BillStatementLocalDateTimeCast;
use FireflyIII\Support\Models\ReturnsIntegerIdTrait;
use FireflyIII\Support\Models\ReturnsIntegerUserIdTrait;
use FireflyIII\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

class BillStatementRow extends Model
{
    use ReturnsIntegerIdTrait;
    use ReturnsIntegerUserIdTrait;

    protected $fillable = [
        'user_id',
        'bill_task_id',
        'bill_statement_import_id',
        'row_number',
        'status',
        'review_state',
        'confirm_reason',
        'excluded_reason',
        'event_group_id',
        'hint_flags',
        'dismissed_reason',
        'dismissed_at',
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
        'external_key',
        'fingerprint',
        'duplicate_of_row_id',
        'duplicate_state',
        'user_modified_at',
        'suggested_by',
        'suggested_at',
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
        'transaction_group_id',
        'error_message',
        'metadata',
    ];

    /**
     * @throws NotFoundHttpException
     */
    public static function routeBinder(self|string $value): self
    {
        if ($value instanceof self) {
            $value = (int) $value->id;
        }
        if (auth()->check()) {
            $rowId = (int) $value;

            /** @var null|self $row */
            $row   = self::query()->where('user_id', auth()->id())->find($rowId);
            if (null !== $row) {
                return $row;
            }
        }

        throw new NotFoundHttpException();
    }

    public function billTask(): BelongsTo
    {
        return $this->belongsTo(BillTask::class);
    }

    public function import(): BelongsTo
    {
        return $this->belongsTo(BillStatementImport::class, 'bill_statement_import_id');
    }

    public function transactionGroup(): BelongsTo
    {
        return $this->belongsTo(TransactionGroup::class);
    }

    public function duplicateOf(): BelongsTo
    {
        return $this->belongsTo(self::class, 'duplicate_of_row_id');
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    protected function casts(): array
    {
        return [
            'created_at'                 => 'datetime',
            'updated_at'                 => 'datetime',
            'occurred_at'                => BillStatementLocalDateTimeCast::class,
            'firefly_date'               => BillStatementLocalDateTimeCast::class,
            'user_modified_at'           => BillStatementLocalDateTimeCast::class,
            'suggested_at'               => BillStatementLocalDateTimeCast::class,
            'dismissed_at'               => BillStatementLocalDateTimeCast::class,
            'raw_data'                   => 'json',
            'editable_data'              => 'json',
            'tags'                       => 'json',
            'metadata'                   => 'json',
            'hint_flags'                 => 'json',
            'user_id'                    => 'integer',
            'bill_task_id'               => 'integer',
            'bill_statement_import_id'   => 'integer',
            'row_number'                 => 'integer',
            'transaction_group_id'       => 'integer',
            'duplicate_of_row_id'        => 'integer',
            'amount'                     => 'decimal:2',
            'firefly_amount'             => 'decimal:2',
        ];
    }
}
