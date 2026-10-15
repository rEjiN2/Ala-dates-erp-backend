import { IsBoolean, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class BankDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  swiftCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  branchCode?: string;

  /** Must be an expense account; checked by the service. */
  @IsOptional()
  @IsMongoId()
  bankChargeAccountId?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  commissionPercent?: number;

  @IsOptional()
  @IsBoolean()
  isMerchantAccount?: boolean;
}
