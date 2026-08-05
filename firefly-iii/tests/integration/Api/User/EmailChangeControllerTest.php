<?php

declare(strict_types=1);

namespace Tests\integration\Api\User;

use FireflyIII\Repositories\User\UserRepositoryInterface;
use FireflyIII\Support\Facades\Preferences;
use FireflyIII\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\integration\TestCase;

/**
 * Class EmailChangeControllerTest
 *
 * 这两条路由是从邮件里点进来的：没有登录态，URL 里的令牌就是凭证，返回页面不是 JSON。
 *
 * @internal
 *
 * @coversNothing
 */
final class EmailChangeControllerTest extends TestCase
{
    use RefreshDatabase;

    public function testConfirmUnblocksTheUser(): void
    {
        $user     = $this->createAuthenticatedUser();
        $this->blockForEmailChange($user);
        Preferences::setForUser($user, 'email_change_confirm_token', 'confirm-token-value');

        $response = $this->get(route('api.v1.user.email-change.confirm', ['confirm-token-value']));

        $response->assertStatus(200);
        $user->refresh();
        $this->assertFalse((bool) $user->blocked);
        $this->assertSame('', $user->blocked_code);
    }

    public function testConfirmRejectsAnUnknownToken(): void
    {
        $user     = $this->createAuthenticatedUser();
        $this->blockForEmailChange($user);
        Preferences::setForUser($user, 'email_change_confirm_token', 'confirm-token-value');

        $response = $this->get(route('api.v1.user.email-change.confirm', ['not-the-right-token']));

        $response->assertStatus(400);
        $user->refresh();
        $this->assertTrue((bool) $user->blocked);
    }

    public function testUndoRestoresThePreviousEmailAddress(): void
    {
        $user       = $this->createAuthenticatedUser();
        $oldEmail   = $user->email;

        /** @var UserRepositoryInterface $repository */
        $repository = app(UserRepositoryInterface::class);
        $repository->changeEmail($user, 'changed@email.com');

        $token      = (string) Preferences::getForUser($user, 'email_change_undo_token', 'invalid')->data;
        $hash       = hash('sha256', sprintf('%s%s', (string) config('app.key'), $oldEmail));

        $response   = $this->get(route('api.v1.user.email-change.undo', [$token, $hash]));

        $response->assertStatus(200);
        $user->refresh();
        $this->assertSame($oldEmail, $user->email);
        $this->assertFalse((bool) $user->blocked);
    }

    public function testUndoRejectsAHashThatMatchesNoPreviousAddress(): void
    {
        $user       = $this->createAuthenticatedUser();

        /** @var UserRepositoryInterface $repository */
        $repository = app(UserRepositoryInterface::class);
        $repository->changeEmail($user, 'changed@email.com');

        $token      = (string) Preferences::getForUser($user, 'email_change_undo_token', 'invalid')->data;
        $hash       = hash('sha256', 'this-matches-nothing');

        $response   = $this->get(route('api.v1.user.email-change.undo', [$token, $hash]));

        $response->assertStatus(400);
        $user->refresh();
        $this->assertSame('changed@email.com', $user->email);
    }

    private function blockForEmailChange(User $user): void
    {
        $user->blocked      = true;
        $user->blocked_code = 'email_changed';
        $user->save();
    }
}
