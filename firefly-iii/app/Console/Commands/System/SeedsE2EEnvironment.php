<?php

declare(strict_types=1);

namespace FireflyIII\Console\Commands\System;

use Carbon\Carbon;
use FireflyIII\Enums\AccountTypeEnum;
use FireflyIII\Models\Account;
use FireflyIII\Models\GroupMembership;
use FireflyIII\Models\Recurrence;
use FireflyIII\Models\Rule;
use FireflyIII\Models\RuleGroup;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Models\UserGroup;
use FireflyIII\Models\UserRole;
use FireflyIII\Repositories\Account\AccountRepositoryInterface;
use FireflyIII\Repositories\Currency\CurrencyRepositoryInterface;
use FireflyIII\Repositories\Recurring\RecurringRepositoryInterface;
use FireflyIII\Repositories\Rule\RuleRepositoryInterface;
use FireflyIII\Repositories\RuleGroup\RuleGroupRepositoryInterface;
use FireflyIII\Support\Facades\Preferences;
use FireflyIII\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Laravel\Passport\ClientRepository;
use RuntimeException;
use Symfony\Component\Console\Command\Command as CommandAlias;
use ZipArchive;

final class SeedsE2EEnvironment extends Command
{
    private const string BILL_PASSWORD          = 'e2e-bill-only';
    private const string MAIL_PASSWORD          = 'bills-e2e-only';
    private const string RECURRENCE_DESTINATION = 'Granary E2E Recurrence Merchant';
    private const string RECURRENCE_SOURCE      = 'Granary E2E Recurrence Source';
    private const string RECURRENCE_TITLE       = 'Granary E2E Daily Synthetic Subscription';
    private const string RULE_GROUP_TITLE       = 'Granary E2E Synthetic Rules';
    private const string RULE_TAG               = 'granary-e2e-reviewed';
    private const string RULE_TITLE             = 'Granary E2E Tag Synthetic Lunch';

    protected $description = 'Seeds the isolated Granary browser-test user, token and synthetic mailbox fixture.';

    protected $signature = 'system:seed-e2e
                            {--email=e2e@example.test}
                            {--token-path=/run/e2e/token}
                            {--secondary-email=e2e-secondary@example.test}
                            {--secondary-token-path=/run/e2e/token-secondary}
                            {--send-mail}';

    public function handle(): int
    {
        if (!app()->environment('testing')) {
            $this->error('This command only runs when APP_ENV=testing.');

            return CommandAlias::FAILURE;
        }

        $email              = trim((string) $this->option('email'));
        $tokenPath          = trim((string) $this->option('token-path'));
        $secondaryEmail     = trim((string) $this->option('secondary-email'));
        $secondaryTokenPath = trim((string) $this->option('secondary-token-path'));
        if ('' === $email || '' === $secondaryEmail) {
            $this->error('The E2E emails must not be empty.');

            return CommandAlias::INVALID;
        }
        if (0 === strcasecmp($email, $secondaryEmail)) {
            $this->error('The primary and secondary E2E emails must be different.');

            return CommandAlias::INVALID;
        }
        if ('' === $tokenPath || '' === $secondaryTokenPath) {
            $this->error('The E2E token paths must not be empty.');

            return CommandAlias::INVALID;
        }
        if ($tokenPath === $secondaryTokenPath) {
            $this->error('The primary and secondary E2E token paths must be different.');

            return CommandAlias::INVALID;
        }

        $user = User::query()->where('email', $email)->first();
        if (!$user instanceof User) {
            $user = $this->createUser($email);
        }
        $secondaryUser = User::query()->where('email', $secondaryEmail)->first();
        if (!$secondaryUser instanceof User) {
            $secondaryUser = $this->createUser($secondaryEmail);
        }

        $currency = $this->configurePrimaryCurrency($user);
        $this->configurePrimaryCurrency($secondaryUser);

        $this->writePersonalAccessToken($user, $tokenPath);
        $this->writePersonalAccessToken($secondaryUser, $secondaryTokenPath);
        $this->configureMailbox($user);
        DB::transaction(fn() => $this->seedAutomations($user, $currency));
        if ((bool) $this->option('send-mail')) {
            $this->sendSyntheticBill('bills@localhost');
        }

        $this->info('E2E users, tokens and primary mailbox fixture are ready.');

        return CommandAlias::SUCCESS;
    }

    private function configureMailbox(User $user): void
    {
        Preferences::setForUser($user, 'bill_inbox_mailbox_enabled', true);
        Preferences::setForUser($user, 'bill_inbox_mailbox_provider', 'imap');
        Preferences::setForUser($user, 'bill_inbox_mailbox_email', 'bills@localhost');
        Preferences::setForUser($user, 'bill_inbox_mailbox_host', 'e2e-mail');
        Preferences::setForUser($user, 'bill_inbox_mailbox_port', 3143);
        Preferences::setForUser($user, 'bill_inbox_mailbox_encryption', 'none');
        Preferences::setForUser($user, 'bill_inbox_mailbox_username', 'bills');
        Preferences::setForUser($user, 'bill_inbox_mailbox_password', encrypt(self::MAIL_PASSWORD));
        Preferences::setForUser($user, 'bill_inbox_mailbox_folder', 'INBOX');
    }

    private function configurePrimaryCurrency(User $user): TransactionCurrency
    {
        /** @var CurrencyRepositoryInterface $repository */
        $repository = app(CurrencyRepositoryInterface::class);
        $repository->setUser($user);
        $currency = $repository->findByCode('CNY');
        if (!$currency instanceof TransactionCurrency) {
            throw new RuntimeException('The synthetic E2E currency CNY is unavailable.');
        }
        $repository->makePrimary($currency);

        return $currency;
    }

    private function createUser(string $email): User
    {
        $group = UserGroup::query()->create(['title' => $email]);
        $role  = UserRole::query()->where('title', 'owner')->firstOrFail();
        $user  = User::query()->create([
            'email'         => $email,
            'password'      => Hash::make('e2e-password-only'),
            'user_group_id' => $group->id,
            'blocked'       => false
        ]);

        GroupMembership::query()->create([
            'user_id'       => $user->id,
            'user_group_id' => $group->id,
            'user_role_id'  => $role->id
        ]);

        return $user;
    }

    private function findOrCreateRecurrenceAccount(
        AccountRepositoryInterface $repository,
        User $user,
        TransactionCurrency $currency,
        string $name,
        AccountTypeEnum $type
    ): Account
    {
        $account = $repository->findByName($name, [$type->value]);
        if ($account instanceof Account) {
            return $account;
        }

        return $repository->store([
            'name'                 => $name,
            'account_type_name'    => $type->value,
            'account_type_id'      => null,
            'iban'                 => null,
            'virtual_balance'      => '0',
            'active'               => true,
            'account_role'         => AccountTypeEnum::ASSET === $type ? 'defaultAsset' : null,
            'opening_balance'      => null,
            'opening_balance_date' => null,
            'currency_id'          => $currency->id
        ]);
    }

    private function seedAutomations(User $user, TransactionCurrency $currency): void
    {
        /** @var RuleGroupRepositoryInterface $groupRepository */
        $groupRepository = app(RuleGroupRepositoryInterface::class);
        $groupRepository->setUser($user);
        $group = $groupRepository->findByTitle(self::RULE_GROUP_TITLE);
        if (!$group instanceof RuleGroup) {
            $group = $groupRepository->store([
                'title'       => self::RULE_GROUP_TITLE,
                'description' => 'Synthetic manual rules used only by Granary browser tests.',
                'active'      => true
            ]);
        }

        /** @var RuleRepositoryInterface $ruleRepository */
        $ruleRepository = app(RuleRepositoryInterface::class);
        $ruleRepository->setUser($user);
        $rule = $user->rules()->where('title', self::RULE_TITLE)->first();
        if (!$rule instanceof Rule) {
            $ruleRepository->store([
                'rule_group_id'   => $group->id,
                'title'           => self::RULE_TITLE,
                'description'     => 'Tags the synthetic Alipay lunch transaction.',
                'trigger'         => 'manual-activation',
                'active'          => true,
                'strict'          => true,
                'stop_processing' => false,
                'triggers'        => [['type' => 'description_contains', 'value' => '合成午餐']],
                'actions'         => [['type' => 'add_tag', 'value' => self::RULE_TAG]]
            ]);
        }

        $recurrence = $user->recurrences()->where('title', self::RECURRENCE_TITLE)->first();
        if ($recurrence instanceof Recurrence) {
            return;
        }

        /** @var AccountRepositoryInterface $accountRepository */
        $accountRepository = app(AccountRepositoryInterface::class);
        $accountRepository->setUser($user);
        $source      = $this->findOrCreateRecurrenceAccount($accountRepository, $user, $currency, self::RECURRENCE_SOURCE, AccountTypeEnum::ASSET);
        $destination = $this->findOrCreateRecurrenceAccount($accountRepository, $user, $currency, self::RECURRENCE_DESTINATION, AccountTypeEnum::EXPENSE);

        /** @var RecurringRepositoryInterface $recurringRepository */
        $recurringRepository = app(RecurringRepositoryInterface::class);
        $recurringRepository->setUser($user);
        $recurringRepository->store([
            'recurrence'   => [
                'type'              => 'withdrawal',
                'title'             => self::RECURRENCE_TITLE,
                'description'       => 'Synthetic daily subscription used only by Granary browser tests.',
                'first_date'        => Carbon::today(config('app.timezone')),
                'nr_of_repetitions' => 0,
                'apply_rules'       => false,
                'active'            => true
            ],
            'repetitions'  => [['type' => 'daily', 'moment' => '', 'skip' => 0, 'weekend' => 1]],
            'transactions' => [[
                'description'    => 'Granary E2E Synthetic Subscription Charge',
                'amount'         => '12.34',
                'currency_id'    => $currency->id,
                'source_id'      => $source->id,
                'destination_id' => $destination->id
            ]]
        ]);
    }

    private function sendSyntheticBill(string $recipient): void
    {
        $csv = implode("\n", [
            '导出时间：[2026-07-20 12:30:00]',
            '起始时间：[2026-07-01 00:00:00]    终止时间：[2026-07-31 23:59:59]',
            '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
            '2026-07-20 12:00:00,餐饮美食,合成测试商户,test@example.test,合成午餐,支出,18.80,E2E Checking,交易成功,E2E-ORDER-0001,E2E-MERCHANT-0001,自动化夹具',
            '2026-07-20 12:10:00,餐饮美食,合成拆分商户,split@example.test,合成拆分午餐,支出,23.80,招商银行储蓄卡(8705)&花呗,交易成功,E2E-ORDER-0002,E2E-MERCHANT-0002,组合支付夹具'
        ]);
        $temp = tempnam(sys_get_temp_dir(), 'granary-e2e-');
        if (false === $temp) {
            throw new RuntimeException('Could not create a temporary ZIP path.');
        }

        $filename = '支付宝交易明细(20260701-20260731).csv';
        $zip      = new ZipArchive();
        try {
            if (true !== $zip->open($temp, ZipArchive::CREATE | ZipArchive::OVERWRITE)) {
                throw new RuntimeException('Could not create the synthetic bill ZIP.');
            }
            $zip->addFromString($filename, $csv);
            if (!$zip->setEncryptionName($filename, ZipArchive::EM_AES_256, self::BILL_PASSWORD)) {
                throw new RuntimeException('Could not encrypt the synthetic bill ZIP.');
            }
            $zip->close();

            $archive = file_get_contents($temp);
            if (false === $archive) {
                throw new RuntimeException('Could not read the synthetic bill ZIP.');
            }
            Mail::raw('附件是完全合成的支付宝流水，仅用于 Granary E2E。', static function ($message) use ($archive, $recipient): void {
                $message
                    ->from('service@mail.alipay.com', '支付宝测试提醒')
                    ->to($recipient)
                    ->subject('Granary E2E 的支付宝交易流水明细')
                    ->attachData($archive, '支付宝交易明细(20260701-20260731).zip', ['mime' => 'application/zip']);
            });
        } finally {
            if (is_file($temp)) {
                unlink($temp);
            }
        }
    }

    private function writePersonalAccessToken(User $user, string $path): void
    {
        $clientCount = DB::table('oauth_clients')->where('grant_types', '["personal_access"]')->whereNull('owner_id')->count();
        if (0 === $clientCount) {
            app(ClientRepository::class)->createPersonalAccessGrantClient('Granary E2E Personal Access Client', null);
        }

        $user->tokens()->where('name', 'granary-e2e')->update(['revoked' => true]);
        $token     = $user->createToken('granary-e2e')->accessToken;
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0o700, true) && !is_dir($directory)) {
            throw new RuntimeException('Could not create the E2E token directory.');
        }
        if (false === file_put_contents($path, $token)) {
            throw new RuntimeException('Could not write the E2E token file.');
        }
        chmod($path, 0o600);
    }
}
