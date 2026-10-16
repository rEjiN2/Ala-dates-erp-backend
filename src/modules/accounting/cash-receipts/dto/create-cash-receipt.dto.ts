import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Trims strings and turns a blank one into null, so "" clears an optional field. */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

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
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  vat?: number;
}

export class CreateCashReceiptDto {
  @IsDateString()
  voucherDate: string;

  /**
   * The account the money is received into: an active cash, wallet or bank
   * account (the name is kept from when only cash was allowed). It may not
   * also appear as a line account.
   */
  @IsMongoId()
  cashAccountId: string;

  /** Cheque number, transfer reference, etc. */
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(100)
  paymentReference?: string | null;

  /** Must be an active cashier when the receipt is saved. */
  @IsMongoId()
  cashierId: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CashReceiptLineDto)
  lines: CashReceiptLineDto[];
}
