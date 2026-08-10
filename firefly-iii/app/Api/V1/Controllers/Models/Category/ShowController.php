<?php

/*
 * ShowController.php
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
use FireflyIII\Services\Category\DefaultCategorySet;
use FireflyIII\Support\JsonApi\Enrichments\CategoryEnrichment;
use FireflyIII\Transformers\CategoryTransformer;
use FireflyIII\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Pagination\LengthAwarePaginator;
use League\Fractal\Pagination\IlluminatePaginatorAdapter;
use League\Fractal\Resource\Collection as FractalCollection;
use League\Fractal\Resource\Item;

/**
 * Class ShowController
 */
final class ShowController extends Controller
{
    private CategoryRepositoryInterface $repository;

    /**
     * CategoryController constructor.
     */
    public function __construct()
    {
        parent::__construct();
        $this->middleware(function ($request, $next) {
            $this->repository = app(CategoryRepositoryInterface::class);
            $this->repository->setUser(auth()->user());

            return $next($request);
        });
    }

    /**
     * This endpoint is documented at:
     * https://api-docs.firefly-iii.org/?urls.primaryName=2.0.0%20(v1)#/categories/listCategory
     *
     * Display a listing of the resource.
     */
    public function index(Request $request): JsonResponse
    {
        $manager         = $this->getManager();

        // types to get, page size:
        $pageSize        = $this->parameters->get('limit');

        // v0.2 起整套默认词表都是 system=true（system 的意思是「出厂、不可删」，
        // 不再是 v0.1 的「藏起来的内部分类」），所以列表默认就得含 system，
        // 否则选择器、AI 白名单全拿到空表。传 include_system=0 才排除。
        $includeSystem   = $request->boolean('include_system', true);
        if (!$includeSystem) {
            $this->parameters->set('include_system', 'false');
        }

        // 禁用的分类默认不返回：禁用就是「从选择器里消失」。管理页才传 include_disabled=1。
        $includeDisabled = $request->boolean('include_disabled');
        if ($includeDisabled) {
            $this->parameters->set('include_disabled', 'true');
        }

        $domain          = $request->query('domain');
        $domain          = is_string($domain) && in_array($domain, DefaultCategorySet::DOMAINS, true) ? $domain : null;
        if (null !== $domain) {
            $this->parameters->set('domain', $domain);
        }

        // get list of categories. Count it and split it.
        $collection      = $this->repository->getUserCategories($includeSystem, $domain, $includeDisabled);
        $count           = $collection->count();
        $categories      = $collection->slice(($this->parameters->get('page') - 1) * $pageSize, $pageSize);

        // enrich
        /** @var User $admin */
        $admin           = auth()->user();
        $enrichment      = new CategoryEnrichment();
        $enrichment->setUser($admin);
        $enrichment->setStart($this->parameters->get('start'));
        $enrichment->setEnd($this->parameters->get('end'));
        $categories      = $enrichment->enrich($categories);

        // make paginator:
        $paginator       = new LengthAwarePaginator($categories, $count, $pageSize, $this->parameters->get('page'));
        $paginator->setPath(route('api.v1.categories.index').$this->buildParams());

        /** @var CategoryTransformer $transformer */
        $transformer     = app(CategoryTransformer::class);
        $transformer->setParameters($this->parameters);
        $resource        = new FractalCollection($categories, $transformer, 'categories');
        $resource->setPaginator(new IlluminatePaginatorAdapter($paginator));

        return response()->json($manager->createData($resource)->toArray())->header('Content-Type', self::CONTENT_TYPE);
    }

    /**
     * This endpoint is documented at:
     * https://api-docs.firefly-iii.org/?urls.primaryName=2.0.0%20(v1)#/categories/getCategory
     *
     * Show the category.
     */
    public function show(Category $category): JsonResponse
    {
        $manager     = $this->getManager();

        /** @var CategoryTransformer $transformer */
        $transformer = app(CategoryTransformer::class);
        $transformer->setParameters($this->parameters);

        // enrich
        /** @var User $admin */
        $admin       = auth()->user();
        $enrichment  = new CategoryEnrichment();
        $enrichment->setUser($admin);
        $enrichment->setStart($this->parameters->get('start'));
        $enrichment->setEnd($this->parameters->get('end'));
        $category    = $enrichment->enrichSingle($category);

        $resource    = new Item($category, $transformer, 'categories');

        return response()->json($manager->createData($resource)->toArray())->header('Content-Type', self::CONTENT_TYPE);
    }
}
