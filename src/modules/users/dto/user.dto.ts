import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PASSWORD_MIN_LENGTH, UserStatus } from '../schemas/user.schema.js';
import { CollectorPurpose } from '../users.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const PASSWORD_MAX_LENGTH = 128;

export class CreateUserDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Transform(trimLower)
  @IsEmail()
  @MaxLength(200)
  email: string;

  /** The first password; the user must change it at first login. */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @IsMongoId()
  roleId: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Active cash or wallet accounts an "own"-scoped user may receive money into. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  allowedCashAccountIds?: string[];

  /** Locations an "own"-scoped user sees stock for. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  allowedLocationIds?: string[];

  /** Hands collected cash to the office on cash handovers (van salesmen). */
  @IsOptional()
  @IsBoolean()
  settlesWithOffice?: boolean;

  /** Where the user is based; null clears it. */
  @IsOptional()
  @IsMongoId()
  locationId?: string | null;
}

/** Any subset. The password is changed only through reset-password. Set status "inactive" to deactivate. */
export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['password'] as const)) {}

export class ResetPasswordDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class UserQueryDto {
  /** Case-insensitive match on name or email. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsMongoId()
  roleId?: string;

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

export class UserLookupQueryDto {
  /** Only users who can be put on this voucher type as Collected By / Paid By. */
  @IsOptional()
  @IsEnum(CollectorPurpose)
  for?: CollectorPurpose;
}
