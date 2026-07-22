<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\TransactionCurrency;
use FireflyIII\Repositories\Account\AccountRepositoryInterface;
use FireflyIII\Support\Facades\Amount;
use FireflyIII\User;

final class BillStatementCurrencyResolver
{
    public function __construct(private readonly AccountRepositoryInterface $accountRepository) {}

    public function resolve(User $user, BillStatementRow $row): TransactionCurrency
    {
        $this->accountRepository->setUser($user);

        $accountName = 'deposit' === $row->firefly_type ? $row->destination_name : $row->source_name;
        if (is_string($accountName) && '' !== trim($accountName)) {
            $account = $this->accountRepository->findByName($accountName, config('firefly.valid_currency_account_types'));
            if (null !== $account) {
                $currency = $this->accountRepository->getAccountCurrency($account);
                if (null !== $currency) {
                    return $currency;
                }
            }
        }

        return Amount::getPrimaryCurrencyByUserGroup($user->userGroup);
    }
}
