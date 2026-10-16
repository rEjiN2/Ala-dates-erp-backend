import { IntersectionType, PartialType } from '@nestjs/mapped-types';
import { CreateCashReceiptDto } from './create-cash-receipt.dto.js';
import { CancelVoucherDto, ChangeNoteFieldDto } from '../../vouchers/dto/voucher.dto.js';

export { CANCEL_REASON_MIN_LENGTH } from '../../vouchers/dto/voucher.dto.js';

export class UpdateCashReceiptDto extends IntersectionType(PartialType(CreateCashReceiptDto), ChangeNoteFieldDto) {}

export class CancelCashReceiptDto extends CancelVoucherDto {}
