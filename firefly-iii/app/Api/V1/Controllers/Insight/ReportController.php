<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Insight;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Api\V1\Requests\Insight\GenericRequest;
use FireflyIII\Services\FinancialReportService;
use Illuminate\Http\JsonResponse;

final class ReportController extends Controller
{
    public function __construct(private readonly FinancialReportService $service) {}

    public function overview(GenericRequest $request): JsonResponse
    {
        return response()->json([
            'data' => $this->service->overview(auth()->user(), $request->getStart(), $request->getEnd()),
        ]);
    }
}
