<?php
declare(strict_types=1);

namespace FireflyIII\Console\Commands;

use FireflyIII\Console\Commands\ShowsFriendlyMessages;
use FireflyIII\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Laravel\Passport\ClientRepository;

/**
 * Creates a personal access token for the abei-web frontend.
 * Fallback when no PAT exists and the API token endpoint is unreachable.
 */
class CreatePersonalAccessToken extends Command
{
    use ShowsFriendlyMessages;

    protected $description = 'Creates a personal access token (PAT) for the abei-web frontend.';

    protected $signature = 'user:create-pat {--email= : user email; defaults to the first user}';

    public function handle(ClientRepository $clientRepository): int
    {
        $user = null === $this->option('email') ? User::orderBy('id')->first() : User::where('email', $this->option('email'))->first();
        if (null === $user) {
            $this->friendlyError(sprintf('No user found%s.', null === $this->option('email') ? '' : sprintf(' for email %s', $this->option('email'))));

            return 1;
        }

        $clientCount = DB::table('oauth_clients')->where('grant_types', '["personal_access"]')->whereNull('owner_id')->count();
        if (0 === $clientCount) {
            $clientRepository->createPersonalAccessGrantClient('Abei Personal Access Client', null);
        }

        $user->tokens()->where('name', 'abei-web')->update(['revoked' => true]);
        $token = $user->createToken('abei-web')->accessToken;
        $this->friendlyPositive(sprintf('Created PAT for %s (%s):', $user->email, $user->id));
        $this->line(sprintf('      %s', $token));

        return 0;
    }
}
