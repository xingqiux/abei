<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\DailyReconciliation;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Services\DailyReconciliation\DailyReconciliationSummaryService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class SummaryController extends Controller
{
    public function __construct(private readonly DailyReconciliationSummaryService $summaryService) {}

    /**
     * 最近 N 天的按天收支汇总 + 对账状态，供 abei-web 新前端使用。
     */
    public function summary(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'days' => ['nullable', 'integer', 'min:1', 'max:366'],
        ]);
        $days      = (int) ($validated['days'] ?? 30);

        return response()->json($this->summaryService->rangeSummary(auth()->user(), $days));
    }
}
