import {
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const CASH_RECEIPT_STATUS_FILTERS = ['posted', 'cancelled', 'all'] as const;
export const CASH_RECEIPT_SORT_FIELDS = ['date', 'amount', 'voucherNo'] as const;

export class CashReceiptQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /** A date-only value covers the whole day. */
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsIn(CASH_RECEIPT_STATUS_FILTERS)
  status?: (typeof CASH_RECEIPT_STATUS_FILTERS)[number];

  @IsOptional()
  @IsMongoId()
  cashAccountId?: string;

  /** Matches receipts with any line posted to this account. */
  @IsOptional()
  @IsMongoId()
  accountId?: string;

  @IsOptional()
  @IsMongoId()
  cashierId?: string;

  /** User id of the creator. */
  @IsOptional()
  @IsMongoId()
  createdBy?: string;

  /** Bounds on grandTotal, inclusive. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  amountMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amountMax?: number;

  /** Case-insensitive match on voucher number, comments or any line narration. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(CASH_RECEIPT_SORT_FIELDS)
  sortBy?: (typeof CASH_RECEIPT_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

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
