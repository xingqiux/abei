<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 区分「AI 猜的」和「人确认的」。
 *
 * 在这之前，PATCH 一行会无差别把 user_modified_at 设成当前时间，于是两者在数据上
 * 完全一样：事后挑不出哪些是机器填的、猜错了没法批量回退、审阅界面也标不出
 * 「这条还没人看过」。等到攒了几千行 AI 改过的数据再补这个字段就回填不了了。
 */
return new class extends Migration {
    public function down(): void
    {
        Schema::table('bill_statement_rows', static function (Blueprint $table): void {
            $table->dropIndex(['bill_task_id', 'suggested_by']);
            $table->dropColumn(['suggested_by', 'suggested_at']);
        });
    }

    public function up(): void
    {
        Schema::table('bill_statement_rows', static function (Blueprint $table): void {
            // null = 人改的或没改过；'ai' = 机器建议，还没人确认
            $table->string('suggested_by')->nullable()->after('user_modified_at');
            $table->dateTime('suggested_at')->nullable()->after('suggested_by');

            // 审阅时要按任务筛「待确认的建议」，这是唯一的查询形态
            $table->index(['bill_task_id', 'suggested_by']);
        });
    }
};
