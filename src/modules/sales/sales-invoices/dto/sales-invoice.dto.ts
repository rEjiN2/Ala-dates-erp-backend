import { IntersectionType, OmitType, PartialType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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

  /** Any discount needs sales:discount. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;

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
  PartialType(OmitType(CreateSalesInvoiceDto, ['payNow'] as const)),
  ChangeNoteFieldDto,
) {}

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
