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
storage, Users/Roles + scoping (Cashier module removed; collectors are users),
units + products (src/modules/product/{units,products}; ProductUsageRegistry
for later modules; purchasePrice only with products:view-cost).
In progress: Cash Handover (balance-based) + salesman report.
Built: opening balances (OB voucher). Stock step 1 (src/modules/stock):
StockEntry (insert-only) + StockBalance via StockService.post(entries,
actor, session, {strict}); reversalsOf(); Opening Stock OS-; /stock/summary,
/stock/history; User.allowedLocationIds scopes stock for own-scoped roles;
Company.allowNegativeStock (cancel always strict); product type locked once used.
Built: purchase invoice, allocation (payments->supplier bills, receipts->customer
bills), sales invoice (src/modules/sales/sales-invoices, SI-; payNow = cash
receipt + allocation in the same txn via optional session on
VoucherPostingService.create/cancel; Party.systemKey cash_customer;
/dashboard/sales|purchases).
Planned: stock transfer, bundling, returns, reports, migration.

## Conventions
- Permissions: one PERMISSIONS constant for every @RequirePermission().
  New permission = constant + seed. Seed is idempotent and upserts admin with
  ALL permissions. Users re-login to get new permissions. Vouchers use
  :read :create :edit :cancel (not :manage). Also balances:view,
  users:manage, roles:manage, vouchers:select-collector, reports:salesman,
  cash-handovers:read|create|approve|cancel, cheques:read|deposit|clear|return.
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
  CHQ, CR, CP, HO, PRD, OB.
- Opening balances (src/modules/accounting/opening-balances, OB-): lines
  {accountId, debit|credit}; diff posts to system account "Opening Balance
  Equity" (LedgerAccount.systemKey: not editable, hidden from lookups,
  rejected on voucher lines). One non-cancelled OB per account; no cheque
  accounts. POST /opening-balances/validate (by code, no posting).
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
  dashboard Cash & Bank total; seed makes "Cheques in Hand" + company
  default. Receipt paymentMethod cash|cheque|bank (explicit, must match the
  header type). Cheque receipt: chequeNumber + chequeDate + chequeBankName,
  number+bank unique among non-cancelled. chequeStatus at_office -> deposited
  (no posting) -> cleared (Dr destination, Cr receipt header) | returned
  (receipt reversed). Cheque receipt without cashAccountId posts to the
  company default cheques in hand; scoped users may use bank/cheque headers
  (scopeExemptHeaderTypes). Collector settlesWithOffice -> with_salesman;
  handover chequeIds -> submitted, approve -> at_office (no posting), reject
  or cancel -> with_salesman. Receipt attachments: POST
  /cash-receipts/:id/attachments (:create), DELETE .../:attachmentId (:edit),
  files ownerType cash-receipt, audited on the receipt. Handover pending is
  per user (their vouchers' entries), same-account approval posts nothing.
  Handover expenses[]: reserved on submit, approval posts source -> expense;
  paidFrom own (user's cash/wallet) | petty_cash (claim on Company
  defaultPettyCashAccountId; approval blocked if petty cash can't cover);
  bill via POST /cash-handovers/:id/expenses/:expenseId/attachment.
  Bank receipt by a collector who hands over (own-scoped role or
  settlesWithOffice; same rule for cheque with_salesman): bankHandoverStatus
  with_salesman -> submitted (receipt locked) -> verified on approval (no
  posting); handover bankReceiptIds; cheques/bank snapshot attachments. Edit/cancel only at_office|with_salesman. Admin undo
  reverses the last step. /cheques (src/modules/accounting/cheques), audit
  and comments entityType "cheque".
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