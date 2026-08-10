<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * v0.2 的分类系统：域 + 图标 + 色号 + 禁用，外加按组预算表。
 *
 * color 存的是 12 色板的编号（"1"~"12"）不是 hex——主题一换 hex 就全错，色号跟着 token 走。
 * disabled_at 用时间戳不用布尔：禁用只是从选择器和 AI 白名单里消失，历史交易照旧挂着，
 * 统计要能说清「从哪天起不再出现」。
 *
 * abaku_group_budgets 单独一张表，不碰 Firefly 的 budgets/budget_limits：那套要求逐笔交易挂
 * budget_id，而按组预算的「已花」是从分类树直接汇总的，两种口径混一张表只会互相污染。
 */
return new class extends Migration {
    public function down(): void
    {
        Schema::dropIfExists('abaku_group_budgets');

        Schema::table('categories', static function (Blueprint $table): void {
            $table->dropIndex(['user_id', 'domain']);
            $table->dropColumn(['domain', 'icon', 'color', 'disabled_at']);
        });
    }

    public function up(): void
    {
        Schema::table('categories', static function (Blueprint $table): void {
            $table->string('domain', 20)->default('expense')->after('system');
            $table->string('icon', 64)->nullable()->after('domain');
            $table->string('color', 8)->nullable()->after('icon');
            $table->timestamp('disabled_at')->nullable()->after('color');

            // 分类管理页和选择器都是「拉这个用户某个域的全部分类」
            $table->index(['user_id', 'domain']);
        });

        Schema::create('abaku_group_budgets', static function (Blueprint $table): void {
            $table->id();
            $table->timestamps();
            $table->bigInteger('user_id', false, true);
            $table->integer('category_id', false, true);
            $table->decimal('amount', 32, 12);
            $table->string('currency_code', 8);

            $table->foreign('user_id')->references('id')->on('users')->onDelete('cascade');
            // 组没了预算行没有任何意义，这里跟分类树的 set null 不一样，就该连坐
            $table->foreign('category_id')->references('id')->on('categories')->onDelete('cascade');
            $table->unique('category_id');
        });
    }
};
