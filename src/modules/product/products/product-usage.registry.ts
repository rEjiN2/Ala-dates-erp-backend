import { Injectable } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';

/** Resolves true when `productId` is referenced by the registering module's records. */
export type ProductUsageCheck = (productId: Types.ObjectId, session?: ClientSession) => Promise<boolean>;

/**
 * Collects "is this product referenced?" checks from every module that points
 * at products (stock, purchase/sales invoices, bundles, ...). Same pattern as
 * LedgerAccountUsageRegistry: those modules import ProductsModule and register
 * their check from a provider constructor, so nothing here is circular.
 */
@Injectable()
export class ProductUsageRegistry {
  private readonly checks = new Map<string, ProductUsageCheck>();

  /** `source` names the referencing records in error messages, e.g. "sales invoices". */
  register(source: string, check: ProductUsageCheck): void {
    this.checks.set(source, check);
  }

  /** The first source that references the product, or null if none does. */
  async findUsage(productId: Types.ObjectId, session?: ClientSession): Promise<string | null> {
    for (const [source, check] of this.checks) {
      if (await check(productId, session)) {
        return source;
      }
    }
    return null;
  }

  async isProductUsed(productId: Types.ObjectId, session?: ClientSession): Promise<boolean> {
    return (await this.findUsage(productId, session)) !== null;
  }
}
