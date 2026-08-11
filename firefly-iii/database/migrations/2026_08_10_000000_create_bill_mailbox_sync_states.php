<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function down(): void
    {
        Schema::dropIfExists('bill_mailbox_sync_states');
    }

    public function up(): void
    {
        Schema::create('bill_mailbox_sync_states', static function (Blueprint $table): void {
            $table->id();
            $table->timestamps();
            $table->bigInteger('user_id', false, true)->unique();
            $table->string('status')->default('idle')->index();
            $table->unsignedSmallInteger('limit')->default(25);
            $table->dateTime('requested_at')->nullable();
            $table->dateTime('started_at')->nullable();
            $table->dateTime('finished_at')->nullable();
            $table->json('result')->nullable();
            $table->text('error_message')->nullable();

            $table->foreign('user_id')->references('id')->on('users')->onDelete('cascade');
        });
    }
};
