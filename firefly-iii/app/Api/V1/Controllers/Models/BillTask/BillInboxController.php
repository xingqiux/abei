<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Services\BillIngestion\BillInboxSummaryService;
use FireflyIII\Services\BillIngestion\BillTaskActionService;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class BillInboxController extends Controller
{
    public function __construct(
        private readonly BillTaskProcessor $taskProcessor,
        private readonly BillTaskActionService $actionService,
        private readonly BillInboxSummaryService $summaryService,
    ) {}

    /**
     * 账单收件箱首页/侧栏用的渠道计数汇总，供 abei-web 新前端使用。
     */
    public function summary(): JsonResponse
    {
        return response()->json($this->summaryService->apiSummary(auth()->user()));
    }

    public function inboxSummary(): JsonResponse
    {
        return response()->json($this->summaryService->inboxSummary(auth()->user()));
    }

    public function process(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:500'],
        ]);
        $result    = $this->taskProcessor->processBatch((int) ($validated['limit'] ?? 25), auth()->user());

        return response()->json([
            'data' => [
                'type'       => 'bill-inbox-process-result',
                'attributes' => [
                    'processed' => $result->processed,
                    'failed'    => $result->failed,
                ],
            ],
        ]);
    }

    public function cleanupStale(): JsonResponse
    {
        $archived = $this->actionService->cleanupStale(auth()->user());

        return response()->json([
            'data' => [
                'type'       => 'bill-inbox-cleanup-result',
                'attributes' => [
                    'archived' => $archived,
                ],
            ],
        ]);
    }

}
