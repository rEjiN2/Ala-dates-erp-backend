import { IsEnum, IsIn, IsMongoId, IsOptional } from 'class-validator';
import { ReceiptKind } from '../schemas/cash-receipt.schema.js';
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

  /** Default standard, so the Receipts list is unchanged. */
  @IsOptional()
  @IsIn([...Object.values(ReceiptKind), 'all'])
  kind?: ReceiptKind | 'all';

  @IsOptional()
  @IsEnum(ChequeStatus)
  chequeStatus?: ChequeStatus;
}
