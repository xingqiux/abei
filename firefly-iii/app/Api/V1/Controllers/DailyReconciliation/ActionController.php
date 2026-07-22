<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\DailyReconciliation;

use Carbon\Carbon;
use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Services\DailyReconciliation\DailyReconciliationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class ActionController extends Controller
{
    public function __construct(private readonly DailyReconciliationService $service) {}

    public function reconcile(Request $request, string $reconciliationDate): JsonResponse
    {
        $request->merge(['date' => $reconciliationDate]);
        $validated = $request->validate([
            'date' => ['required', 'date_format:Y-m-d'],
        ]);
        $day       = Carbon::createFromFormat('!Y-m-d', $validated['date'], config('app.timezone'));

        return response()->json($this->service->reconcile(auth()->user(), $day));
    }
}
