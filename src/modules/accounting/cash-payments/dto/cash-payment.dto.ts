import { IntersectionType, OmitType, PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsMongoId, IsOptional, ValidateNested } from 'class-validator';
import {
  CancelVoucherDto,
  ChangeNoteFieldDto,
  VoucherFieldsDto,
  VoucherLineDto,
  VoucherQueryDto,
} from '../../vouchers/dto/voucher.dto.js';
import { AllocationTargetDto } from '../../allocations/dto/allocation.dto.js';

/** Confirms the warnings returned by a previous attempt (e.g. cash going below zero). */
class AcknowledgeWarningsFieldDto {
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;
}

/** A payment line, optionally applied to the party's bills; any remainder stays on account. */
export class CashPaymentLineDto extends VoucherLineDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationTargetDto)
  allocations?: AllocationTargetDto[];
}

export class CreateCashPaymentDto extends IntersectionType(
  OmitType(VoucherFieldsDto, ['lines'] as const),
  AcknowledgeWarningsFieldDto,
) {
  /** The account the money is paid from: an active cash, wallet or bank account, not used on any line. */
  @IsMongoId()
  paidFromAccountId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CashPaymentLineDto)
  lines: CashPaymentLineDto[];
}

/** Sending lines replaces the payment's allocations with the ones on those lines. */
export class UpdateCashPaymentDto extends IntersectionType(PartialType(CreateCashPaymentDto), ChangeNoteFieldDto) {}

export class CancelCashPaymentDto extends CancelVoucherDto {}

export class CashPaymentQueryDto extends VoucherQueryDto {
  /** The "paid from" account. */
  @IsOptional()
  @IsMongoId()
  paidFromAccountId?: string;
}
