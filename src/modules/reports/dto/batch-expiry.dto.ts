import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsMongoId, IsOptional, Min } from 'class-validator';

export class BatchExpiryQueryDto {
  /** The day to count from (default today). */
  @IsOptional()
  @IsDateString()
  asOf?: string;

  /** Only batches expiring within this many days of asOf (already expired ones included). Default: every batch with an expiry. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  daysAhead?: number;

  @IsOptional()
  @IsMongoId()
  productId?: string;
}
