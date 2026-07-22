<?php

/*
 * StoreController.php
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

namespace FireflyIII\Api\V1\Controllers\Models\Budget;

use Carbon\Carbon;
use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Api\V1\Requests\Models\Budget\StoreRequest;
use FireflyIII\Exceptions\FireflyException;
use FireflyIII\Repositories\Budget\BudgetRepositoryInterface;
use FireflyIII\Repositories\Budget\BudgetLimitRepositoryInterface;
use FireflyIII\Rules\IsValidPositiveAmount;
use FireflyIII\Support\JsonApi\Enrichments\BudgetEnrichment;
use FireflyIII\Transformers\BudgetTransformer;
use FireflyIII\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use League\Fractal\Resource\Item;

/**
 * Class StoreController
 */
final class StoreController extends Controller
{
    private BudgetRepositoryInterface $repository;

    /**
     * StoreController constructor.
     */
    public function __construct()
    {
        parent::__construct();
        $this->middleware(function ($request, $next) {
            $this->repository = app(BudgetRepositoryInterface::class);
            $this->repository->setUser(auth()->user());

            return $next($request);
        });
    }

    /**
     * This endpoint is documented at:
     * https://api-docs.firefly-iii.org/?urls.primaryName=2.0.0%20(v1)#/budgets/storeBudget
     *
     * Store a budget.
     *
     * @throws FireflyException
     */
    public function store(StoreRequest $request): JsonResponse
    {
        $data        = $request->getAll();
        $data['fire_webhooks'] ??= true;
        $budget      = $this->repository->store($data);
        $budget->refresh();
        $manager     = $this->getManager();

        // enrich
        /** @var User $admin */
        $admin       = auth()->user();
        $enrichment  = new BudgetEnrichment();
        $enrichment->setUser($admin);
        $budget      = $enrichment->enrichSingle($budget);

        /** @var BudgetTransformer $transformer */
        $transformer = app(BudgetTransformer::class);
        $transformer->setParameters($this->parameters);

        $resource    = new Item($budget, $transformer, 'budgets');

        return response()->json($manager->createData($resource)->toArray())->header('Content-Type', self::CONTENT_TYPE);
    }

    public function storeWithLimit(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name'         => ['required', 'string', 'min:1', 'max:255', 'uniqueObjectForUser:budgets,name'],
            'active'       => ['nullable', 'boolean'],
            'limit'        => ['required', 'array'],
            'limit.start'  => ['required', 'date', 'before_or_equal:limit.end'],
            'limit.end'    => ['required', 'date', 'after_or_equal:limit.start'],
            'limit.amount' => ['required', new IsValidPositiveAmount()],
            'limit.currency_code' => ['nullable', 'string', 'min:3', 'max:51', 'exists:transaction_currencies,code'],
        ]);

        $result = DB::transaction(function () use ($validated): array {
            $budget = $this->repository->store([
                'name'          => $validated['name'],
                'active'        => (bool) ($validated['active'] ?? true),
                'fire_webhooks' => true,
            ]);

            /** @var BudgetLimitRepositoryInterface $limitRepository */
            $limitRepository = app(BudgetLimitRepositoryInterface::class);
            $limitRepository->setUser(auth()->user());
            $limit = $limitRepository->store([
                'budget_id'     => $budget->id,
                'start_date'    => Carbon::parse($validated['limit']['start'], config('app.timezone')),
                'end_date'      => Carbon::parse($validated['limit']['end'], config('app.timezone')),
                'amount'        => (string) $validated['limit']['amount'],
                'currency_code' => $validated['limit']['currency_code'] ?? null,
                'fire_webhooks' => true,
            ]);

            return [
                'budget_id'       => (string) $budget->id,
                'budget_limit_id' => (string) $limit->id,
            ];
        });

        return response()->json(['data' => ['type' => 'budget-with-limit', 'attributes' => $result]], 201);
    }
}
