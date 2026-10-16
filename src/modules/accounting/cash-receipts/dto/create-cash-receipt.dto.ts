import { IsMongoId } from 'class-validator';
import { VoucherFieldsDto, VoucherLineDto } from '../../vouchers/dto/voucher.dto.js';

export class CashReceiptLineDto extends VoucherLineDto {}

export class CreateCashReceiptDto extends VoucherFieldsDto {
  /**
   * The account the money is received into: an active cash, wallet or bank
   * account (the name is kept from when only cash was allowed). It may not
   * also appear as a line account.
   */
  @IsMongoId()
  cashAccountId: string;
}
