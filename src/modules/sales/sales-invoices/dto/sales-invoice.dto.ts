import { IntersectionType, OmitType, PartialType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherFieldsDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';
import { PaymentStatus } from '../../../accounting/allocations/schemas/allocation.schema.js';
import { PaymentMethod } from '../../../accounting/vouchers/schemas/voucher.schema.js';
import { DISCOUNT_TYPES, type DiscountType } from '../sales-pricing.js';

export const INVOICE_KINDS = ['tax', 'non_vat'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export class SalesInvoiceLineDto {
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;

  /** Before VAT; defaults to the product's sale price. Anything else needs sales:override-price. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  rate?: number;

  /** Legacy amount discount; same as discountType amount + discountValue. Any discount needs sales:discount. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;

  /** Defaults to amount. */
  @IsOptional()
  @IsIn(DISCOUNT_TYPES)
  discountType?: DiscountType;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountValue?: number;

  /** Percent; defaults to the product's VAT rate. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  vatRate?: number;
}

/** Money taken at the sale: posted as a cash receipt (collected by the salesman) allocated to the invoice. */
export class PayNowDto extends PickType(VoucherFieldsDto, ['chequeDate', 'chequeNumber', 'chequeBankName', 'paymentReference'] as const) {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  /** Received into (cash/wallet/bank/cheque account). A cheque may leave it out: company cheques in hand. */
  @IsOptional()
  @IsMongoId()
  accountId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;
}

export class CreateSalesInvoiceDto {
  /** tax (default) or non_vat: SNV- number, VAT 0 on every line, needs non-vat-invoices:create. */
  @IsOptional()
  @IsIn(INVOICE_KINDS)
  invoiceKind?: InvoiceKind;

  @IsDateString()
  date: string;

  /** An active customer. */
  @IsMongoId()
  customerId: string;

  /** An active warehouse, store or van; "own"-scoped users with one allowed location may leave it out. */
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  /** Defaults to the caller; anyone else needs vouchers:select-collector. */
  @IsOptional()
  @IsMongoId()
  soldById?: string;

  /** Defaults to date + the customer's credit days. */
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesInvoiceLineDto)
  lines: SalesInvoiceLineDto[];

  /** Invoice discount, applied after the line discounts (needs sales:discount). Defaults to amount. */
  @IsOptional()
  @IsIn(DISCOUNT_TYPES)
  discountType?: DiscountType;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountValue?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PayNowDto)
  payNow?: PayNowDto;

  /** Confirms selling beyond the customer's credit limit (needs sales:override-credit). */
  @IsOptional()
  @IsBoolean()
  acknowledgeCredit?: boolean;
}

/** Payment is never taken on an edit: record a cash receipt instead. */
export class UpdateSalesInvoiceDto extends IntersectionType(
  PartialType(OmitType(CreateSalesInvoiceDto, ['payNow', 'invoiceKind'] as const)),
  ChangeNoteFieldDto,
) {}

/** POST /sales-invoices/preview: the lines and discount of a draft; nothing is saved. */
export class PreviewSalesInvoiceDto extends PickType(CreateSalesInvoiceDto, ['lines', 'discountType', 'discountValue', 'invoiceKind'] as const) {}

export class CancelSalesInvoiceDto extends CancelVoucherDto {}

export class SalesInvoiceQueryDto extends PickType(VoucherQueryDto, ['dateFrom', 'dateTo', 'status', 'page', 'pageSize'] as const) {
  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsMongoId()
  locationId?: string;

  /** User id of the salesman. */
  @IsOptional()
  @IsMongoId()
  soldById?: string;

  /** tax (default), non_vat or all. non_vat needs non-vat-invoices:read; all shows the kinds you may read. */
  @IsOptional()
  @IsIn(['tax', 'non_vat', 'all'])
  kind?: 'tax' | 'non_vat' | 'all';

  /** Implies status posted unless a status is given. */
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  /** Case-insensitive match on the invoice number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
