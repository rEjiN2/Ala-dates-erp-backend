import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { LedgerAccountStatus, LedgerAccountType } from '../schemas/ledger-account.schema.js';
import { MANAGEABLE_ACCOUNT_TYPES } from '../ledger-account-code.js';
import { BankDetailsDto } from './bank-details.dto.js';

// Deliberately absent, so the global pipe (forbidNonWhitelisted) rejects them:
// `code` (generated), `balance` / any opening balance (moved only by postings).
export class CreateLedgerAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  /** party/supplier are excluded: those accounts belong to the Parties module. */
  @IsIn(MANAGEABLE_ACCOUNT_TYPES, {
    message: `type must be one of: ${MANAGEABLE_ACCOUNT_TYPES.join(', ')} (party and supplier accounts are managed by the Parties module)`,
  })
  type: LedgerAccountType;

  /** Cash accounts only. */
  @IsOptional()
  @IsMongoId()
  locationId?: string | null;

  /** Bank accounts only. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BankDetailsDto)
  bankDetails?: BankDetailsDto | null;

  @IsOptional()
  @IsEnum(LedgerAccountStatus)
  status?: LedgerAccountStatus;
}
