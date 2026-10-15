# Project: Dates Trading ERP — Backend

## Stack
- NestJS + TypeScript, organized by business module (party, supplier, product,
  location, purchase, sales, inventory, accounting...)
- MongoDB via Mongoose. Use Mongo transactions for anything touching money or
  stock quantity so a partial write can never leave balances inconsistent.
- File storage: adapter pattern behind a `StorageService` interface
  (`upload`, `getUrl`, `delete`). Default implementation targets Cloudflare R2
  via the S3-compatible SDK — never hard-code an AWS-specific SDK call outside
  that one adapter file.
- Auth: JWT-based, with a role/permission model (not just a single "admin"
  role) since Stock Adjustment and other sensitive actions need approval
  gating later.

## Business context
- Dates trading company, multi-branch, multi-location stock.
- Location hierarchy is ONE self-referencing collection:
  `Location { code, name, type: branch|warehouse|store|van, parentId, status }`
  Branch and Warehouse are organizational only. Store and Van each carry their
  own stock balance. Don't model Branch/Warehouse/Van as separate collections.
- Bundling converts N component products into 1 finished bundle product (or
  reverses it) — this needs its own stock-movement logic, not a generic
  transfer.
- Bill-wise allocation (linking a receipt/payment to specific outstanding
  invoices) is central to the accounting flow — design the Cash
  Receipt/Payment schema with this in mind even before it's implemented.

## Ground truth
- Exact field lists, validation, and screen behavior come from the uploaded
  Functional Specification. Ask for the relevant section before inventing
  field names or business rules.
- Anything the spec marks "Clarification Required" is a genuine open
  question — do not silently pick an assumption for it; ask.