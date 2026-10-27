import { IntersectionType, OmitType, PartialType, PickType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherQueryDto } from '../../vouchers/dto/voucher.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SalesReturnLineDto {
  /** The sales invoice line's _id. */
  @IsMongoId()
  invoiceLineId: string;

  /** Up to what the invoice line sold less what is already returned. */
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;

  /** Whether the goods go back into stock; default true. false posts accounts only. */
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

/** Purchase returns always take the goods out of stock: no restock flag. */
export class PurchaseReturnLineDto extends OmitType(SalesReturnLineDto, ['restock'] as const) {}

class ReturnHeaderDto {
  @IsDateString()
  date: string;

  /** An active warehouse, store or van; defaults to the invoice's location. */
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class CreateSalesReturnDto extends ReturnHeaderDto {
  /** Not cancelled. */
  @IsMongoId()
  salesInvoiceId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesReturnLineDto)
  lines: SalesReturnLineDto[];
}

export class CreatePurchaseReturnDto extends ReturnHeaderDto {
  /** Not cancelled. */
  @IsMongoId()
  purchaseInvoiceId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnLineDto)
  lines: PurchaseReturnLineDto[];
}

/** The invoice can't be changed: cancel the return and enter a new one. */
export class UpdateSalesReturnDto extends IntersectionType(
  PartialType(OmitType(CreateSalesReturnDto, ['salesInvoiceId'] as const)),
  ChangeNoteFieldDto,
) {}

export class UpdatePurchaseReturnDto extends IntersectionType(
  PartialType(OmitType(CreatePurchaseReturnDto, ['purchaseInvoiceId'] as const)),
  ChangeNoteFieldDto,
) {}

export class CancelReturnDto extends CancelVoucherDto {}

export class ReturnQueryDto extends PickType(VoucherQueryDto, ['dateFrom', 'dateTo', 'status', 'page', 'pageSize'] as const) {
  /** The customer or supplier. */
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsMongoId()
  invoiceId?: string;

  /** Case-insensitive match on the return or invoice number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
