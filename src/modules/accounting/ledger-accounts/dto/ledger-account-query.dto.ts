import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LedgerAccountStatus, LedgerAccountType } from '../schemas/ledger-account.schema.js';

export class LedgerAccountQueryDto {
  /** Case-insensitive match on code, legacy code or name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(LedgerAccountType)
  type?: LedgerAccountType;

  @IsOptional()
  @IsEnum(LedgerAccountStatus)
  status?: LedgerAccountStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** `?types=cash,bank` and `?types=cash&types=bank` are both accepted. */
function toTypeList({ obj }: { obj: Record<string, unknown> }): unknown {
  const raw = obj.types;
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(parts)) {
    return parts;
  }
  return parts
    .flatMap((part) => String(part).split(','))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export class LedgerAccountLookupQueryDto {
  @IsOptional()
  @Transform(toTypeList)
  @IsEnum(LedgerAccountType, { each: true })
  types?: LedgerAccountType[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
