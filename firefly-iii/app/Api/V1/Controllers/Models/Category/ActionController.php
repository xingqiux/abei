<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\Category;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\Category;
use FireflyIII\Repositories\Category\CategoryRepositoryInterface;
use FireflyIII\Services\Category\CategoryMergeService;
use FireflyIII\Support\Facades\Preferences;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * 分类的整理动作。目前只有合并。
 */
final class ActionController extends Controller
{
    private CategoryRepositoryInterface $repository;

    public function __construct(private readonly CategoryMergeService $mergeService)
    {
        parent::__construct();
        $this->middleware(function ($request, $next) {
            $this->repository = app(CategoryRepositoryInterface::class);
            $this->repository->setUser(auth()->user());

            return $next($request);
        });
    }

    /**
     * POST /api/v1/categories/{category}/merge
     *
     * 把 {category} 名下的交易全迁到 into_id，然后删掉 {category}。不可撤销。
     */
    public function merge(Request $request, Category $category): JsonResponse
    {
        $validated = $request->validate([
            'into_id' => ['required', 'numeric'],
        ]);

        $target    = $this->repository->find((int) $validated['into_id']);
        if (!$target instanceof Category) {
            throw ValidationException::withMessages([
                'into_id' => ['找不到要合并进去的分类。'],
            ]);
        }

        $moved     = $this->mergeService->merge(auth()->user(), $category, $target);
        Preferences::mark();

        return response()->json([
            'data' => [
                'moved_transactions' => $moved,
                'source_id'          => (string) $category->id,
                'target_id'          => (string) $target->id,
                'target_name'        => $target->name,
            ],
        ]);
    }
}
