# Ala Dates ERP: Backend

NestJS + TypeScript, MongoDB (Mongoose), pnpm. UAE dates-trading company,
multi-location stock. Replaces legacy ERP (atACC).

## Token rules (always)
- Minimal diff. Smallest change that meets "Done when". No refactors, no
  extra docs/README/summary files, no unrelated cleanup.
- Read only files you need; check "Where things live" first. Do not re-read
  files already read in this session.
- Run only tests for touched files (`pnpm test <path>`). No full suite, no
  full lint, unless asked. Never paste long logs.
- Mirror the closest existing module. Do not invent new structure.
- Stop when "Done when" is met. Reply in 5 lines max: changed, tested,
  decisions needed.
- Blocked on a business rule: ask one question. Otherwise decide, state the
  assumption in one line, continue.
- No commits unless asked. Never put real secrets in tracked files
  (.env.example = placeholders only).
- Tests: money/stock posting, permissions, validation rules. Plain CRUD
  masters: a few only.

## Where things live (verify on first use, then correct this section)
src/modules/<domain>/: auth, users, roles, location, product-group,
accounts (LedgerAccount), party, company, cash-receipt, cash-payment,
cash-handover, reports, dashboard, files, sequence, audit, comments.
Voucher modules live under src/modules/accounting/.
Shared: PERMISSIONS constant, VoucherPostingService, SequenceService,
AuditService, DataScope helper, StorageService, amount-in-words, sum2.

## Status (update after each step)
Built: auth, locations, product groups, accounts, customers/suppliers,
company profile, cash receipt, cash payment, dashboard cash card, MEGA
storage, Users/Roles + scoping (Cashier module removed; collectors are users).
In progress: Cash Handover (balance-based) + salesman report.
Planned: products, opening balances, stock engine, purchase invoice, stock
transfer, sales invoice, allocation, bundling, returns, reports, migration.

## Conventions
- Permissions: one PERMISSIONS constant for every @RequirePermission().
  New permission = constant + seed. Seed is idempotent and upserts admin with
  ALL permissions. Users re-login to get new permissions. Vouchers use
  :read :create :edit :cancel (not :manage). Also balances:view,
  users:manage, roles:manage, vouchers:select-collector, reports:salesman,
  cash-handovers:read|create|approve|cancel.
- Roles: dataScope own|all. Scope own: list/get/pdf/activity/comments return
  only vouchers where createdBy = me OR collectedById = me, else 404.
  Header account must be in my allowedCashAccountIds, else 403. No balances:view = strip
  balances from lookups and old-balance. Use the DataScope helper for every
  voucher type.
- People on vouchers: "Created By" = login, automatic, from JWT only, never
  the body. "Collected By" (receipt) / "Paid By" (payment) = a User: collectedById + collectedByName snapshot. Default =
  me; another user needs vouchers:select-collector (else 403) and must be
  active with the type's :create permission. GET /users/lookup?for=
  receipt|payment. User.locationId filters the salesman report. Inactive users
  stay visible on old vouchers. Old `cashiers` collection kept, unused
  (pnpm migrate:collected-by moved vouchers).
- Codes: SequenceService (atomic $inc, takes a Mongo session). Clients never
  send codes; immutable. BR/WH/ST/VAN, PG, CUS/SUP, CASH/BNK/WAL/INC/EXP/OTH,
  CHQ, CR, CP, HO.
- Money: Balance = debits - credits (customer owing us is positive).
  LedgerEntry insert-only. Every voucher posts via VoucherPostingService in
  ONE Mongo transaction (number, entries, balances, audit). Totals computed
  server-side. No hard delete: Cancel with a reason posts reversals; Edit =
  reverse + repost; a no-change edit is rejected.
- Receipt: header account cash/wallet/bank (active); lines supplier, party,
  expense, other; never cash/wallet/bank. Payment: same header rule; lines
  supplier, customer, expense, other; overspending cash/wallet returns
  warnings, needs acknowledgeWarnings (bank exempt). Lists filter by
  paymentMethod (cash|bank) and date, status, account, staff, q.
- Accounts: type cheque (CHQ-) = cheques in hand, cash-like, not in the
  dashboard Cash & Bank total. Receipt header cash|wallet|cheque|bank;
  paymentMethod cash|cheque|bank; cheque needs paymentReference (+chequeDate).
- Handover (collection `handovers`; old `cash_handovers` kept, unused):
  balance-based. Pending = balances of the user's allowedCashAccountIds
  (cash/wallet/cheque); no flags on receipts. Submit per source <= balance
  minus his other submitted. Approve (not own-scope, not submitter/owner)
  posts received per line: debit receivedInto (default Company
  defaultCashInHand / defaultChequesInHand), credit source; short needs a
  reason. Cancel approved = reversal. Receipt edit/cancel may not take a
  cash-like account from >= 0 to below zero ("already handed over").
- Audit/comments: AuditService.record(entry, session) in the same
  transaction; insert-only; /activity merges both.
- Accounts: scope=company (cash, bank, wallet, income, expense, other) vs
  scope=party (customer, supplier). Party ledger accounts are managed only
  by the Parties module.
- Locations: one self-referencing collection; parent rules only in
  ALLOWED_PARENT_TYPES (GET /locations/rules); ancestors/depth maintained
  server-side; max depth 6; no cycles.
- Master delete: block if balance != 0 or used; offer deactivate.
- Storage: StorageService + MEGA adapter (megajs); files private, streamed
  through the backend; no share links; no SDK import outside the adapter.
- Auth: JWT in httpOnly cookies; /auth/me returns user, role, dataScope,
  permissions, linked staff (with staffType), allowed cash accounts.
- Errors: global filter, one shape; class-validator DTOs; startup config
  validation. Display time Asia/Dubai; store UTC.
- Lookups: GET /<module>/lookup returns light { id, code, name, ... }.

## Business context
Dates in many package sizes; bundling (components <-> gift pack) is core and
needs its own stock logic. Locations: Branch > Warehouse / Store / Van (vans
nest). Branch is organisational; warehouse, store, van hold stock. Van
salesmen collect cash/bank receipts all day and hand cash to the office at
night for approval.

## Open questions (ask, do not assume)
Q13 stock levels; Q14 pricing; Q15 extra tax types; Q17 stock on purchase
invoice vs goods received; Q25 allocation mandatory vs on-account; Q27
cheque clearing; Q32 stock adjustment approval; Q33 transfer in-transit;
Q35-Q39 bundling; Q44 history migration. VAT per line only for now.
Van receipt print format (thermal 80mm vs PDF) undecided.

## Not built, do not build unless asked
Journal Entry, Credit/Debit Note, Advance Allocation, Bank Reconciliation,
Contra Voucher.