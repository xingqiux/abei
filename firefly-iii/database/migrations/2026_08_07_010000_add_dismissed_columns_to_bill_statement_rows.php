<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 「划掉」这个终态。
 *
 * 在这之前一条流水只有 pending / needs_split / split / imported / failed，
 * 于是「我看过了，这条不用入账」没地方记：0 元流水、机器判出来的重复、归档任务
 * 名下的遗留行，全都以 pending 挂着，永远算在待办里，收件箱的数字只涨不跌。
 *
 * dismissed 是可恢复的终态，reason 记住是谁划的，事后才好分辨「机器自动划的」
 * 和「人说不要的」——前者判错了可以整批回滚，后者不能动。
 */
return new class extends Migration {
    public function down(): void
    {
        Schema::table('bill_statement_rows', static function (Blueprint $table): void {
            $table->dropIndex(['user_id', 'status']);
            $table->dropColumn(['dismissed_reason', 'dismissed_at']);
        });
    }

    public function up(): void
    {
        Schema::table('bill_statement_rows', static function (Blueprint $table): void {
            // duplicate_auto（机器判重批量划掉）/ zero_amount（0 元自动）
            // / task_archived（归档级联）/ user（人工）
            $table->string('dismissed_reason')->nullable()->after('status');
            $table->dateTime('dismissed_at')->nullable()->after('dismissed_reason');

            // 跨任务的收件箱队列按 user + status 取行，原有索引是 bill_task_id + status，帮不上。
            $table->index(['user_id', 'status']);
        });
    }
};
