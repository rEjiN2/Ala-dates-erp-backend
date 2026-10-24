import { IntersectionType, PartialType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherQueryDto } from '../../vouchers/dto/voucher.dto.js';

/** Either debit or credit must be above 0, not both (checked by the service, per row). */
class OpeningBalanceAmountsDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  debit?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  credit?: number;
}

export class OpeningBalanceLineDto extends OpeningBalanceAmountsDto {
  @IsMongoId()
  accountId: string;
}

export class CreateOpeningBalanceDto {
  /** Not in the future. */
  @IsDateString()
  asOfDate: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OpeningBalanceLineDto)
  lines: OpeningBalanceLineDto[];
}

export class UpdateOpeningBalanceDto extends IntersectionType(PartialType(CreateOpeningBalanceDto), ChangeNoteFieldDto) {}

export class CancelOpeningBalanceDto extends CancelVoucherDto {}

export class OpeningBalanceQueryDto extends PickType(VoucherQueryDto, [
  'dateFrom',
  'dateTo',
  'status',
  'accountId',
  'q',
  'page',
  'pageSize',
] as const) {}

export class ValidateOpeningBalanceLineDto extends OpeningBalanceAmountsDto {
  @IsString()
  @MaxLength(50)
  accountCode: string;
}

/** Lines by account code (e.g. an import); nothing is posted. */
export class ValidateOpeningBalanceDto {
  /** When validating an edit: the voucher being edited, so its own accounts are not duplicates. */
  @IsOptional()
  @IsMongoId()
  voucherId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ValidateOpeningBalanceLineDto)
  lines: ValidateOpeningBalanceLineDto[];
}
