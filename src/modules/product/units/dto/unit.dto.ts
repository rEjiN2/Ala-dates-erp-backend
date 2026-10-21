import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateUnitDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  symbol: string;
}

export class UpdateUnitDto extends PartialType(CreateUnitDto) {}
