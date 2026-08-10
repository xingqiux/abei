<?php

declare(strict_types=1);

namespace FireflyIII\Models;

use FireflyIII\Support\Models\ReturnsIntegerIdTrait;
use FireflyIII\Support\Models\ReturnsIntegerUserIdTrait;
use FireflyIII\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * 一个支出组的预算额。按月口径，一个组最多一行。
 *
 * amount 不做 float/decimal 转换，全程当字符串走 bcmath——金额过一遍 float 就再也说不清尾数。
 */
class AbeiGroupBudget extends Model
{
    use ReturnsIntegerIdTrait;
    use ReturnsIntegerUserIdTrait;

    protected $fillable = ['user_id', 'category_id', 'amount', 'currency_code'];

    protected $table    = 'abaku_group_budgets';

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    protected function casts(): array
    {
        return [
            'created_at'  => 'datetime',
            'updated_at'  => 'datetime',
            'user_id'     => 'integer',
            'category_id' => 'integer',
        ];
    }
}
