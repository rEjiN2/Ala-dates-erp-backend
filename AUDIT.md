# Backend Audit (read-only, 2026-10-30)

Paths relative to `src/modules/`. Status: done / partial / missing.

## 1. Git
| Check | Status | Evidence | Note |
|---|---|---|---|
| git log -40 | done | 21 commits total (history shorter than 40) | Latest: a1baa56 added-to-test, 12fdcab added-bundling |
| git status | done | `M tsconfig.build.tsbuildinfo` only | Build artifact tracked; no source changes pending |

## 2. Module folders
| Check | Status | Evidence | Note |
|---|---|---|---|
| Folders | done | accounting (allocations, cash-handovers, cash-payments, cash-receipts, cheques, ledger-accounts, opening-balances, returns, vouchers), audit, auth, comments, company, dashboard, files, inventory, location, party, product (groups, products, units), purchase, reports, roles, sales, sequence, stock (bundling, opening-stock, stock-count), storage, supplier, users | `inventory/` holds only a module file; `supplier/` appears empty |

## 3. Permission strings (roles/permissions.ts)
| Check | Status | Evidence | Note |
|---|---|---|---|
| Constant | done | `roles/permissions.ts` enum `Permission` (not `PERMISSIONS`) | Name differs from CLAUDE.md |
| Strings | done | accounts:manage, balances:view, cash-receipts/reference-receipts/cash-payments :read\|create\|edit\|cancel, cheques:read\|deposit\|clear\|return, cash-handovers:read\|create\|approve\|cancel, opening-balances:read\|create\|edit\|cancel, stock:read, stock:view-system-qty, stock-counts:read\|create\|approve\|cancel, opening-stock:read\|create\|edit\|cancel, bundles:manage, bundling:read\|create\|cancel, allocations:manage, purchase-invoices/sales-invoices/purchase-returns/sales-returns :read\|create\|edit\|cancel, sales:override-price, sales:discount, sales:override-credit, company:manage, locations:manage, parties:manage, product-groups:manage, products:manage, products:view-cost, units:manage, reports:salesman, reports:accounting, roles:manage, users:manage, vouchers:select-collector, dashboard:view | No stock-transfer permissions |

## 4. Sequences (key → prefix, width)
| Check | Status | Evidence | Note |
|---|---|---|---|
| Locations | done | location:branch BR-, :warehouse WH-, :store ST-, :van VAN- (4) | `location/location-code.ts` |
| Parties | done | party:customer CUS-, party:supplier SUP- | `party/party-code.ts` |
| Accounts | done | ledger-account:cash CASH-, bank BNK-, wallet WAL-, cheque CHQ-, income INC-, expense EXP-, other OTH- | `ledger-account-code.ts` |
| Products | done | product PRD-, product-group PG- | |
| Vouchers | done | cash-receipt `CR` (width 6, no dash), CRV CRV-, cash-payment CP-, handover HO-, opening-balance OB-, sales-return SR-, purchase-return PR-, sales-invoice SI-, purchase-invoice PI- | CR has no dash and 6 digits |
| Stock | done | opening-stock OS-, stock-count SC-, bundling BND- | |
| Transfer | missing | no sequence or module | CLAUDE.md lists "stock transfer" as planned; git log mentions it |

## 5. System accounts and parties
| Check | Status | Evidence | Note |
|---|---|---|---|
| SYSTEM_ACCOUNTS | done | `ledger-account.schema.ts:21`: purchases, vat_input, sales, vat_output, sales_returns, purchase_returns | Seeded in `database/seed.ts` |
| Opening Balance Equity | done | `OPENING_BALANCE_EQUITY_KEY`, `seed.ts:125` | Type other |
| Seeded parties | done | Cash Customer, systemKey `CASH_CUSTOMER_KEY` (`seed.ts:140`) | Adopts an existing same-name customer |
| Seeded accounts | done | Cheques in Hand, Branch Petty Cash (`seed.ts`) | Set as Company defaults |

## 6. Mongoose collections
| Check | Status | Evidence | Note |
|---|---|---|---|
| List | done | file_attachments, company_settings, comments, cash_receipts, allocations, ledger_accounts (schema options), users, parties, audit_logs, purchase_invoices, vouchers/ledger_entries, handovers, sales_returns, purchase_returns, cash_payments, opening_balances, locations, product_groups, products, units, roles, counters, sales_invoices, stock_balances, stock_entries, stock_counts, opening_stocks, bundle_recipes, bundlings | Legacy `cashiers`, `cash_handovers` unused |

## 7. Contradictions with CLAUDE.md
| Check | Status | Evidence | Note |
|---|---|---|---|
| Permission constant name | partial | `Permission` enum, `roles/permissions.ts` | CLAUDE.md says PERMISSIONS |
| "Not built: Credit/Debit Note" | partial | `accounting/returns` SR-/PR- built | Same file's Status calls them built; fix the list |
| Stock transfer "Planned" | partial | no transfer code; `stock.controller` has summary/history only | Matches "planned" but git log claims it |
| Stock count, bundling | partial | `stock/stock-count`, `stock/bundling` built | Missing from Status; not in CLAUDE.md |
| Reference receipt CRV | partial | `cash-receipt.definition.ts:55`, reference-receipts:* | Absent from CLAUDE.md codes list |
| PI-, SI-, OS-, SC-, BND-, CRV | partial | sequences above | CLAUDE.md codes list incomplete |
| Reports "planned" | partial | ledger, day-book, cash-book, trial-balance exist | Partly built |
| Sequence key vs prefix | done | CR is `CR` not `CR-` | Matches CLAUDE.md "CR" |

## Sales Invoice
| Check | Status | Evidence | Note |
|---|---|---|---|
| a) Line discount type | partial | `sales-invoice.service.ts:613-636`: `discount` as amount only | No percent option |
| a) Invoice-level discount | missing | only `totalDiscount` = sum of lines | No header discount field |
| a) VAT after discount | done | `amount = qty*rate - discount; vat = amount*vatRate/100` | |
| a) Permission gating | done | `sales:discount`, `sales:override-price`, `sales:override-credit` | Edit also re-checks pricing |
| b) Non-VAT invoice kind | missing | no kind field; `vatRate` per line can be 0 | No separate number series |
| c) PDF columns | partial | `buildVoucherPdf` titled TAX INVOICE; line: product, narration, amount, vat, netAmount | Narration is a derived "qty x rate less disc"; no unit price column |
| c) Narration printed | partial | `sales-invoice.service.ts:540` | Generated text, not the user's remark; `remarks` goes to comments |
| d) Pay-now | done | `payNow` DTO, receipt + allocation in one txn (`:273-321`) | |
| d) Credit limit | done | `assertCredit` `:674`, `acknowledgeCredit` | Blocks without `sales:override-credit` |
| d) Cash Customer | done | `CASH_CUSTOMER_KEY`; payNow must equal total (`:279`) | |

## Sales Return
| Check | Status | Evidence | Note |
|---|---|---|---|
| e) Creation | partial | `return.dto.ts` `salesInvoiceId` required, lines by `invoiceLineId` | Against one invoice only; no customer+product search |
| f) Settlement | partial | auto-allocation to invoice; `POST :id/refund` (`sales-return.controller.ts:55`) | Refund via endpoint creating a payment voucher; no inline choice |
| g) Restock timing | partial | `restock` flag per line, immediate (`return.service.ts:703`) | No pending/in-transit or warehouse confirm |
| h) Roles | done | `sales-returns:create`; role assignment in `seed-roles.ts` | Permission-based; not a fixed role list |

## Costing
| Check | Status | Evidence | Note |
|---|---|---|---|
| i) CostLayer/CostService/LayerConsumption | missing | grep over `src` finds none | |
| i) FIFO in sales/returns/bundling/counts | missing | none | `unitCost` = product purchasePrice at sale time |
| i) Migration script | missing | `database/` has none for costing | |
| i) Valuation basis | partial | `unitCost` snapshot on invoice line from `Product.purchasePrice` | Latest price, not true cost |

## Reports
| Check | Status | Evidence | Note |
|---|---|---|---|
| j) VAT report | missing | `reports.controller.ts` has no vat route | VAT only in vat_output/vat_input balances |
| k) Ledger | done | `GET /reports/ledger` | reports:accounting |
| k) Day-book | done | `GET /reports/day-book` | |
| k) Cash-book | done | `GET /reports/cash-book` | |
| k) Trial balance | done | `GET /reports/trial-balance` | |
| k) Debtors/creditors ageing | missing | no route | |
| k) Batch-expiry | missing | no batch/expiry field or route | |
| k) Salesman collections | done | `GET /reports/salesman-collections[/:staffId]` | |

## Parties and payments
| Check | Status | Evidence | Note |
|---|---|---|---|
| l) Payment line types | done | `cash-payment.definition.ts:11-15`: supplier, party, expense, income, other | CLAUDE.md says supplier, customer, expense, other; income is extra |
| l) Receipt line types | done | `cash-receipt.definition.ts:11-15`: party, supplier, income, expense, other | CLAUDE.md omits income |
| m) Cashier/Staff module | done | none; only a `collected-by` migration | Users are the collector |
| n) Customer fields | partial | `party.schema.ts`: creditLimit, creditDays, vatNumber, address1-3, `shippingAddresses[]` | No emirate field found |

## Printing
| Check | Status | Evidence | Note |
|---|---|---|---|
| o) `?size` param | missing | no `size` query in controllers; A4 hard-coded | |
| o) Company printDefaults | missing | not in `company-settings.schema.ts` | |
| o) Original/Duplicate | done | `printCount`; ORIGINAL then DUPLICATE in invoice, receipt, payment, handover | Each print audited |
| o) Reference Receipt (CRV) | done | `ReceiptKind.REFERENCE`, CRV- series, own permissions | Plain print |
