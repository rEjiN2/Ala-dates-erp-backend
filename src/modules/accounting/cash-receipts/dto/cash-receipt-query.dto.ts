import { IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { VoucherQueryDto } from '../../vouchers/dto/voucher.dto.js';
import { ChequeStatus } from '../../vouchers/schemas/voucher.schema.js';

export {
  VOUCHER_SORT_FIELDS as CASH_RECEIPT_SORT_FIELDS,
  VOUCHER_STATUS_FILTERS as CASH_RECEIPT_STATUS_FILTERS,
} from '../../vouchers/dto/voucher.dto.js';

export class CashReceiptQueryDto extends VoucherQueryDto {
  /** The "received into" account. */
  @IsOptional()
  @IsMongoId()
  cashAccountId?: string;

  @IsOptional()
  @IsEnum(ChequeStatus)
  chequeStatus?: ChequeStatus;
}
