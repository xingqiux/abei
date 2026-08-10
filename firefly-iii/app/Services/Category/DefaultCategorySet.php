<?php

declare(strict_types=1);

namespace FireflyIII\Services\Category;

use FireflyIII\Models\Category;
use FireflyIII\User;

/**
 * 出厂词表。
 *
 * 词表是产品能力，不是让用户逐单发明的——所以这份表是代码里的常量，不是数据迁移里的一次性 INSERT：
 * 重置命令、新用户建号、以后的「恢复默认」都得读同一份。
 *
 * 图标名是 Phosphor 组件名，color 是 12 色板号。支出域的子分类不单独配色，跟组走，
 * 这样预算页和排行榜里一个组永远是一个颜色。
 *
 * 「未分类」不在表里，也不许建：交易没挂分类就是未分类（Firefly 原生状态），界面上当虚拟项画。
 * 建成实体分类的话会同时存在「挂了未分类」和「没挂分类」两种状态，统计口径立刻分裂。
 */
final class DefaultCategorySet
{
    public const string DOMAIN_EXPENSE  = 'expense';

    public const string DOMAIN_INCOME   = 'income';

    public const string DOMAIN_TRANSFER = 'transfer';

    /** @var array<int, string> */
    public const array COLORS           = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

    /** @var array<int, string> */
    public const array DOMAINS          = [self::DOMAIN_INCOME, self::DOMAIN_EXPENSE, self::DOMAIN_TRANSFER];

    /**
     * @return array<int, array{domain: string, name: string, icon: string, color: string, children: array<int, array{name: string, icon: string}>}>
     */
    public function definitions(): array
    {
        return [
            // 收入域：钱从哪来。无子级，本身就是叶子。
            ['domain' => self::DOMAIN_INCOME, 'name' => '工资薪酬', 'icon' => 'Briefcase', 'color' => '4', 'children' => []],
            ['domain' => self::DOMAIN_INCOME, 'name' => '红包礼金', 'icon' => 'HandCoins', 'color' => '1', 'children' => []],
            ['domain' => self::DOMAIN_INCOME, 'name' => '利息理财', 'icon' => 'TrendUp', 'color' => '5', 'children' => []],
            ['domain' => self::DOMAIN_INCOME, 'name' => '副业项目', 'icon' => 'Wrench', 'color' => '6', 'children' => []],
            ['domain' => self::DOMAIN_INCOME, 'name' => '其他收入', 'icon' => 'Coins', 'color' => '12', 'children' => []],

            // 支出域：组 → 子分类，记账挂在叶子上。
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '餐饮', 'icon' => 'ForkKnife', 'color' => '2', 'children' => [
                ['name' => '正餐', 'icon' => 'BowlFood'],
                ['name' => '外卖', 'icon' => 'Moped'],
                ['name' => '咖啡饮品', 'icon' => 'Coffee'],
                ['name' => '零食小吃', 'icon' => 'Cookie'],
                ['name' => '聚餐请客', 'icon' => 'Champagne'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '出行', 'icon' => 'Bus', 'color' => '6', 'children' => [
                ['name' => '公共交通', 'icon' => 'Tram'],
                ['name' => '打车', 'icon' => 'Taxi'],
                ['name' => '共享单车', 'icon' => 'Bicycle'],
                ['name' => '火车机票', 'icon' => 'AirplaneTilt'],
                ['name' => '电动车充电', 'icon' => 'ChargingStation'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '居住', 'icon' => 'House', 'color' => '11', 'children' => [
                ['name' => '房租', 'icon' => 'Key'],
                ['name' => '水电燃气', 'icon' => 'Lightning'],
                ['name' => '物业维修', 'icon' => 'Hammer'],
                ['name' => '家居家装', 'icon' => 'Armchair'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '账单订阅', 'icon' => 'Receipt', 'color' => '8', 'children' => [
                ['name' => '话费宽带', 'icon' => 'WifiHigh'],
                ['name' => '软件订阅', 'icon' => 'AppWindow'],
                ['name' => '会员服务', 'icon' => 'Crown'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '购物', 'icon' => 'ShoppingCart', 'color' => '10', 'children' => [
                ['name' => '超市日用', 'icon' => 'Basket'],
                ['name' => '服饰美妆', 'icon' => 'TShirt'],
                ['name' => '数码电子', 'icon' => 'Laptop'],
                ['name' => '其他购物', 'icon' => 'ShoppingBag'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '健康', 'icon' => 'FirstAid', 'color' => '4', 'children' => [
                ['name' => '门诊药品', 'icon' => 'Pill'],
                ['name' => '运动健身', 'icon' => 'Barbell'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '文娱', 'icon' => 'GameController', 'color' => '9', 'children' => [
                ['name' => '娱乐休闲', 'icon' => 'FilmSlate'],
                ['name' => '旅行', 'icon' => 'Airplane'],
                ['name' => '书影音', 'icon' => 'MusicNotes'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '学习', 'icon' => 'GraduationCap', 'color' => '7', 'children' => [
                ['name' => '课程培训', 'icon' => 'Chalkboard'],
                ['name' => '书籍资料', 'icon' => 'BookOpen'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '人情', 'icon' => 'Gift', 'color' => '1', 'children' => [
                ['name' => '礼物', 'icon' => 'Gift'],
                ['name' => '捐赠', 'icon' => 'HandHeart'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '金融费用', 'icon' => 'Bank', 'color' => '12', 'children' => [
                ['name' => '手续费', 'icon' => 'Percent'],
                ['name' => '利息税费', 'icon' => 'Scales'],
                ['name' => '保险', 'icon' => 'ShieldCheck'],
            ]],
            ['domain' => self::DOMAIN_EXPENSE, 'name' => '其他', 'icon' => 'DotsThreeCircle', 'color' => '12', 'children' => [
                ['name' => '杂项', 'icon' => 'DotsThree'],
            ]],

            // 资金往来域：自己账户之间搬钱、对账。不进收支统计，所以必须住在自己的域里，
            // 混进支出域就是 v0.1 那个「转账被算成消费」的老毛病。
            ['domain' => self::DOMAIN_TRANSFER, 'name' => '账户互转', 'icon' => 'ArrowsLeftRight', 'color' => '12', 'children' => []],
            ['domain' => self::DOMAIN_TRANSFER, 'name' => '信用卡还款', 'icon' => 'CreditCard', 'color' => '12', 'children' => []],
            ['domain' => self::DOMAIN_TRANSFER, 'name' => '提现充值', 'icon' => 'ArrowLineDown', 'color' => '12', 'children' => []],
            ['domain' => self::DOMAIN_TRANSFER, 'name' => '余额校准', 'icon' => 'Scales', 'color' => '12', 'children' => []],
            ['domain' => self::DOMAIN_TRANSFER, 'name' => '投资买卖', 'icon' => 'ChartLineUp', 'color' => '5', 'children' => []],
        ];
    }

    /**
     * 把默认词表种进这个用户。
     *
     * 按「同级同名就跳过」判重，所以重复跑是安全的：种一半崩了再跑一遍不会种出两套。
     *
     * @return int 实际新建的分类数
     */
    public function seed(User $user): int
    {
        $created = 0;

        foreach ($this->definitions() as $group) {
            $parent = $this->firstOrCreate($user, $group['domain'], $group['name'], $group['icon'], $group['color'], null, $created);
            foreach ($group['children'] as $child) {
                // 子分类不单独配色，跟组走
                $this->firstOrCreate($user, $group['domain'], $child['name'], $child['icon'], $group['color'], $parent, $created);
            }
        }

        return $created;
    }

    private function firstOrCreate(User $user, string $domain, string $name, string $icon, string $color, ?Category $parent, int &$created): Category
    {
        $query    = $user->categories()->where('name', $name);
        if ($parent instanceof Category) {
            $query->where('parent_id', $parent->id);
        }
        if (!$parent instanceof Category) {
            $query->whereNull('parent_id');
        }

        /** @var null|Category $existing */
        $existing = $query->first();
        if ($existing instanceof Category) {
            return $existing;
        }

        $category = Category::create([
            'user_id'       => $user->id,
            'user_group_id' => $user->user_group_id,
            'name'          => $name,
            'parent_id'     => $parent?->id,
            'system'        => true,
            'domain'        => $domain,
            'icon'          => $icon,
            'color'         => $color,
        ]);
        ++$created;

        return $category;
    }
}
