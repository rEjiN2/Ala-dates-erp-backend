import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
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
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto } from '../../vouchers/dto/voucher.dto.js';

const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const HANDOVER_STATUSES = ['submitted', 'approved', 'rejected', 'cancelled'] as const;

export class HandoverLineDto {
  /** One of the user's own cash, wallet or cheque accounts. */
  @IsMongoId()
  sourceAccountId: string;

  /** At most the account's balance minus what is already on their other submitted handovers. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;
}

/** Spent out of the collected cash; its bill is attached after submitting. */
export class HandoverExpenseDto {
  /** An active expense account. */
  @IsMongoId()
  expenseAccountId: string;

  /** The user's cash or wallet account it was paid from. */
  @IsMongoId()
  sourceAccountId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  description?: string | null;
}

/** Submit. No number, totals or who/when: the server sets them. */
export class CreateCashHandoverDto {
  /** Defaults to today. */
  @IsOptional()
  @IsDateString()
  voucherDate?: string;

  /** Whose money; defaults to the caller. Anyone else needs vouchers:select-collector. */
  @IsOptional()
  @IsMongoId()
  userId?: string;

  /** Amounts from the user's own accounts; may be empty when cheques are handed over. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HandoverLineDto)
  lines: HandoverLineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HandoverExpenseDto)
  expenses?: HandoverExpenseDto[];

  /** Bank-transfer receipts (with_salesman, collected by this user) handed over for verification. */
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  bankReceiptIds?: string[];

  /** Receipts whose cheques (with_salesman, collected by this user) are handed over. */
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  chequeIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ApproveHandoverLineDto {
  @IsMongoId()
  sourceAccountId: string;

  /** Defaults to the submitted amount; never more. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  receivedAmount?: number;

  /** Defaults to the company's cash in hand (cash/wallet sources) or cheques in hand (cheque sources). */
  @IsOptional()
  @IsMongoId()
  receivedIntoAccountId?: string;
}

export class ApproveCashHandoverDto {
  /** Per source account; sources left out are received in full into their default account. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApproveHandoverLineDto)
  lines?: ApproveHandoverLineDto[];

  /** Required when anything is received short. */
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class RejectCashHandoverDto extends CancelVoucherDto {}

export class CancelCashHandoverDto extends CancelVoucherDto {}

export class CashHandoverQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsIn(HANDOVER_STATUSES)
  status?: (typeof HANDOVER_STATUSES)[number];

  @IsOptional()
  @IsMongoId()
  userId?: string;

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

export class PendingQueryDto {
  /** Defaults to the caller; anyone else needs vouchers:select-collector. */
  @IsOptional()
  @IsMongoId()
  userId?: string;
}
