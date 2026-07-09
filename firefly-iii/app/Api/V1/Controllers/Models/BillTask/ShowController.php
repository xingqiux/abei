<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Api\V1\Requests\PaginationRequest;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillStatementRowSummaryService;
use FireflyIII\User;
use Illuminate\Http\JsonResponse;

final class ShowController extends Controller
{
    use BillTaskResponse;

    public function __construct(private readonly BillStatementRowSummaryService $rowSummaryService) {}

    public function index(PaginationRequest $request): JsonResponse
    {
        ['limit' => $limit, 'page' => $page] = $request->attributes->all();

        /** @var User $user */
        $user                                = auth()->user();

        $query                               = $user->billTasks()
            ->orderByDesc('received_at')
            ->orderByDesc('id')
        ;
        $source                              = (string) $request->query('source', '');
        $status                              = (string) $request->query('status', '');
        if ('' !== $source) {
            $query->where('source', $source);
        }
        if ('' !== $status) {
            $query->where('status', $status);
        }

        $paginator                           = $query->paginate($limit, ['*'], 'page', $page);
        $rowCounts                           = $this->rowSummaryService->countsForTasks($user, $paginator->getCollection()->pluck('id')->all());

        return response()->json($this->collectionResponse($paginator, $rowCounts));
    }

    public function show(BillTask $billTask): JsonResponse
    {
        $billTask->load([
            'mailMessage',
            'artifacts'              => fn ($query) => $query->visibleToUser()->orderBy('id'),
            'statementImports'       => fn ($query) => $query->orderBy('id'),
            'currentSecretChallenge',
            'events'                 => fn ($query) => $query->orderBy('id'),
        ]);

        /** @var User $user */
        $user      = auth()->user();
        $rowCounts = $this->rowSummaryService->countsForTasks($user, [$billTask->id]);

        return response()->json($this->itemResponse($billTask, true, $rowCounts[$billTask->id] ?? null));
    }
}
