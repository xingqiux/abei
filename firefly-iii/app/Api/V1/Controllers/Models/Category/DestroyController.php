<?php

/*
 * DestroyController.php
 * Copyright (c) 2021 james@firefly-iii.org
 *
 * This file is part of Firefly III (https://github.com/firefly-iii).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\Category;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\Category;
use FireflyIII\Repositories\Category\CategoryRepositoryInterface;
use FireflyIII\Services\Category\CategoryMergeService;
use FireflyIII\Services\Category\CategoryUsageService;
use FireflyIII\Support\Facades\Preferences;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * Class DestroyController
 */
final class DestroyController extends Controller
{
    private CategoryRepositoryInterface $repository;

    /**
     * CategoryController constructor.
     */
    public function __construct(
        private readonly CategoryMergeService $mergeService,
        private readonly CategoryUsageService $usageService,
    ) {
        parent::__construct();
        $this->middleware(function ($request, $next) {
            $this->repository = app(CategoryRepositoryInterface::class);
            $this->repository->setUser(auth()->user());

            return $next($request);
        });
    }

    /**
     * This endpoint is documented at:
     * https://api-docs.firefly-iii.org/?urls.primaryName=2.0.0%20(v1)#/categories/deleteCategory
     *
     * Remove the specified resource from storage.
     *
     * ?migrate_to={id} 先把名下交易迁到目标分类再删。名下还有交易又没给迁移目标的，
     * 直接 422 挡回去——删掉分类交易就成了未分类，那不是用户按「删除」时想要的结果。
     */
    public function destroy(Request $request, Category $category): JsonResponse
    {
        // 默认词表是产品出厂能力，删了 AI 白名单和历史统计都会缺一块。用户只能禁用它们。
        if ($category->system) {
            throw ValidationException::withMessages([
                'id' => ['系统分类不能删除，只能禁用。'],
            ]);
        }

        $migrateTo = $request->query('migrate_to');
        if (null !== $migrateTo && '' !== $migrateTo) {
            $target = $this->repository->find((int) $migrateTo);
            if (!$target instanceof Category) {
                throw ValidationException::withMessages([
                    'migrate_to' => ['找不到要迁移过去的分类。'],
                ]);
            }

            // 迁移 + 删除是同一个动作，交给合并服务：它连规则和定期交易一起改，
            // 只搬交易的话下次记账老分类名又会被规则写回来。
            $moved  = $this->mergeService->merge(auth()->user(), $category, $target);
            Preferences::mark();

            return response()->json(['data' => ['moved_transactions' => $moved, 'target_id' => (string) $target->id]]);
        }

        $count     = $this->usageService->transactionCount(auth()->user(), (int) $category->id);
        if ($count > 0) {
            throw ValidationException::withMessages([
                'migrate_to' => [sprintf('「%s」名下还有 %d 笔交易，删除前先指定 migrate_to 把交易迁走。', $category->name, $count)],
            ]);
        }

        $this->repository->destroy($category);
        Preferences::mark();

        return response()->json([], 204);
    }
}
