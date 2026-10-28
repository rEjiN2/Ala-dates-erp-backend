import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsMongoId, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * PUT body: the whole profile. An optional field that is omitted, null or
 * blank is cleared; currencyCode falls back to AED.
 */
export class UpdateCompanySettingsDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  tradeName?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  addressLine1?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(200)
  addressLine2?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  country?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Matches(/^\+?[0-9 ()-]{5,20}$/, { message: 'phone must be a phone number' })
  phone?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsEmail()
  @MaxLength(200)
  email?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsUrl({ require_protocol: false })
  @MaxLength(200)
  website?: string | null;

  /** UAE TRN: exactly 15 digits when provided. */
  @IsOptional()
  @Transform(trimToNull)
  @Matches(/^\d{15}$/, { message: 'trn must be exactly 15 digits' })
  trn?: string | null;

  /** Id returned by POST /files/upload (a PNG or JPEG image). */
  @IsOptional()
  @IsMongoId()
  logoFileRef?: string | null;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be a 3-letter ISO 4217 code' })
  currencyCode?: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  receiptFooterText?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  referenceReceiptHeaderText?: string | null;

  /** Omitted means off, like every other field of this PUT. */
  @IsOptional()
  @IsBoolean()
  allowSelfApproval?: boolean;

  /** Omitted means off: stock may not go below zero. */
  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean;

  /** Active cash or wallet account; the default "received into" for cash handed over. */
  @IsOptional()
  @IsMongoId()
  defaultCashInHandAccountId?: string | null;

  /** Active cheque account; the default "received into" for cheques handed over. */
  @IsOptional()
  @IsMongoId()
  defaultChequesInHandAccountId?: string | null;

  /** Active cash or wallet account; pays handover expense claims (paidFrom petty_cash). */
  @IsOptional()
  @IsMongoId()
  defaultPettyCashAccountId?: string | null;
}
