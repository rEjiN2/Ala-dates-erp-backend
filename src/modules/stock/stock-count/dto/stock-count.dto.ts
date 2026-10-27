import { PartialType, PickType } from '@nestjs/mapped-types';
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
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';
import { StockCountStatus } from '../schemas/stock-count.schema.js';

export class StockCountLineDto {
  @IsMongoId()
  productId: string;

  /** Leave out until counted. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  countedQty?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string | null;
}

export class CreateStockCountDto {
  /** Not in the future. */
  @IsDateString()
  date: string;

  /** An active warehouse, store or van. */
  @IsMongoId()
  locationId: string;

  @IsOptional()
  @IsString()
  comments?: string;

  /** Each product added gets the current balance as its snapshotQty. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockCountLineDto)
  lines?: StockCountLineDto[];
}

export class UpdateStockCountDto extends PartialType(CreateStockCountDto) {}

export class LoadStockCountDto {
  @IsOptional()
  @IsMongoId()
  groupId?: string;

  @IsOptional()
  @IsBoolean()
  onlyWithStock?: boolean;
}

export class ApproveStockCountDto {
  /** Required when a line's balance moved after its snapshot. */
  @IsOptional()
  @IsBoolean()
  acknowledgeMoved?: boolean;
}

export class RejectStockCountDto extends CancelVoucherDto {}
export class CancelStockCountDto extends CancelVoucherDto {}

export class StockCountQueryDto extends PickType(VoucherQueryDto, ['dateFrom', 'dateTo', 'q', 'page', 'pageSize'] as const) {
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  @IsOptional()
  @IsEnum(StockCountStatus)
  status?: StockCountStatus;
}

export class ValidateStockCountLineDto {
  @IsString()
  @MaxLength(50)
  productCode: string;

  @IsOptional()
  @IsNumber()
  countedQty?: number | null;

  @IsOptional()
  @IsString()
  reason?: string | null;
}

/** Lines by product code (e.g. a CSV); nothing is saved. */
export class ValidateStockCountDto {
  /** With a location, each resolved line carries its current system quantity. */
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ValidateStockCountLineDto)
  lines: ValidateStockCountLineDto[];
}
