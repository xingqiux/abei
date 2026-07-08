<?php

declare(strict_types=1);

namespace FireflyIII\Casts;

use Carbon\Carbon;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;

/**
 * Class BillStatementLocalDateTimeCast.
 *
 * Bill statement rows (Alipay / WeChat / CMB / BOC / manual-OCR) store their
 * "occurred_at" / "firefly_date" columns as naive `DATETIME` values with no
 * embedded UTC offset, and no sibling "*_tz" column the way
 * `transaction_journals.date` has `date_tz` (see SeparateTimezoneCaster).
 *
 * Every parser in app/Services/BillIngestion builds these values with an
 * explicit `Carbon::parse($raw, 'Asia/Shanghai')`, because every supported
 * source today reports Beijing wall-clock time. But Laravel's plain
 * 'datetime' cast re-reads that naive string using whichever timezone is
 * ambient at read time (PHP's default timezone, driven by
 * config('app.timezone') / the TZ env var) -- NOT the timezone the value was
 * actually written in. If a worker, queue process, or test run ever executes
 * under a different app timezone than Asia/Shanghai, the exact same DB row
 * resolves to a DIFFERENT absolute instant depending on who reads it, without
 * any error or warning. That is the "naive-wall-clock storage landmine"
 * described in docs/bill-statement-timezone-convention.md.
 *
 * This cast makes bill statement local-time columns immune to that: they
 * always round-trip through a FIXED timezone (Asia/Shanghai by default),
 * regardless of config('app.timezone'). Values that already carry an
 * explicit offset (e.g. "2026-06-23T13:35:00+08:00") are honored as-is --
 * only genuinely naive values are interpreted as the fixed timezone.
 */
final class BillStatementLocalDateTimeCast implements CastsAttributes
{
    public const string DEFAULT_TIMEZONE = 'Asia/Shanghai';

    public function __construct(private readonly string $timezone = self::DEFAULT_TIMEZONE) {}

    /**
     * @param array<string, mixed> $attributes
     */
    public function get(Model $model, string $key, mixed $value, array $attributes): ?Carbon
    {
        if (null === $value || '' === $value) {
            return null;
        }

        return Carbon::parse($value, $this->timezone);
    }

    /**
     * @param array<string, mixed> $attributes
     */
    public function set(Model $model, string $key, mixed $value, array $attributes): ?string
    {
        if (null === $value || '' === $value) {
            return null;
        }

        $carbon = $value instanceof CarbonInterface
            ? Carbon::instance($value)
            : Carbon::parse((string) $value, $this->timezone);

        return $carbon->clone()->setTimezone($this->timezone)->format('Y-m-d H:i:s');
    }
}
