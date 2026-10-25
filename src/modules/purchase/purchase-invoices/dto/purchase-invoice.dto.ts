import { IntersectionType, PartialType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';
import { PaymentStatus } from '../../../accounting/allocations/schemas/allocation.schema.js';

export class PurchaseInvoiceLineDto {
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;

  /** Before VAT. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  rate: number;

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

export class CreatePurchaseInvoiceDto {
  @IsDateString()
  date: string;

  /** An active supplier. */
  @IsMongoId()
  supplierId: string;

  /** An active warehouse, store or van. */
  @IsMongoId()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  billNo: string;

  @IsOptional()
  @IsDateString()
  billDate?: string | null;

  /** Defaults to date + the supplier's credit days. */
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string | null;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  attachmentFileRefs?: string[];

  /** Sets each product's purchase price to its line rate; default true. */
  @IsOptional()
  @IsBoolean()
  updatePurchasePrice?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseInvoiceLineDto)
  lines: PurchaseInvoiceLineDto[];
}

export class UpdatePurchaseInvoiceDto extends IntersectionType(PartialType(CreatePurchaseInvoiceDto), ChangeNoteFieldDto) {}

export class CancelPurchaseInvoiceDto extends CancelVoucherDto {}

export class PurchaseInvoiceQueryDto extends PickType(VoucherQueryDto, [
  'dateFrom',
  'dateTo',
  'status',
  'page',
  'pageSize',
] as const) {
  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsOptional()
  @IsMongoId()
  locationId?: string;

  /** Implies status posted unless a status is given. */
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  /** Case-insensitive match on the invoice number or the supplier's bill number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
