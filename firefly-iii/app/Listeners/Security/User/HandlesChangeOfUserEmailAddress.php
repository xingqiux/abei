<?php

declare(strict_types=1);

/*
 * HandlesChangeOfUserEmailAddress.php
 * Copyright (c) 2026 james@firefly-iii.org
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

namespace FireflyIII\Listeners\Security\User;

use Exception;
use FireflyIII\Events\Security\User\UserChangedEmailAddress;
use FireflyIII\Exceptions\FireflyException;
use FireflyIII\Mail\ConfirmEmailChangeMail;
use FireflyIII\Mail\UndoEmailChangeMail;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

class HandlesChangeOfUserEmailAddress implements ShouldQueue
{
    public function handle(UserChangedEmailAddress $event): void
    {
        $this->sendEmailChangeConfirmMail($event);
        $this->sendEmailChangeUndoMail($event);
    }

    /**
     * Send email to confirm email change. Will not be made into a notification, because
     * this requires some custom fields from the user and not just the "user" object.
     *
     * @throws FireflyException
     */
    private function sendEmailChangeConfirmMail(UserChangedEmailAddress $event): void
    {
        $newEmail = $event->newEmail;
        $oldEmail = $event->oldEmail;
        // 确认/撤销的 Web 页面已随前端移除，邮件里只能给站点地址。
        // 令牌仍由 UserRepository 写入偏好，等 API 侧补上确认端点后再在这里拼链接。
        $url      = url('/');

        try {
            Mail::to($newEmail)->send(new ConfirmEmailChangeMail($newEmail, $oldEmail, $url));
        } catch (Exception $e) {
            Log::error($e->getMessage());
            Log::error($e->getTraceAsString());

            throw new FireflyException($e->getMessage(), 0, $e);
        }
    }

    /**
     * Send email to be able to undo email change. Will not be made into a notification, because
     * this requires some custom fields from the user and not just the "user" object.
     *
     * @throws FireflyException
     */
    private function sendEmailChangeUndoMail(UserChangedEmailAddress $event): void
    {
        $newEmail = $event->newEmail;
        $oldEmail = $event->oldEmail;
        $url      = url('/');

        try {
            Mail::to($oldEmail)->send(new UndoEmailChangeMail($newEmail, $oldEmail, $url));
        } catch (Exception $e) {
            Log::error($e->getMessage());
            Log::error($e->getTraceAsString());

            throw new FireflyException($e->getMessage(), 0, $e);
        }
    }
}
