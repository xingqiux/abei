# Granary Server

Rust backend for Granary. The server owns the new PostgreSQL schema and balanced journal ledger; Firefly III remains a legacy migration source during the transition.

```bash
make up-server
make test-server
```

The development API is available at `http://localhost:18003`. The root Compose stack owns the PostgreSQL and SMTP/IMAP dependencies; tests use an isolated Compose project and temporary PostgreSQL data.

Implemented server boundaries include local password authentication, Session/CSRF, PAT scopes, TOTP MFA, password reset, invitation and optional public registration, instance/organization/book administration, shared-book roles, and immutable balanced journals. The ledger API currently covers accounts, categories, counterparties, tags, monthly budgets, multi-currency amounts, cloning, atomic batch replacement/deletion with expiring previews, type conversion through reversal and replacement, recycle-bin recovery, fixed transaction links with partial refund/reimbursement amounts, cross-book transfer links, and account reconciliation with explicit adjustment journals.

Important financial invariants are enforced in PostgreSQL as well as the HTTP layer: posted amounts and dimensions are immutable, batches are all-or-nothing and version checked, archived dimensions remain available to historical reversals, finalized reconciliations are immutable, and cleared postings must belong to a reconciliation.

Primary API areas:

- `/api/v1/auth`, `/api/v1/admin`, `/api/v1/instance`
- `/api/v1/organizations`, `/api/v1/books`
- `/api/v1/books/{book_id}/accounts`, `categories`, `counterparties`, `tags`, `budgets`
- `/api/v1/books/{book_id}/transactions` and `transactions/batches`
- `/api/v1/books/{book_id}/transaction-links`
- `/api/v1/books/{book_id}/reconciliations`

Health endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /api/v1/instance`
