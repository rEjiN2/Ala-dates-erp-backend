import { IsDateString, IsMongoId, IsOptional } from 'class-validator';

export class SalesmanCollectionsQueryDto {
  /** Inclusive. Without it the range starts at the first voucher and the opening is 0. */
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /** Inclusive; a date-only value covers the whole day. Without it the range runs to now. */
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /** The Collected By user. */
  @IsOptional()
  @IsMongoId()
  userId?: string;

  /** Older name for userId. */
  @IsOptional()
  @IsMongoId()
  staffId?: string;

  /** Users based at this location. */
  @IsOptional()
  @IsMongoId()
  locationId?: string;
}

/** The details endpoint takes the user from the path. */
export class SalesmanCollectionDetailsQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
