<?php

declare(strict_types=1);

namespace FireflyIII\Services\Category;

use FireflyIII\Models\Category;
use FireflyIII\User;
use Illuminate\Validation\ValidationException;

/**
 * 分类树的两条规矩，写在一处：
 *
 * 1. 最多两级。父分类自己必须在顶层，有孩子的分类不能再认爹。
 * 2. 同一个父级下名字唯一。跨父级重名是允许的（餐饮/其他 和 交通/其他 是两码事）。
 *
 * 放在服务层而不是 FormRequest，因为 store/update 走 API，重命名走 CategoryUpdateService，
 * 以后 AI 建分类还会走别的入口，规矩只能有一份。
 */
final class CategoryHierarchyService
{
    /**
     * 校验名字在目标父级下没被占用。
     *
     * @param null|Category $parent 目标父级，null 表示顶层
     * @param null|Category $ignore 改名时排除自己
     *
     * @throws ValidationException
     */
    public function assertNameIsFree(User $user, string $name, ?Category $parent, ?Category $ignore = null): void
    {
        $query = $user->categories()->where('name', $name);
        if ($parent instanceof Category) {
            $query->where('parent_id', $parent->id);
        }
        if (!$parent instanceof Category) {
            $query->whereNull('parent_id');
        }
        if ($ignore instanceof Category) {
            $query->where('id', '!=', $ignore->id);
        }
        if (null !== $query->first(['categories.id'])) {
            throw ValidationException::withMessages([
                'name' => [sprintf('同一层级下已经有叫「%s」的分类了。', $name)],
            ]);
        }
    }

    /**
     * 把请求里的 parent_id 解析成父分类，顺便把两级限制查了。
     *
     * @param null|Category $category 正在改的分类，新建时传 null
     *
     * @throws ValidationException
     */
    public function resolveParent(User $user, ?Category $category, mixed $parentId): ?Category
    {
        $parentId = (int) $parentId;
        if (0 === $parentId) {
            return null;
        }

        /** @var null|Category $parent */
        $parent   = $user->categories()->find($parentId);
        if (!$parent instanceof Category) {
            throw ValidationException::withMessages([
                'parent_id' => ['找不到这个父分类。'],
            ]);
        }
        if ($parent->system) {
            throw ValidationException::withMessages([
                'parent_id' => ['系统分类下面不能挂用户分类。'],
            ]);
        }
        if (null !== $parent->parent_id) {
            throw ValidationException::withMessages([
                'parent_id' => ['分类最多两级，不能挂在一个二级分类下面。'],
            ]);
        }
        if ($category instanceof Category) {
            if ((int) $category->id === (int) $parent->id) {
                throw ValidationException::withMessages([
                    'parent_id' => ['分类不能挂在自己下面。'],
                ]);
            }
            if ($category->children()->count() > 0) {
                throw ValidationException::withMessages([
                    'parent_id' => ['这个分类下面还有子分类，先把子分类移走再降级。'],
                ]);
            }
        }

        return $parent;
    }
}
