import { IntersectionType, PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsMongoId, IsOptional } from 'class-validator';
import {
  CancelVoucherDto,
  ChangeNoteFieldDto,
  VoucherFieldsDto,
  VoucherQueryDto,
} from '../../vouchers/dto/voucher.dto.js';

/** Confirms the warnings returned by a previous attempt (e.g. cash going below zero). */
class AcknowledgeWarningsFieldDto {
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;
}

export class CreateCashPaymentDto extends IntersectionType(VoucherFieldsDto, AcknowledgeWarningsFieldDto) {
  /** The account the money is paid from: an active cash, wallet or bank account, not used on any line. */
  @IsMongoId()
  paidFromAccountId: string;
}

export class UpdateCashPaymentDto extends IntersectionType(PartialType(CreateCashPaymentDto), ChangeNoteFieldDto) {}

export class CancelCashPaymentDto extends CancelVoucherDto {}

export class CashPaymentQueryDto extends VoucherQueryDto {
  /** The "paid from" account. */
  @IsOptional()
  @IsMongoId()
  paidFromAccountId?: string;
}
