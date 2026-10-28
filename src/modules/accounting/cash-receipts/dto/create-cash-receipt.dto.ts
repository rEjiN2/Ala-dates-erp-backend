import { OmitType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsMongoId, IsOptional, ValidateIf, ValidateNested } from 'class-validator';
import { VoucherFieldsDto, VoucherLineDto } from '../../vouchers/dto/voucher.dto.js';
import { PaymentMethod } from '../../vouchers/schemas/voucher.schema.js';
import { ReceiptKind } from '../schemas/cash-receipt.schema.js';
import { AllocationTargetDto } from '../../allocations/dto/allocation.dto.js';

/** A receipt line, optionally applied to the customer's bills; any remainder stays on account. */
export class CashReceiptLineDto extends VoucherLineDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationTargetDto)
  allocations?: AllocationTargetDto[];
}

export class CreateCashReceiptDto extends OmitType(VoucherFieldsDto, ['lines'] as const) {
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

  /** reference: own CRV- series, VAT must be 0. Default standard; fixed once created. */
  @IsOptional()
  @IsEnum(ReceiptKind)
  receiptKind?: ReceiptKind;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CashReceiptLineDto)
  lines: CashReceiptLineDto[];
}
