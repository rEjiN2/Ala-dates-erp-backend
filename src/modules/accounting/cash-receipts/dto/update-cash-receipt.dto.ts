import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateCashReceiptDto } from './create-cash-receipt.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateCashReceiptDto extends PartialType(CreateCashReceiptDto) {
  /** Why the edit was made; stored as the audit entry's reason. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  changeNote?: string;
}

export const CANCEL_REASON_MIN_LENGTH = 3;

export class CancelCashReceiptDto {
  @Transform(trim)
  @IsString()
  @MinLength(CANCEL_REASON_MIN_LENGTH)
  @MaxLength(500)
  reason: string;
}
