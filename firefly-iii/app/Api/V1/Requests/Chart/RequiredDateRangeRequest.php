<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Requests\Chart;

use FireflyIII\Api\V1\Requests\AggregateFormRequest;
use FireflyIII\Api\V1\Requests\DateRangeRequest;

final class RequiredDateRangeRequest extends AggregateFormRequest
{
    protected function getRequests(): array
    {
        return [[DateRangeRequest::class, 'required']];
    }
}
