import { IntersectionType, PartialType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';

export class OpeningStockLineDto {
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost?: number | null;
}

export class CreateOpeningStockDto {
  /** Not in the future. */
  @IsDateString()
  asOfDate: string;

  /** An active warehouse, store or van. */
  @IsMongoId()
  locationId: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OpeningStockLineDto)
  lines: OpeningStockLineDto[];
}

export class UpdateOpeningStockDto extends IntersectionType(PartialType(CreateOpeningStockDto), ChangeNoteFieldDto) {}

export class CancelOpeningStockDto extends CancelVoucherDto {}

export class OpeningStockQueryDto extends PickType(VoucherQueryDto, [
  'dateFrom',
  'dateTo',
  'status',
  'q',
  'page',
  'pageSize',
] as const) {
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  @IsOptional()
  @IsMongoId()
  productId?: string;
}

/** Quantities are checked per row (errors returned, not thrown). */
export class ValidateOpeningStockLineDto {
  @IsString()
  @MaxLength(50)
  productCode: string;

  @IsOptional()
  @IsNumber()
  qty?: number;

  @IsOptional()
  @IsNumber()
  unitCost?: number | null;
}

/** Lines by product code (e.g. an import); nothing is posted. */
export class ValidateOpeningStockDto {
  /** Checks each product against existing opening stock at this location. */
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  /** When validating an edit: the voucher being edited. */
  @IsOptional()
  @IsMongoId()
  voucherId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ValidateOpeningStockLineDto)
  lines: ValidateOpeningStockLineDto[];
}
