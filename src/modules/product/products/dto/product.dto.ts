import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ProductStatus, ProductType } from '../schemas/product.schema.js';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// No `code` and no image: the code is generated and the image has its own
// route. The global pipe's forbidNonWhitelisted rejects either.
export class CreateProductDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsMongoId()
  productGroupId: string;

  @IsEnum(ProductType)
  type: ProductType;

  @IsMongoId()
  unitId: string;

  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(50) barcode?: string | null;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) salePrice?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) purchasePrice?: number;

  /** Percent; defaults to 5. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) vatRate?: number;

  /** Optional; when set, minStock <= reorderLevel <= maxStock. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) minStock?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) reorderLevel?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) maxStock?: number | null;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

/** Any subset; null clears an optional field. Set status "inactive" to deactivate. */
export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class ProductQueryDto {
  /** Case-insensitive match on name, code or barcode. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** This group and every group under it. */
  @IsOptional()
  @IsMongoId()
  groupId?: string;

  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class ProductLookupQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsMongoId()
  groupId?: string;

  @IsOptional()
  @IsEnum(ProductType)
  type?: ProductType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
