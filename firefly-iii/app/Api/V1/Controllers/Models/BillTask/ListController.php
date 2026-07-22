<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillStatementRowSummaryService;
use FireflyIII\Services\BillIngestion\BillStatementCurrencyResolver;
use Illuminate\Http\JsonResponse;

final class ListController extends Controller
{
    use BillTaskResponse;

    public function __construct(
        private readonly BillStatementRowSummaryService $rowSummaryService,
        private readonly BillStatementCurrencyResolver $currencyResolver,
    ) {}

    public function artifacts(BillTask $billTask): JsonResponse
    {
        return response()->json($this->artifactCollectionResponse($billTask->artifacts()->visibleToUser()->orderBy('id')->get()));
    }

    public function events(BillTask $billTask): JsonResponse
    {
        return response()->json($this->eventCollectionResponse($billTask->events()->orderBy('id')->get()));
    }

    public function rows(BillTask $billTask): JsonResponse
    {
        $filters = [
            'status' => (string) request()->query('status', ''),
            'from'   => (string) request()->query('from', ''),
            'to'     => (string) request()->query('to', ''),
            'limit'  => max(1, (int) request()->query('limit', 20)),
        ];

        if (request()->boolean('summary')) {
            return response()->json($this->rowSummaryService->summarizeTaskRows(auth()->user(), $billTask->id, $filters));
        }

        $query  = $billTask->statementRows()->orderBy('occurred_at', 'desc')->orderBy('row_number');
        $status = $filters['status'];
        $from   = $filters['from'];
        $to     = $filters['to'];
        if ('' !== $status) {
            $query->where('status', $status);
        }
        if ('' !== $from) {
            $query->where('occurred_at', '>=', $from.' 00:00:00');
        }
        if ('' !== $to) {
            $query->where('occurred_at', '<=', $to.' 23:59:59');
        }

        return response()->json($this->rowCollectionResponse($query->get()));
    }

    public function review(BillTask $billTask): JsonResponse
    {
        return response()->json($this->rowSummaryService->reviewTaskRows(auth()->user(), $billTask->id));
    }
}
