import { IsEnum, IsInt, IsMongoId, IsNumber, IsPositive, IsString, Min } from 'class-validator';
import { CancelVoucherDto } from '../../vouchers/dto/voucher.dto.js';
import { AllocationTargetType } from '../schemas/allocation.schema.js';

/** A bill and how much of the payment line goes to it. */
export class AllocationTargetDto {
  @IsEnum(AllocationTargetType)
  targetType: AllocationTargetType;

  @IsMongoId()
  targetId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;
}

/** Applies (part of) an existing on-account payment line to a bill. */
export class CreateAllocationDto extends AllocationTargetDto {
  /** e.g. "cash-payment". */
  @IsString()
  paymentVoucherType: string;

  @IsMongoId()
  paymentVoucherId: string;

  /** 0-based line position on the payment. */
  @IsInt()
  @Min(0)
  paymentLineIndex: number;
}

export class ReverseAllocationDto extends CancelVoucherDto {}
