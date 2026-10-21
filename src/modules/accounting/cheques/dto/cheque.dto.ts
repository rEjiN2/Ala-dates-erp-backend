import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ChequeStatus } from '../../vouchers/schemas/voucher.schema.js';
import { CANCEL_REASON_MIN_LENGTH } from '../../vouchers/dto/voucher.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class DepositChequeDto {
  /** Active bank account the cheque is taken to. */
  @IsMongoId()
  bankAccountId: string;

  /** Not before the cheque date. */
  @IsDateString()
  date: string;
}

export class ClearChequeDto {
  /** On or after the cheque date, and not in the future. */
  @IsDateString()
  date: string;

  /** Active bank, cash or wallet account; defaults to the bank it was deposited in. */
  @IsOptional()
  @IsMongoId()
  destinationAccountId?: string;
}

export class ReturnChequeDto {
  @IsDateString()
  date: string;

  @Transform(trim)
  @IsString()
  @MinLength(CANCEL_REASON_MIN_LENGTH)
  @MaxLength(500)
  reason: string;
}

export class UndoChequeDto {
  @Transform(trim)
  @IsString()
  @MinLength(CANCEL_REASON_MIN_LENGTH)
  @MaxLength(500)
  reason: string;
}

export class ChequeQueryDto {
  @IsOptional()
  @IsEnum(ChequeStatus)
  status?: ChequeStatus;

  /** Cheque date range (inclusive). */
  @IsOptional()
  @IsDateString()
  dueFrom?: string;

  @IsOptional()
  @IsDateString()
  dueTo?: string;

  /** Customer (or any line) ledger account. */
  @IsOptional()
  @IsMongoId()
  customerId?: string;

  /** Case-insensitive match on the bank the cheque is drawn on. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bank?: string;

  @IsOptional()
  @IsMongoId()
  collectedBy?: string;

  /** Cheque number, bank or receipt number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

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
