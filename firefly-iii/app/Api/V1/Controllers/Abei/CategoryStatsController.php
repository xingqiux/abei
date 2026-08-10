<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Abei;

use Carbon\Carbon;
use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\Category;
use FireflyIII\Services\Category\CategoryUsageService;
use FireflyIII\User;
use Illuminate\Http\JsonResponse;

/**
 * 分类管理页顶部那几个数：未分类多少笔、每个分类近一年用了多少次、最后一次是什么时候。
 *
 * 单独一个端点而不是塞进 /categories：那边一次只返回一页，管理页要的是整棵树的统计，
 * 而且这几个数跟分页、跟 domain 过滤都没关系。
 */
final class CategoryStatsController extends Controller
{
    public function __construct(private readonly CategoryUsageService $usageService)
    {
        parent::__construct();
    }

    public function index(): JsonResponse
    {
        /** @var User $user */
        $user       = auth()->user();

        $categories = $user->categories()->get(['categories.id']);
        $ids        = $categories->pluck('id')->map(static fn ($id): int => (int) $id)->all();
        $usage      = $this->usageService->usageFor($user, $ids);

        // 近一年的笔数得单算：usageFor 给的是全时段口径，管理页要的是「最近还在用吗」
        $since      = Carbon::now(config('app.timezone'))->subYear();
        $recent     = $this->usageService->usageFor($user, $ids, $since);

        $rows       = [];

        /** @var Category $category */
        foreach ($categories as $category) {
            $id     = (int) $category->id;
            $rows[] = [
                'id'             => (string) $id,
                'txn_count_365d' => (int) ($recent[$id]['transactions_count'] ?? 0),
                'last_used_at'   => ($usage[$id]['last_used'] ?? null)?->toAtomString(),
            ];
        }

        return response()->json([
            'data' => [
                'uncategorized_count' => $this->usageService->uncategorizedCount($user),
                'categories'          => $rows,
            ],
        ]);
    }
}
