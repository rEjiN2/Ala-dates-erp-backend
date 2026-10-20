import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CashierStatus, StaffType } from '../schemas/cashier.schema.js';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Query strings arrive as text; implicit conversion would read "false" as true, so parse the raw text. */
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj[key];
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return raw;
};

// No `code`: it is generated server-side, and the global pipe
// (forbidNonWhitelisted) rejects a client that sends one.
export class CreateCashierDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Matches(/^\+?[0-9 ()-]{5,20}$/, { message: 'mobile must be a phone number' })
  mobile?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsEmail()
  @MaxLength(200)
  email?: string | null;

  @IsOptional()
  @IsEnum(CashierStatus)
  status?: CashierStatus;

  /** Defaults to "cashier". */
  @IsOptional()
  @IsEnum(StaffType)
  staffType?: StaffType;

  /** Defaults to true for a van salesman, otherwise false. */
  @IsOptional()
  @IsBoolean()
  settlesWithOffice?: boolean;

  @IsOptional()
  @IsMongoId()
  linkedUserId?: string | null;

  @IsOptional()
  @IsMongoId()
  locationId?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

/** Any subset; null clears an optional field. Set status "inactive" to deactivate. */
export class UpdateCashierDto extends PartialType(CreateCashierDto) {}

export class CashierQueryDto {
  /** Case-insensitive match on code, name, mobile or email. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(CashierStatus)
  status?: CashierStatus;

  @IsOptional()
  @IsEnum(StaffType)
  staffType?: StaffType;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  settlesWithOffice?: boolean;

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

export class CashierLookupQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Defaults to true. Implicit conversion would read "false" as true, so parse the text. */
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    const raw = obj.activeOnly;
    if (raw === undefined || raw === '') return true;
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return raw;
  })
  @IsBoolean()
  activeOnly: boolean = true;

  @IsOptional()
  @IsEnum(StaffType)
  staffType?: StaffType;

  /** e.g. true for the "Handed by" dropdown on a handover. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  settlesWithOffice?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
