<?php

declare(strict_types=1);

namespace FireflyIII\Console\Commands\Abei;

use FireflyIII\Console\Commands\ShowsFriendlyMessages;
use FireflyIII\Models\AbeiGroupBudget;
use FireflyIII\Models\Category;
use FireflyIII\Services\Category\CategoryUsageService;
use FireflyIII\Services\Category\DefaultCategorySet;
use FireflyIII\Services\Internal\Destroy\CategoryDestroyService;
use FireflyIII\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * 分类推倒重建的执行入口。
 *
 * 删的是分类，不是交易：走 CategoryDestroyService，它只摘掉分类和交易之间的关系行，
 * 交易本身原地不动，变成「未分类」。这是不可撤销的，所以不带 --force 时只报数不动手。
 */
class ResetCategories extends Command
{
    use ShowsFriendlyMessages;

    protected $description = '删掉某个用户的全部分类（交易保留、变成未分类），再种入 v0.2 默认词表。';

    protected $signature   = 'abei:reset-categories {--force : 真的执行；不给这个开关只打印影响面} {--email= : 指定用户邮箱，默认第一个用户}';

    public function handle(CategoryUsageService $usageService, DefaultCategorySet $defaultSet): int
    {
        $user        = $this->resolveUser();
        if (!$user instanceof User) {
            return 1;
        }

        $categories  = $user->categories()->get();
        $ids         = $categories->pluck('id')->map(static fn ($id): int => (int) $id)->all();
        $affected    = $usageService->distinctJournalCount($user, $ids);
        $budgetCount = AbeiGroupBudget::where('user_id', $user->id)->count();

        if (!$this->option('force')) {
            $this->friendlyInfo(sprintf('用户 %s：现有 %d 个分类，%d 笔交易会失去分类归属，%d 条按组预算会一起清掉。', $user->email, count($ids), $affected, $budgetCount));
            $this->friendlyInfo(sprintf('默认词表会种入 %d 个分类。加 --force 才真的执行。', $this->countDefaults($defaultSet)));

            return 0;
        }

        $seeded      = 0;
        DB::transaction(function () use ($user, $categories, $defaultSet, &$seeded): void {
            // 预算行的 FK 是 cascade，但分类走的是软删除，级联不会触发，得自己清
            AbeiGroupBudget::where('user_id', $user->id)->delete();

            $destroyer = app(CategoryDestroyService::class);

            /** @var Category $category */
            foreach ($categories as $category) {
                // 周期缓存里全是老分类的汇总，留着下次读到的就是幽灵数据
                $category->primaryPeriodStatistics()->delete();
                $destroyer->destroy($category);
            }

            $seeded    = $defaultSet->seed($user);
        });

        Log::channel('audit')->info(sprintf('abei:reset-categories deleted %d categories for user #%d, seeded %d.', count($categories), $user->id, $seeded));
        $this->friendlyPositive(sprintf('删掉 %d 个分类，%d 笔交易现在是未分类；种入 %d 个默认分类。', count($categories), $affected, $seeded));

        return 0;
    }

    private function countDefaults(DefaultCategorySet $defaultSet): int
    {
        $count = 0;
        foreach ($defaultSet->definitions() as $group) {
            $count += 1 + count($group['children']);
        }

        return $count;
    }

    private function resolveUser(): ?User
    {
        $email = $this->option('email');
        $user  = null === $email ? User::orderBy('id')->first() : User::where('email', $email)->first();
        if (!$user instanceof User) {
            $this->friendlyError(sprintf('找不到用户%s。', null === $email ? '' : sprintf('（%s）', $email)));

            return null;
        }

        return $user;
    }
}
