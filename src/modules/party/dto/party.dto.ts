import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PartyKind, PartyStatus } from '../schemas/party.schema.js';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** TRN entered loosely ("100-2345-6780-0003", "100 234 567 800 003") is stored as its digits. */
const vatDigits = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const compact = value.replace(/[\s-]/g, '');
  return compact === '' ? null : compact;
};

const PHONE = /^\+?[0-9 ()-]{5,20}$/;

export class ShippingAddressDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(200) address1?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(200) address2?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(200) address3?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) city?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) state?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) country?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(20) postalCode?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @Matches(PHONE, { message: 'telephone must be a phone number' })
  telephone?: string | null;
}

// No `code` and no balance/opening balance: the code is generated, and the
// ledger balance only moves through postings (the opening balance screen
// comes later). The global pipe's forbidNonWhitelisted rejects either.
export class CreatePartyDto {
  @IsEnum(PartyKind)
  kind: PartyKind;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsEnum(PartyStatus)
  status?: PartyStatus;

  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) contactPerson?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @Matches(PHONE, { message: 'telephone must be a phone number' })
  telephone?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @Matches(PHONE, { message: 'mobile must be a phone number' })
  mobile?: string | null;

  @IsOptional() @Transform(trimToNull) @IsEmail() @MaxLength(200) email?: string | null;

  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(200) address1?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(200) address2?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(200) address3?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) city?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) state?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) country?: string | null;
  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(20) postalCode?: string | null;

  /** UAE TRN: 15 digits; spaces and dashes are ignored. */
  @IsOptional()
  @Transform(vatDigits)
  @Matches(/^\d{15}$/, { message: 'vatNumber must be 15 digits' })
  vatNumber?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  creditLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  creditDays?: number | null;

  @IsOptional() @Transform(trimToNull) @IsString() @MaxLength(100) salesman?: string | null;

  /** Customers only. Replaces the whole list on update. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ShippingAddressDto)
  shippingAddresses?: ShippingAddressDto[];
}

/**
 * Any subset; null clears an optional field. `kind` can't be changed (the
 * pipe rejects it) and documents have their own routes. Set status
 * "inactive" to deactivate.
 */
export class UpdatePartyDto extends PartialType(OmitType(CreatePartyDto, ['kind'] as const)) {}

export class PartyQueryDto {
  /** Case-insensitive match on name, code or telephone. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(PartyKind)
  kind?: PartyKind;

  @IsOptional()
  @IsEnum(PartyStatus)
  status?: PartyStatus;

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

export class PartyLookupQueryDto {
  @IsOptional()
  @IsEnum(PartyKind)
  kind?: PartyKind;

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

export class UploadPartyDocumentDto {
  /** Defaults to the file name. */
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  title?: string | null;
}
