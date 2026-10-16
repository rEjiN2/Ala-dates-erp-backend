import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ALL_PERMISSIONS, DataScope, type Permission } from '../permissions.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export class CreateRoleDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  /** Values of the Permission constant only (GET /roles/permissions lists them). */
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions: Permission[];

  @IsEnum(DataScope)
  dataScope: DataScope;
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}
