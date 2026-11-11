import { Types, type ClientSession, type Collection } from 'mongoose';

const roundQty = (qty: number) => Math.round(qty * 1000) / 1000;
const roundCost = (cost: number) => Math.round(cost * 10000) / 10000;
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const EPSILON = 0.0005;

/** Stock transfers never touch cost layers: they only move quantity between locations. */
const TRANSFER = 'stock-transfer';
const SALES_INVOICE = 'sales-invoice';

export interface FifoCollections {
  entries: Collection;
  products: Collection;
  balances: Collection;
  transfers: Collection;
  layers: Collection;
  consumptions: Collection;
  salesInvoices: Collection;
}

export interface EntryRow {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  qty: number;
  date: Date;
  voucherType: string;
  voucherId: Types.ObjectId;
  voucherNo: string;
  unitCost?: number | null;
  reversalOf?: Types.ObjectId | null;
  postedAt?: Date;
}

interface PlannedLayer {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  sourceType: string;
  sourceVoucherId: Types.ObjectId;
  sourceLineId: null;
  date: Date;
  qtyIn: number;
  qtyRemaining: number;
  unitCost: number;
  expiryDate: null;
  createdAt: Date;
  voidedAt: null;
}

export interface PlannedOutflow {
  /** Sales invoices: index of the invoice line this outflow belongs to (-1 if unknown). */
  lineIndex?: number;
  entry: EntryRow;
  parts: { layerId: Types.ObjectId | null; qty: number; unitCost: number; uncosted: boolean }[];
}

/**
 * One product's FIFO history rebuilt from its stock entries: inflows become
 * layers (cost = the entry's unitCost, else the product's purchase price),
 * outflows are replayed oldest-first in date order. Voided pairs (an entry and
 * its reversal) and transfers are skipped.
 */
export function replayProduct(entries: readonly EntryRow[], purchasePrice: number) {
  const reversed = new Set(entries.flatMap((entry) => (entry.reversalOf ? [entry.reversalOf.toString()] : [])));
  const live = entries
    .filter((entry) => entry.voucherType !== TRANSFER && !entry.reversalOf && !reversed.has(entry._id.toString()))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || (a.postedAt?.getTime() ?? 0) - (b.postedAt?.getTime() ?? 0) || (a._id.toString() < b._id.toString() ? -1 : 1));

  const layers: PlannedLayer[] = [];
  const outflows: PlannedOutflow[] = [];
  for (const entry of live) {
    if (entry.qty > 0) {
      layers.push({
        _id: new Types.ObjectId(),
        productId: entry.productId,
        sourceType: entry.voucherType,
        sourceVoucherId: entry.voucherId,
        sourceLineId: null,
        date: entry.date,
        qtyIn: roundQty(entry.qty),
        qtyRemaining: roundQty(entry.qty),
        unitCost: roundCost(Math.max(0, entry.unitCost ?? purchasePrice)),
        expiryDate: null,
        createdAt: entry.postedAt ?? entry.date,
        voidedAt: null,
      });
      continue;
    }
    let need = roundQty(-entry.qty);
    const parts: PlannedOutflow['parts'] = [];
    for (const layer of layers) {
      if (need <= EPSILON) break;
      if (layer.qtyRemaining <= EPSILON) continue;
      const take = roundQty(Math.min(layer.qtyRemaining, need));
      layer.qtyRemaining = roundQty(layer.qtyRemaining - take);
      parts.push({ layerId: layer._id, qty: take, unitCost: layer.unitCost, uncosted: false });
      need = roundQty(need - take);
    }
    if (need > EPSILON) {
      const latest = layers[layers.length - 1];
      parts.push({ layerId: null, qty: need, unitCost: latest?.unitCost ?? roundCost(purchasePrice), uncosted: true });
    }
    outflows.push({ entry, parts });
  }
  return { layers, outflows };
}

export interface FifoMismatch {
  productId: string;
  code: string;
  layerQty: number;
  onHand: number;
  inTransit: number;
  diff: number;
}

export interface FifoReport {
  apply: boolean;
  products: number;
  skipped: number;
  layers: number;
  consumptions: number;
  invoicesCosted: number;
  /** Per product: sum(layer qtyRemaining) vs total on hand + in transit; only those that differ. */
  mismatches: FifoMismatch[];
}

/**
 * `pnpm migrate:fifo`: builds cost layers from the existing stock entries,
 * replays outflows to set what is left, and backfills line costs, costTotal
 * and margin on posted sales invoices. Dry run unless `apply`. Products that
 * already have layers are skipped, so it is safe to re-run. Each product is
 * written in its own transaction (`inTransaction`).
 */
export async function backfillFifo(
  db: FifoCollections,
  options: { apply: boolean },
  inTransaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>,
): Promise<FifoReport> {
  const report: FifoReport = { apply: options.apply, products: 0, skipped: 0, layers: 0, consumptions: 0, invoicesCosted: 0, mismatches: [] };
  const productIds = (await db.entries.distinct('productId')) as Types.ObjectId[];
  const withLayers = new Set(((await db.layers.distinct('productId')) as Types.ObjectId[]).map((id) => id.toString()));
  const products = new Map(
    (await db.products.find({ _id: { $in: productIds } }, { projection: { code: 1, purchasePrice: 1 } }).toArray()).map((p) => [p._id.toString(), p]),
  );
  const onHand = new Map<string, number>(
    (await db.balances.aggregate([{ $group: { _id: '$productId', qty: { $sum: '$qty' } } }]).toArray()).map((row) => [row._id.toString(), roundQty(row.qty)]),
  );
  const inTransit = new Map<string, number>(
    (
      await db.transfers
        .aggregate([{ $match: { status: 'in_transit' } }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', qty: { $sum: '$lines.qty' } } }])
        .toArray()
    ).map((row) => [row._id.toString(), roundQty(row.qty)]),
  );

  // Posted sales invoices: each stock line takes the next outflow of its product, in line order.
  type InvoiceLine = { _id?: Types.ObjectId; productId: Types.ObjectId; costAmount?: number };
  const invoices = new Map(
    (await db.salesInvoices.find({ status: 'posted' }, { projection: { lines: 1, taxableTotal: 1 } }).toArray()).map((doc) => [doc._id.toString(), doc]),
  );
  const salesOutflows = new Map<string, PlannedOutflow[]>();

  for (const productId of productIds) {
    const id = productId.toString();
    if (withLayers.has(id)) {
      report.skipped++;
      continue;
    }
    const product = products.get(id);
    const entries = (await db.entries.find({ productId }).toArray()) as unknown as EntryRow[];
    const { layers, outflows } = replayProduct(entries, product?.purchasePrice ?? 0);
    report.products++;
    report.layers += layers.length;
    report.consumptions += outflows.reduce((sum, outflow) => sum + outflow.parts.length, 0);

    const nthOfInvoice = new Map<string, number>();
    for (const outflow of outflows) {
      if (outflow.entry.voucherType !== SALES_INVOICE) continue;
      const key = outflow.entry.voucherId.toString();
      const nth = nthOfInvoice.get(key) ?? 0;
      nthOfInvoice.set(key, nth + 1);
      const lineIndexes = ((invoices.get(key)?.lines ?? []) as InvoiceLine[]).flatMap((line, index) =>
        line.productId.equals(productId) ? [index] : [],
      );
      outflow.lineIndex = lineIndexes[nth] ?? -1;
      if (invoices.has(key)) salesOutflows.set(key, [...(salesOutflows.get(key) ?? []), outflow]);
    }

    const layerQty = roundQty(layers.reduce((sum, layer) => sum + layer.qtyRemaining, 0));
    const expected = roundQty((onHand.get(id) ?? 0) + (inTransit.get(id) ?? 0));
    if (roundQty(layerQty - expected) !== 0) {
      report.mismatches.push({
        productId: id,
        code: product?.code ?? id,
        layerQty,
        onHand: onHand.get(id) ?? 0,
        inTransit: inTransit.get(id) ?? 0,
        diff: roundQty(layerQty - expected),
      });
    }
    if (!options.apply) continue;

    await inTransaction(async (session) => {
      if (layers.length > 0) await db.layers.insertMany(layers, { session });
      const rows = outflows.flatMap(({ entry, parts, lineIndex }) => {
        const line =
          lineIndex !== undefined && lineIndex >= 0
            ? (invoices.get(entry.voucherId.toString())!.lines as InvoiceLine[])[lineIndex]
            : undefined;
        return parts.map((part) => ({
          layerId: part.layerId,
          productId,
          voucherType: entry.voucherType,
          voucherId: entry.voucherId,
          voucherNo: entry.voucherNo,
          lineId: line?._id ?? null,
          qty: part.qty,
          unitCost: part.unitCost,
          uncosted: part.uncosted,
          createdAt: entry.postedAt ?? entry.date,
          reversedAt: null,
        }));
      });
      if (rows.length > 0) await db.consumptions.insertMany(rows, { session });
    });
  }

  // Line costs, costTotal and margin on the sales invoices costed in this run.
  for (const [voucherId, outflows] of salesOutflows) {
    const invoice = invoices.get(voucherId)!;
    const set: Record<string, unknown> = {};
    let costTotal = 0;
    (invoice.lines as InvoiceLine[]).forEach((line, index) => {
      const outflow = outflows.find((candidate) => candidate.lineIndex === index);
      if (!outflow) {
        costTotal += line.costAmount ?? 0;
        return;
      }
      const qty = outflow.parts.reduce((sum, part) => sum + part.qty, 0);
      const amount = round2(outflow.parts.reduce((sum, part) => sum + part.qty * part.unitCost, 0));
      set[`lines.${index}.costAmount`] = amount;
      set[`lines.${index}.unitCost`] = qty > 0 ? roundCost(amount / qty) : 0;
      set[`lines.${index}.uncosted`] = outflow.parts.some((part) => part.uncosted);
      costTotal += amount;
    });
    if (Object.keys(set).length === 0) continue;
    report.invoicesCosted++;
    set.costTotal = round2(costTotal);
    set.margin = round2((invoice.taxableTotal ?? 0) - round2(costTotal));
    if (options.apply) await db.salesInvoices.updateOne({ _id: invoice._id }, { $set: set });
  }
  return report;
}
