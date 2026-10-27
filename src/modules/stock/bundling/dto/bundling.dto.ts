import { PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';
import { BundlingMode } from '../schemas/bundling.schema.js';

export class RecipeComponentDto {
  /** A stock product (no bundles, not the bundle itself). */
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;
}

export class SetRecipeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecipeComponentDto)
  components: RecipeComponentDto[];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  extraCostPerUnit: number;
}

export class CreateBundlingDto {
  /** Not in the future. */
  @IsDateString()
  date: string;

  /** An active warehouse, store or van. */
  @IsMongoId()
  locationId: string;

  @IsEnum(BundlingMode)
  mode: BundlingMode;

  /** Must have a recipe. */
  @IsMongoId()
  bundleProductId: string;

  @IsInt()
  @IsPositive()
  qty: number;

  /** Bundle mode only: set the bundle's purchase price to the computed cost. Default true. */
  @IsOptional()
  @IsBoolean()
  updateBundlePurchasePrice?: boolean;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class CancelBundlingDto extends CancelVoucherDto {}

export class BundlingQueryDto extends PickType(VoucherQueryDto, [
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
  bundleProductId?: string;

  @IsOptional()
  @IsEnum(BundlingMode)
  mode?: BundlingMode;
}

export class AvailabilityQueryDto {
  @IsMongoId()
  locationId: string;

  /** Bundles to make; default 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  qty?: number;
}
