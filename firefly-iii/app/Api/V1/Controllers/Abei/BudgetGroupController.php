<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Abei;

use Carbon\Carbon;
use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\AbeiGroupBudget;
use FireflyIII\Models\Category;
use FireflyIII\Services\Category\DefaultCategorySet;
use FireflyIII\Services\Category\GroupBudgetService;
use FireflyIII\Support\Facades\Amount;
use FireflyIII\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * 按支出组的预算。
 *
 * 列表返回支出域全部顶级组，包括没设预算的（amount 为 null）——预算页底部那栏「未设预算」
 * 就是这么来的，不能靠前端拿分类列表再去跟预算列表对。
 */
final class BudgetGroupController extends Controller
{
    public function __construct(private readonly GroupBudgetService $groupBudgetService)
    {
        parent::__construct();
    }

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'start' => ['required', 'date_format:Y-m-d'],
            'end'   => ['required', 'date_format:Y-m-d'],
        ]);

        /** @var User $user */
        $user      = auth()->user();
        [$start, $end] = $this->range($validated['start'], $validated['end']);

        return response()->json(['data' => $this->groupBudgetService->rows($user, $start, $end)]);
    }

    public function update(Request $request, string $categoryId): JsonResponse
    {
        $validated = $request->validate([
            'amount' => ['present', 'nullable', 'numeric', 'min:0'],
            'start'  => ['nullable', 'date_format:Y-m-d'],
            'end'    => ['nullable', 'date_format:Y-m-d'],
        ]);

        /** @var User $user */
        $user      = auth()->user();
        $group     = $this->resolveGroup($user, $categoryId);

        $amount    = $validated['amount'] ?? null;
        if (null === $amount) {
            // 清空即删行。留一条 amount 为 0 的记录的话，「没设预算」和「预算是 0」就分不开了。
            AbeiGroupBudget::where('user_id', $user->id)->where('category_id', $group->id)->delete();
        }
        if (null !== $amount) {
            AbeiGroupBudget::updateOrCreate(
                ['category_id' => (int) $group->id],
                [
                    'user_id'       => $user->id,
                    'amount'        => (string) $amount,
                    'currency_code' => Amount::getPrimaryCurrency()->code,
                ]
            );
        }

        [$start, $end] = $this->range($validated['start'] ?? null, $validated['end'] ?? null);

        return response()->json(['data' => $this->groupBudgetService->row($user, $group->refresh(), $start, $end)]);
    }

    /**
     * PUT 不强制带期间——设预算跟看花了多少是两件事。没带就按当月给回一行。
     *
     * @return array{0: Carbon, 1: Carbon}
     */
    private function range(?string $start, ?string $end): array
    {
        $timezone = config('app.timezone');
        if (null === $start || null === $end) {
            $now = Carbon::now($timezone);

            return [$now->clone()->startOfMonth(), $now->clone()->endOfMonth()];
        }

        return [
            Carbon::createFromFormat('Y-m-d', $start, $timezone)->startOfDay(),
            Carbon::createFromFormat('Y-m-d', $end, $timezone)->endOfDay(),
        ];
    }

    /**
     * @throws ValidationException
     */
    private function resolveGroup(User $user, string $categoryId): Category
    {
        /** @var null|Category $group */
        $group = $user->categories()->find((int) $categoryId);
        if (!$group instanceof Category) {
            throw ValidationException::withMessages([
                'category_id' => ['找不到这个分类。'],
            ]);
        }
        if (DefaultCategorySet::DOMAIN_EXPENSE !== (string) $group->domain || null !== $group->parent_id) {
            throw ValidationException::withMessages([
                'category_id' => ['预算只能设在支出域的顶级组上，子分类的花销自动汇总进组。'],
            ]);
        }

        return $group;
    }
}
