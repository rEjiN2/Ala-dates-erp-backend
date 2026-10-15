import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CashReceiptLineDto {
  @IsMongoId()
  accountId: string;

  @IsOptional()
  @IsString()
  narration?: string;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  vat?: number;
}

export class CreateCashReceiptDto {
  @IsDateString()
  voucherDate: string;

  @IsMongoId()
  cashAccountId: string;

  @IsOptional()
  @IsString()
  cashier?: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CashReceiptLineDto)
  lines: CashReceiptLineDto[];
}
