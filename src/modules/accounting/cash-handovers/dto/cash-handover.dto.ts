import { IntersectionType, PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherQueryDto } from '../../vouchers/dto/voucher.dto.js';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** No number, totals, method or who/when: the server sets them. */
export class CreateCashHandoverDto {
  @IsDateString()
  voucherDate: string;

  /** Active cash, wallet or bank account the money leaves (credited). */
  @IsMongoId()
  fromAccountId: string;

  /** Active cash, wallet or bank account the money arrives in (debited); not the from account. */
  @IsMongoId()
  toAccountId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  /**
   * Active cashier handing the money over. Required, except for an
   * "own"-scoped user: their linked cashier is used (any other is 403).
   */
  @IsOptional()
  @IsMongoId()
  handedByCashierId?: string;

  /** Active cashier receiving it; not the one handing over. */
  @IsMongoId()
  receivedByCashierId: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  reference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** Confirms the warnings returned by a previous attempt (the from account going below zero). */
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;
}

export class UpdateCashHandoverDto extends IntersectionType(PartialType(CreateCashHandoverDto), ChangeNoteFieldDto) {}

export class CancelCashHandoverDto extends CancelVoucherDto {}

/** Shared voucher filters; cashierId there is the handing-over cashier, accountId the "to" account. */
export class CashHandoverQueryDto extends VoucherQueryDto {
  @IsOptional()
  @IsMongoId()
  fromAccountId?: string;

  @IsOptional()
  @IsMongoId()
  toAccountId?: string;

  @IsOptional()
  @IsMongoId()
  handedByCashierId?: string;

  @IsOptional()
  @IsMongoId()
  receivedByCashierId?: string;
}
