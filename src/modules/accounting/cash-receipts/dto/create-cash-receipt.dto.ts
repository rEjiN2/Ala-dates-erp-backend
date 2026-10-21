import { IsEnum, IsMongoId, IsOptional, ValidateIf } from 'class-validator';
import { VoucherFieldsDto, VoucherLineDto } from '../../vouchers/dto/voucher.dto.js';
import { PaymentMethod } from '../../vouchers/schemas/voucher.schema.js';

export class CashReceiptLineDto extends VoucherLineDto {}

export class CreateCashReceiptDto extends VoucherFieldsDto {
  /**
   * The account the money is received into: an active cash, wallet or bank
   * account (the name is kept from when only cash was allowed). It may not
   * also appear as a line account. A cheque may leave it out: it then goes
   * into the company's default cheques in hand account.
   */
  @ValidateIf((dto: CreateCashReceiptDto) => dto.paymentMethod !== PaymentMethod.CHEQUE || dto.cashAccountId !== undefined)
  @IsMongoId()
  cashAccountId?: string;

  /**
   * cash (cash/wallet account), cheque (cheque account) or bank (bank
   * account); must match the account. Omitted: taken from the account.
   */
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;
}
