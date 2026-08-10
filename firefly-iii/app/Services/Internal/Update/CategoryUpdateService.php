<?php

/**
 * CategoryUpdateService.php
 * Copyright (c) 2019 james@firefly-iii.org
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

namespace FireflyIII\Services\Internal\Update;

use Exception;
use FireflyIII\Models\Category;
use FireflyIII\Models\Note;
use FireflyIII\Models\RecurrenceTransactionMeta;
use FireflyIII\Models\RuleAction;
use FireflyIII\Models\RuleTrigger;
use FireflyIII\Services\Category\CategoryHierarchyService;
use FireflyIII\User;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

/**
 * Class CategoryUpdateService
 */
class CategoryUpdateService
{
    private User $user;

    /**
     * Constructor.
     */
    public function __construct()
    {
        if (auth()->check()) {
            /** @var User $user */
            $user       = auth()->user();
            $this->user = $user;
        }
    }

    public function setUser(User $user): void
    {
        $this->user = $user;
    }

    /**
     * @throws Exception
     */
    public function update(Category $category, array $data): Category
    {
        $oldName   = $category->name;

        // 出厂分类可改名（和 Monarch 一致）；改名后 AI 引擎会把指向旧名的规则
        // 自动停用并写明原因，白名单下一轮拉取即更新，不会散架。
        // 先把树的规矩过一遍：改父级和改名都可能踩到「最多两级」「同级重名」。
        // 换了父级之后名字要跟新的兄弟比，所以两件事得一起判，不能各判各的。
        $parent    = $category->parent;
        $hierarchy = app(CategoryHierarchyService::class);
        if (array_key_exists('parent_id', $data)) {
            $parent = $hierarchy->resolveParent($this->user, $category, $data['parent_id']);
        }
        $newName   = array_key_exists('name', $data) ? (string) $data['name'] : $category->name;
        $hierarchy->assertNameIsFree($this->user, $newName, $parent, $category);

        if (array_key_exists('parent_id', $data)) {
            $category->parent_id = $parent?->id;
            // 子分类跟着父级走域，不然会出现「支出组下挂着一条收入分类」
            if ($parent instanceof Category) {
                $category->domain = $parent->domain;
            }
            $category->save();
        }

        if (array_key_exists('name', $data)) {
            $category->name = $data['name'];
            $category->save();
            // update triggers and actions
            $this->updateRuleTriggers($oldName, $data['name']);
            $this->updateRuleActions($oldName, $data['name']);
            $this->updateRecurrences($oldName, $data['name']);
        }

        $this->updateAppearance($category, $data);
        $this->updateNotes($category, $data);

        return $category;
    }

    /**
     * 图标、色号、禁用。
     *
     * 「禁用」对外是布尔 disabled，对内是 disabled_at 时间戳——重复禁用不刷新时间戳，
     * 不然「从哪天起不再出现在选择器里」这个问题就答不上来了。
     */
    private function updateAppearance(Category $category, array $data): void
    {
        $dirty = false;
        if (array_key_exists('icon', $data)) {
            $category->icon  = null === $data['icon'] ? null : (string) $data['icon'];
            $dirty           = true;
        }
        if (array_key_exists('color', $data)) {
            $category->color = null === $data['color'] ? null : (string) $data['color'];
            $dirty           = true;
        }
        if (array_key_exists('disabled', $data)) {
            $disabled = (bool) $data['disabled'];
            if ($disabled && null === $category->disabled_at) {
                $category->disabled_at = now();
                $dirty                 = true;
            }
            if (!$disabled && null !== $category->disabled_at) {
                $category->disabled_at = null;
                $dirty                 = true;
            }
        }
        if ($dirty) {
            $category->save();
        }
    }

    /**
     * @throws Exception
     */
    private function updateNotes(Category $category, array $data): void
    {
        $note         = $data['notes'] ?? null;
        if (null === $note) {
            return;
        }
        if ('' === $note) {
            $dbNote = $category->notes()->first();
            $dbNote?->delete();

            return;
        }
        $dbNote       = $category->notes()->first();
        if (null === $dbNote) {
            $dbNote = new Note();
            $dbNote->noteable()->associate($category);
        }
        $dbNote->text = trim((string) $note);
        $dbNote->save();
    }

    private function updateRecurrences(string $oldName, string $newName): void
    {
        RecurrenceTransactionMeta::leftJoin('recurrences_transactions', 'rt_meta.rt_id', '=', 'recurrences_transactions.id')
            ->leftJoin('recurrences', 'recurrences.id', '=', 'recurrences_transactions.recurrence_id')
            ->where('recurrences.user_id', $this->user->id)
            ->where('rt_meta.name', 'category_name')
            ->where('rt_meta.value', $oldName)
            ->update(['rt_meta.value' => $newName])
        ;
    }

    private function updateRuleActions(string $oldName, string $newName): void
    {
        $types   = ['set_category'];
        $actions = RuleAction::leftJoin('rules', 'rules.id', '=', 'rule_actions.rule_id')
            ->where('rules.user_id', $this->user->id)
            ->whereIn('rule_actions.action_type', $types)
            ->where('rule_actions.action_value', $oldName)
            ->get(['rule_actions.*'])
        ;
        Log::debug(sprintf('Found %d actions to update.', $actions->count()));

        /** @var RuleAction $action */
        foreach ($actions as $action) {
            $action->action_value = $newName;
            $action->save();
            Log::debug(sprintf('Updated action %d: %s', $action->id, $action->action_value));
        }
    }

    private function updateRuleTriggers(string $oldName, string $newName): void
    {
        $types    = ['category_is'];
        $triggers = RuleTrigger::leftJoin('rules', 'rules.id', '=', 'rule_triggers.rule_id')
            ->where('rules.user_id', $this->user->id)
            ->whereIn('rule_triggers.trigger_type', $types)
            ->where('rule_triggers.trigger_value', $oldName)
            ->get(['rule_triggers.*'])
        ;
        Log::debug(sprintf('Found %d triggers to update.', $triggers->count()));

        /** @var RuleTrigger $trigger */
        foreach ($triggers as $trigger) {
            $trigger->trigger_value = $newName;
            $trigger->save();
            Log::debug(sprintf('Updated trigger %d: %s', $trigger->id, $trigger->trigger_value));
        }
    }
}
