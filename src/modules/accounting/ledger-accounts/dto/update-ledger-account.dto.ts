import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsMongoId, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { CreateLedgerAccountDto } from './create-ledger-account.dto.js';

/** `type` is fixed at create; sending it here is rejected by the global pipe. */
export class UpdateLedgerAccountDto extends PartialType(OmitType(CreateLedgerAccountDto, ['type', 'holderUserId'] as const)) {}

/** Moves a cash account to another user (or to nobody with null). */
export class ChangeHolderDto {
  @IsMongoId()
  @ValidateIf((_o, value) => value !== null)
  holderUserId: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
