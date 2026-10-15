import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateLedgerAccountDto } from './create-ledger-account.dto.js';

/** `type` is fixed at create; sending it here is rejected by the global pipe. */
export class UpdateLedgerAccountDto extends PartialType(OmitType(CreateLedgerAccountDto, ['type'] as const)) {}
