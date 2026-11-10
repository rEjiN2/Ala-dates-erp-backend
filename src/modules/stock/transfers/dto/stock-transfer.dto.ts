import { IntersectionType, PartialType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, ChangeNoteFieldDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';
import { PendingReceiptStatus } from '../../pending-receipt.js';

export class StockTransferLineDto {
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;
}

export class CreateStockTransferDto {
  /** Not in the future. */
  @IsDateString()
  date: string;

  /** An active warehouse, store or van; not the destination. */
  @IsMongoId()
  fromLocationId: string;

  @IsMongoId()
  toLocationId: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockTransferLineDto)
  lines: StockTransferLineDto[];
}

export class UpdateStockTransferDto extends IntersectionType(PartialType(CreateStockTransferDto), ChangeNoteFieldDto) {}

export class ReceiveLineDto {
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  receivedQty: number;
}

export class ReceiveStockTransferDto {
  /** Omitted lines are received in full; omit all to receive everything. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines?: ReceiveLineDto[];

  /** Required when anything is short. */
  @IsOptional()
  @IsString()
  shortfallReason?: string;
}

export class CancelStockTransferDto extends CancelVoucherDto {}

export class StockTransferQueryDto extends PickType(VoucherQueryDto, ['dateFrom', 'dateTo', 'q', 'page', 'pageSize'] as const) {
  @IsOptional()
  @IsIn(Object.values(PendingReceiptStatus))
  status?: PendingReceiptStatus;

  @IsOptional()
  @IsMongoId()
  fromLocationId?: string;

  @IsOptional()
  @IsMongoId()
  toLocationId?: string;

  @IsOptional()
  @IsMongoId()
  productId?: string;
}
