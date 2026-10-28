import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, Min } from 'class-validator';

const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : value;
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** Shared by every accounting report. Date-only values cover the whole day (voucher dates are calendar days). */
export class AccountingReportQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /** Show cancelled vouchers and their reversals, flagged. Default: both left out (they net to zero). */
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  includeCancelled?: boolean;

  /** csv or pdf downloads the whole report instead of a JSON page. */
  @IsOptional()
  @IsIn(['csv', 'pdf'])
  format?: 'csv' | 'pdf';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class LedgerReportQueryDto extends AccountingReportQueryDto {
  @IsMongoId()
  accountId: string;
}

export class DayBookQueryDto extends AccountingReportQueryDto {
  /** Comma-separated voucher types, e.g. cash-receipt,sales-invoice. */
  @IsOptional()
  @Transform(csv)
  @IsString({ each: true })
  voucherTypes?: string[];

  @IsOptional()
  @IsMongoId()
  userId?: string;
}

export class CashBookQueryDto extends AccountingReportQueryDto {
  /** Comma-separated; default every cash, wallet, cheque and bank account. */
  @IsOptional()
  @Transform(csv)
  @IsMongoId({ each: true })
  accountIds?: string[];
}

export class TrialBalanceQueryDto {
  /** Inclusive; default today. */
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @IsOptional()
  @IsIn(['csv', 'pdf'])
  format?: 'csv' | 'pdf';
}
