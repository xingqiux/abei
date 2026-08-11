<?php

declare(strict_types=1);

namespace FireflyIII\Models;

use FireflyIII\Support\Models\ReturnsIntegerIdTrait;
use FireflyIII\Support\Models\ReturnsIntegerUserIdTrait;
use Illuminate\Database\Eloquent\Model;

class BillMailboxSyncState extends Model
{
    use ReturnsIntegerIdTrait;
    use ReturnsIntegerUserIdTrait;

    protected $fillable = [
        'user_id',
        'status',
        'limit',
        'requested_at',
        'started_at',
        'finished_at',
        'result',
        'error_message',
    ];

    protected function casts(): array
    {
        return [
            'user_id'      => 'integer',
            'limit'        => 'integer',
            'requested_at' => 'datetime',
            'started_at'   => 'datetime',
            'finished_at'  => 'datetime',
            'result'       => 'json',
        ];
    }
}
