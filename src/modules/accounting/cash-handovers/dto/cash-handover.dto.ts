import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CancelVoucherDto, VoucherQueryDto } from '../../vouchers/dto/voucher.dto.js';

const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const HANDOVER_STATUSES = ['submitted', 'approved', 'rejected', 'cancelled'] as const;

/** Submit. No number, totals or who/when: the server sets them; expectedCash and bankTotal come from the receipts. */
export class CreateCashHandoverDto {
  @IsDateString()
  voucherDate: string;

  /**
   * Staff (cashier record) handing over; must settle with the office.
   * Required, except for an "own"-scoped user: their linked staff is used (any other is 403).
   */
  @IsOptional()
  @IsMongoId()
  staffId?: string;

  /** Active cash or wallet account the cash receipts were received into. */
  @IsMongoId()
  sourceAccountId: string;

  /** That staff member's unsettled receipts. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsMongoId({ each: true })
  receiptIds: string[];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  countedCash: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ApproveCashHandoverDto {
  /** Equal to expectedCash, or less with varianceReason; more is rejected. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  receivedCash: number;

  /** Active cash, wallet or bank account; not the source account. */
  @IsMongoId()
  receivedIntoAccountId: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  varianceReason?: string | null;
}

export class RejectCashHandoverDto extends CancelVoucherDto {}

export class CancelCashHandoverDto extends CancelVoucherDto {}

/** Shared voucher filters; cashierId there is the staff member, like staffId. */
export class CashHandoverQueryDto extends VoucherQueryDto {
  @IsOptional()
  @IsMongoId()
  sourceAccountId?: string;

  @IsOptional()
  @IsMongoId()
  staffId?: string;

  @IsOptional()
  @IsIn(HANDOVER_STATUSES)
  handoverStatus?: (typeof HANDOVER_STATUSES)[number];
}

export class UnsettledReceiptsQueryDto {
  /** Required unless "own"-scoped (their linked staff is used). */
  @IsOptional()
  @IsMongoId()
  staffId?: string;
}
