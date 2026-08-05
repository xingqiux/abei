<?php
declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\User;

use FireflyIII\Models\Preference;
use FireflyIII\Repositories\User\UserRepositoryInterface;
use FireflyIII\Support\Facades\Preferences;
use FireflyIII\User;
use Illuminate\Contracts\View\View;
use Illuminate\Http\Response;
use Illuminate\Routing\Controller as BaseController;
use SensitiveParameter;

/**
 * 邮箱变更的确认与撤销。
 *
 * 用户是从邮件里点链接进来的，没有登录态，令牌本身就是凭证，所以这两条路由不挂 auth:api。
 * 也不继承 Api\V1\Controllers\Controller：那个基类只接受 application/json，而浏览器发的是 text/html。
 * 同理返回的是页面而不是 JSON。
 */
final class EmailChangeController extends BaseController
{
    public function confirm(UserRepositoryInterface $repository, #[SensitiveParameter] string $token): Response
    {
        if (!$this->internalAuth()) {
            return $this->page('firefly.email_change_invalid_link', 400);
        }
        $user = $this->findUserByToken('email_change_confirm_token', $token);
        if (!$user instanceof User) {
            return $this->page('firefly.email_change_invalid_link', 400);
        }

        $repository->unblockUser($user);
        Preferences::deleteForUser($user, 'remote_guard_alt_email');

        return $this->page('firefly.login_with_new_email');
    }

    public function undo(
        UserRepositoryInterface $repository,
        #[SensitiveParameter] string $token,
        string $hash
    ): Response {
        if (!$this->internalAuth()) {
            return $this->page('firefly.email_change_invalid_link', 400);
        }
        $user     = $this->findUserByToken('email_change_undo_token', $token);
        if (!$user instanceof User) {
            return $this->page('firefly.email_change_invalid_link', 400);
        }

        // 令牌只说明是这个用户，还要靠 hash 认出该退回到哪个旧地址。
        $previous = $this->findPreviousEmail($user, $hash);
        if (null === $previous) {
            return $this->page('firefly.email_change_invalid_link', 400);
        }

        $repository->changeEmail($user, $previous);
        $repository->unblockUser($user);

        return $this->page('firefly.login_with_old_email');
    }

    private function internalAuth(): bool
    {
        return 'web' === config('firefly.authentication_guard');
    }

    private function findUserByToken(string $preferenceName, #[SensitiveParameter] string $token): ?User
    {
        /** @var Preference $preference */
        foreach (Preferences::findByName($preferenceName) as $preference) {
            if (is_string($preference->data) && hash_equals($preference->data, $token)) {
                return $preference->user;
            }
        }

        return null;
    }

    private function findPreviousEmail(User $user, string $hash): ?string
    {
        /** @var Preference $entry */
        foreach (Preferences::beginsWith($user, 'previous_email_') as $entry) {
            $hashed = hash('sha256', sprintf('%s%s', (string) config('app.key'), (string) $entry->data));
            if (hash_equals($hashed, $hash)) {
                return (string) $entry->data;
            }
        }

        return null;
    }

    private function page(string $messageKey, int $status = 200): Response
    {
        $title = 200 === $status
            ? (string) trans('firefly.email_change_done')
            : (string) trans('firefly.email_change_failed');

        /** @var View $view */
        $view  = view('user.email-change-result', ['title' => $title, 'message' => (string) trans($messageKey)]);

        return response($view->render(), $status);
    }
}
