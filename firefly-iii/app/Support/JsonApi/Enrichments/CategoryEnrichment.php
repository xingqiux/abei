<?php

/*
 * CategoryEnrichment.php
 * Copyright (c) 2025 james@firefly-iii.org
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

namespace FireflyIII\Support\JsonApi\Enrichments;

use Carbon\Carbon;
use FireflyIII\Models\Category;
use FireflyIII\Models\Note;
use FireflyIII\Models\UserGroup;
use FireflyIII\Repositories\Category\OperationsRepositoryInterface;
use FireflyIII\Services\Category\CategoryUsageService;
use FireflyIII\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Collection;

class CategoryEnrichment implements EnrichmentInterface
{
    private Collection $collection;
    private array   $children    = [];
    private array   $earned      = [];
    private ?Carbon $end         = null;
    private array   $ids         = [];
    private array   $notes       = [];
    private array   $pcEarned    = [];
    private array   $pcSpent     = [];
    private array   $pcTransfers = [];
    private array   $spent       = [];
    private ?Carbon $start       = null;
    private array   $transfers   = [];
    private array   $usage       = [];
    private User $user;
    private UserGroup $userGroup;

    public function enrich(Collection $collection): Collection
    {
        $this->collection = $collection;
        $this->collectIds();
        $this->collectNotes();
        $this->collectChildren();
        $this->collectUsage();
        $this->collectTransactions();
        $this->appendCollectedData();

        return $collection;
    }

    public function enrichSingle(array|Model $model): array|Model
    {
        // Log::debug(__METHOD__);
        $collection = new Collection()->push($model);
        $collection = $this->enrich($collection);

        return $collection->first();
    }

    public function setEnd(?Carbon $end): void
    {
        $this->end = $end;
    }

    public function setStart(?Carbon $start): void
    {
        $this->start = $start;
    }

    public function setUser(User $user): void
    {
        $this->user = $user;
        $this->setUserGroup($user->userGroup);
    }

    public function setUserGroup(UserGroup $userGroup): void
    {
        $this->userGroup = $userGroup;
    }

    private function appendCollectedData(): void
    {
        $this->collection = $this->collection->map(function (Category $item): Category {
            $id         = (int) $item->id;
            $meta       = [
                'children'           => $this->children[$id] ?? [],
                'transactions_count' => $this->usage[$id]['transactions_count'] ?? 0,
                'last_used'          => $this->usage[$id]['last_used'] ?? null,
                'notes'              => $this->notes[$id] ?? null,
                'spent'              => $this->spent[$id] ?? null,
                'pc_spent'           => $this->pcSpent[$id] ?? null,
                'earned'             => $this->earned[$id] ?? null,
                'pc_earned'          => $this->pcEarned[$id] ?? null,
                'transfers'          => $this->transfers[$id] ?? null,
                'pc_transfers'       => $this->pcTransfers[$id] ?? null,
            ];
            $item->meta = $meta;

            return $item;
        });
    }

    /**
     * 一条查询把这批分类的孩子全捞回来，管理界面直接拿去画树。
     */
    private function collectChildren(): void
    {
        $children = Category::query()
            ->where('user_id', $this->user->id)
            ->whereIn('parent_id', $this->ids)
            ->orderBy('name', 'ASC')
            ->get(['categories.id', 'categories.name', 'categories.parent_id', 'categories.system', 'categories.domain', 'categories.icon', 'categories.color', 'categories.disabled_at'])
        ;

        /** @var Category $child */
        foreach ($children as $child) {
            $parentId                    = (int) $child->parent_id;
            $this->children[$parentId] ??= [];
            $this->children[$parentId][] = [
                'id'          => (string) $child->id,
                'name'        => $child->name,
                'system'      => (bool) $child->system,
                'domain'      => (string) $child->domain,
                'icon'        => $child->icon,
                'color'       => $child->color,
                'disabled_at' => $child->disabled_at?->toAtomString(),
            ];
        }
    }

    private function collectIds(): void
    {
        /** @var Category $category */
        foreach ($this->collection as $category) {
            $this->ids[] = (int) $category->id;
        }
        $this->ids = array_unique($this->ids);
    }

    private function collectNotes(): void
    {
        $notes = Note::query()
            ->whereIn('noteable_id', $this->ids)
            ->whereNotNull('notes.text')
            ->where('notes.text', '!=', '')
            ->where('noteable_type', Category::class)
            ->get(['notes.noteable_id', 'notes.text'])
            ->toArray()
        ;
        foreach ($notes as $note) {
            $this->notes[(int) $note['noteable_id']] = (string) $note['text'];
        }

        //        Log::debug(sprintf('Enrich with %d note(s)', count($this->notes)));
    }

    private function collectTransactions(): void
    {
        if ($this->start instanceof Carbon && $this->end instanceof Carbon) {
            /** @var OperationsRepositoryInterface $opsRepository */
            $opsRepository = app(OperationsRepositoryInterface::class);
            $opsRepository->setUser($this->user);
            $opsRepository->setUserGroup($this->userGroup);
            $expenses      = $opsRepository->collectExpenses($this->start, $this->end, null, $this->collection);
            $income        = $opsRepository->collectIncome($this->start, $this->end, null, $this->collection);
            $transfers     = $opsRepository->collectTransfers($this->start, $this->end, null, $this->collection);
            foreach ($this->collection as $item) {
                $id                     = (int) $item->id;
                $this->spent[$id]       = array_values($opsRepository->sumCollectedTransactionsByCategory($expenses, $item, 'negative'));
                $this->pcSpent[$id]     = array_values($opsRepository->sumCollectedTransactionsByCategory($expenses, $item, 'negative', true));
                $this->earned[$id]      = array_values($opsRepository->sumCollectedTransactionsByCategory($income, $item, 'positive'));
                $this->pcEarned[$id]    = array_values($opsRepository->sumCollectedTransactionsByCategory($income, $item, 'positive', true));
                $this->transfers[$id]   = array_values($opsRepository->sumCollectedTransactionsByCategory($transfers, $item, 'positive'));
                $this->pcTransfers[$id] = array_values($opsRepository->sumCollectedTransactionsByCategory($transfers, $item, 'positive', true));
            }
        }
    }

    /**
     * 笔数和最近使用日期。整批一条聚合查询，不按分类逐个数。
     */
    private function collectUsage(): void
    {
        $this->usage = app(CategoryUsageService::class)->usageFor($this->user, $this->ids);
    }
}
