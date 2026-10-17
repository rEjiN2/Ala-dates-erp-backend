# Ala Dates ERP: Backend

NestJS + TypeScript, MongoDB (Mongoose), pnpm. UAE dates-trading company,
multi-location stock. Replaces a legacy ERP (atACC).

## Working rules (read first)
- Be economical. Read only the files you need; do not scan the whole repo.
  Check "Where things live" before searching.
- Mirror the closest existing module instead of inventing structure.
  Prefer a small change to an existing service over a new abstraction.
- Keep command output small: run targeted tests (`pnpm test <path>`), and
  never paste long logs back into the conversation.
- Tests: always for money/stock posting, permissions and validation rules.
  Plain CRUD masters need only a few tests.
- Do not commit unless asked. Never put real secrets in any tracked file;
  `.env.example` holds placeholders only.
- If a business rule is listed under "Open questions", ask; do not assume.
- Finish every task with a summary of at most 10 lines: what changed, what
  was tested, decisions I need to make.

## Where things live (verify on first use, then correct this section)
src/modules/<domain>/ with: auth, users (UsersService + UserManagementService),
roles (permissions.ts = PERMISSIONS constant + seeded role sets), location,
product, party, cashier, company, dashboard, files, storage, sequence, audit,
comments (+ EntityAccessRegistry). Accounting lives in src/modules/accounting/:
ledger-accounts, cash-receipts, cash-payments, cash-handovers, vouchers (VoucherPostingService,
VoucherPrintService, data-scope.ts helper, voucher-view.ts balance redaction).
Reports: src/modules/reports (salesman collections).
Seeds: src/database/seed.ts + seed-roles.ts. Test harness: test/voucher-test-module.ts.
Shared: SequenceService, AuditService, StorageService, amount-in-words, sum2.

## Conventions
- Permissions: one PERMISSIONS constant, used by every @RequirePermission().
  A new permission means: add to the constant, add to the seed. The seed
  must be idempotent and upsert the admin role with ALL permissions. The JWT
  strategy reloads user + role every request, so permission, scope and status
  changes apply at once (only the frontend's cached /auth/me is stale).
- Data scope: role.dataScope own|all. "own" users see only vouchers they
  created or on their linked cashier (others 404) and post only for that
  cashier into User.allowedCashAccountIds (else 403). Balances need
  balances:view.
- Codes: SequenceService (atomic findOneAndUpdate $inc, accepts a Mongo
  session). Clients never send codes; codes are immutable. Prefixes:
  BR/WH/ST/VAN (locations), PG, CUS/SUP, CASH/BNK/WAL/INC/EXP/OTH,
  CSH (cashier), CR (receipt), CP (payment), CH (handover).
- Money: LedgerAccount.Balance = debits minus credits (customer owing us is
  positive). LedgerEntry is insert-only. Every voucher posts through
  VoucherPostingService inside ONE Mongo transaction: voucher number,
  entries, balances, audit. Totals are always computed server-side. Never
  hard-delete a voucher: Cancel with a reason posts reversing entries; Edit
  reverses and reposts; a no-change edit is rejected.
- Audit and comments: AuditService.record(entry, session) is written in the
  same transaction as the change. The actor comes from the JWT, never the
  request body. Audit and comments are insert-only. /activity merges both.
- Accounts: scope=company (cash, bank, wallet, income, expense, other) and
  scope=party (customer, supplier). Party ledger accounts are managed only
  by the Parties module. Receipt/Payment header account: cash, wallet or
  bank (active). Voucher line accounts: never cash, wallet or bank.
- Locations: one self-referencing collection. Parent rules live only in the
  ALLOWED_PARENT_TYPES map, exposed at GET /locations/rules. Ancestors and
  depth are maintained by the backend. Max depth 6, no cycles.
- Delete rule for masters: block if balance is not 0 or the record is used;
  offer deactivate instead.
- Storage: StorageService interface with a MEGA adapter (megajs). Files are
  private and streamed through the backend; never expose a share link or
  import the SDK outside the adapter.
- Auth: JWT in httpOnly cookies; GET /auth/me returns user and permissions.
- Errors: global exception filter, one response shape; class-validator DTOs
  with a global ValidationPipe; config validated at startup.
- Lookups: GET /<module>/lookup returns light { id, code, name, ... } for
  dropdowns. Time zone for display is Asia/Dubai; store UTC.

## Business context
Dates in many package sizes. Bundling (components into a gift pack and back)
is a core feature and needs its own stock-movement logic. Location tree:
Branch > Warehouse / Store / Van (vans can nest). Branch is organisational;
warehouse, store and van hold their own stock.

## Open questions (ask, do not assume)
Q15 extra tax types; Q17 stock on purchase invoice vs goods received;
Q25 allocation mandatory vs on-account; Q27 when a cheque affects the bank
balance; Q32 stock adjustment approval; Q33 transfer in-transit; Q35 to Q39
bundling rules; Q44 history migration. VAT is stored per line only for now.

## Not built, do not build unless asked
Journal Entry, Credit/Debit Note, Advance Allocation, Bank Reconciliation,
Contra Voucher.