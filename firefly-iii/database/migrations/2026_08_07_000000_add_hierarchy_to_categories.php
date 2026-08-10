<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 分类从平面列表变成两级树。
 *
 * parent_id 自引用。删父级时子级 set null 回到顶层，绝不连坐——分类没了交易还在，
 * 交易挂着的分类被 cascade 删掉才是灾难。
 *
 * system 标记程序自己造的分类（余额校准这类）。它们不是用户的记账词汇，管理界面、
 * 选择器、支出排行都不该看见，但又必须留在库里给对账逻辑用，所以用列而不是删掉。
 */
return new class extends Migration {
    public function down(): void
    {
        Schema::table('categories', static function (Blueprint $table): void {
            $table->dropForeign(['parent_id']);
            $table->dropIndex(['user_id', 'parent_id']);
            $table->dropColumn(['parent_id', 'system']);
        });
    }

    public function up(): void
    {
        Schema::table('categories', static function (Blueprint $table): void {
            $table->integer('parent_id', false, true)->nullable()->after('name');
            $table->boolean('system')->default(false)->after('parent_id');

            $table->foreign('parent_id')->references('id')->on('categories')->onDelete('set null');
            // 管理界面每次都是「拉这个用户的整棵树」，就这一种查询形态
            $table->index(['user_id', 'parent_id']);
        });
    }
};
