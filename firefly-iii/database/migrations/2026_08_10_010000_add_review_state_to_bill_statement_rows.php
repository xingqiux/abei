<?php

declare(strict_types=1);

use FireflyIII\Services\BillIngestion\BillStatementRowReclassificationService;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function down(): void
    {
        Schema::table('bill_statement_rows', static function (Blueprint $table): void {
            $table->dropIndex(['user_id', 'review_state']);
            $table->dropIndex(['user_id', 'review_state', 'bill_task_id']);
            $table->dropIndex(['event_group_id']);
            $table->dropColumn(['review_state', 'confirm_reason', 'excluded_reason', 'event_group_id', 'hint_flags']);
        });
    }

    public function up(): void
    {
        Schema::table('bill_statement_rows', static function (Blueprint $table): void {
            $table->string('review_state')->default('pending_book')->after('status');
            $table->string('confirm_reason')->nullable()->after('review_state');
            $table->string('excluded_reason')->nullable()->after('confirm_reason');
            $table->uuid('event_group_id')->nullable()->after('excluded_reason');
            $table->json('hint_flags')->nullable()->after('event_group_id');

            $table->index(['user_id', 'review_state']);
            $table->index(['user_id', 'review_state', 'bill_task_id']);
            $table->index('event_group_id');
        });

        app(BillStatementRowReclassificationService::class)->run();
    }
};
