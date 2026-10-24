import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class StockSummaryQueryDto {
  /** Case-insensitive match on product name, code or barcode. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** The group and every group below it. */
  @IsOptional()
  @IsMongoId()
  groupId?: string;

  @IsOptional()
  @IsMongoId()
  locationId?: string;

  /** Only products at or below their reorder level or minimum. */
  @IsOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.lowStock === true || obj.lowStock === 'true')
  @IsBoolean()
  lowStock?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class StockHistoryQueryDto {
  @IsMongoId()
  productId: string;

  @IsOptional()
  @IsMongoId()
  locationId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /** A date-only value covers the whole day. */
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
