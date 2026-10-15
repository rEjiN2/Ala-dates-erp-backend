import { IsDateString, IsMongoId, IsOptional } from 'class-validator';

export class CashReceiptQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsMongoId()
  cashAccountId?: string;
}
