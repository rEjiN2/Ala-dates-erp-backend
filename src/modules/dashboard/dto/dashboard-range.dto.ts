import { IsDateString, IsOptional } from 'class-validator';

/** A date range; defaults to the last 30 days. A date-only dateTo covers the whole day. */
export class DashboardRangeDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
