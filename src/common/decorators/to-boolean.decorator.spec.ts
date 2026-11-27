import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { createAppValidationPipe } from '../pipes/app-validation.pipe.js';
import { ProductLookupQueryDto, ProductQueryDto } from '../../modules/product/products/dto/product.dto.js';
import { StockTransferQueryDto } from '../../modules/stock/transfers/dto/stock-transfer.dto.js';

// Through the real global pipe: implicit conversion turns "false" into true before a plain @Transform runs.
const pipe = createAppValidationPipe();
const parse = <T>(metatype: new () => T, query: Record<string, string>) =>
  pipe.transform(query, { type: 'query', metatype } as ArgumentMetadata) as Promise<T>;

describe('ToBoolean query fields', () => {
  it('maps true/1 and false/0, leaves absent undefined', async () => {
    expect((await parse(ProductLookupQueryDto, { isBundle: 'false' })).isBundle).toBe(false);
    expect((await parse(ProductLookupQueryDto, { isBundle: '0' })).isBundle).toBe(false);
    expect((await parse(ProductLookupQueryDto, { isBundle: 'true' })).isBundle).toBe(true);
    expect((await parse(ProductLookupQueryDto, { isBundle: '1' })).isBundle).toBe(true);
    expect((await parse(ProductLookupQueryDto, {})).isBundle).toBeUndefined();
    expect((await parse(ProductQueryDto, { isBundle: 'false' })).isBundle).toBe(false);
    await expect(parse(ProductLookupQueryDto, { isBundle: 'maybe' })).rejects.toThrow();
  });

  it('receivableByMe=false is not treated as true', async () => {
    expect((await parse(StockTransferQueryDto, { receivableByMe: 'false' })).receivableByMe).toBe(false);
    expect((await parse(StockTransferQueryDto, { receivableByMe: 'true' })).receivableByMe).toBe(true);
  });
});
