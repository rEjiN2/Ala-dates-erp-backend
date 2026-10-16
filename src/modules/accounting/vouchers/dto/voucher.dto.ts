import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '../schemas/voucher.schema.js';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class VoucherLineDto {
  @IsMongoId()
  accountId: string;

  @IsOptional()
  @IsString()
  narration?: string;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  vat?: number;
}

/**
 * Body fields every cash/bank voucher shares. Each voucher's create DTO adds
 * its own header account field. Totals, numbers, who/when and the payment
 * method are never accepted: the server sets them.
 */
export class VoucherFieldsDto {
  @IsDateString()
  voucherDate: string;

  /** Cheque number, transfer reference, etc. */
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  paymentReference?: string | null;

  /**
   * Must be an active cashier when the voucher is saved. Required, except for
   * an "own"-scoped user: their linked cashier is used (any other is 403).
   */
  @IsOptional()
  @IsMongoId()
  cashierId?: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VoucherLineDto)
  lines: VoucherLineDto[];
}

/** Optional on every voucher edit. */
export class ChangeNoteFieldDto {
  /** Why the edit was made; stored as the audit entry's reason. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  changeNote?: string;
}

export const CANCEL_REASON_MIN_LENGTH = 3;

export class CancelVoucherDto {
  @Transform(trim)
  @IsString()
  @MinLength(CANCEL_REASON_MIN_LENGTH)
  @MaxLength(500)
  reason: string;
}

export const VOUCHER_STATUS_FILTERS = ['posted', 'cancelled', 'all'] as const;
export const VOUCHER_SORT_FIELDS = ['date', 'amount', 'voucherNo'] as const;

/** List filters every voucher shares; each voucher's query DTO adds its header account filter. */
export class VoucherQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /** A date-only value covers the whole day. */
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsIn(VOUCHER_STATUS_FILTERS)
  status?: (typeof VOUCHER_STATUS_FILTERS)[number];

  /** Matches vouchers with any line posted to this account. */
  @IsOptional()
  @IsMongoId()
  accountId?: string;

  @IsOptional()
  @IsMongoId()
  cashierId?: string;

  /** cash or bank. Vouchers from before bank support have no method and count as cash. */
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

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

  /** Case-insensitive match on voucher number, comments, any line narration or the payment reference. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(VOUCHER_SORT_FIELDS)
  sortBy?: (typeof VOUCHER_SORT_FIELDS)[number];

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
