import { PartialType } from '@nestjs/mapped-types';
import { CreateCashReceiptDto } from './create-cash-receipt.dto.js';

export class UpdateCashReceiptDto extends PartialType(CreateCashReceiptDto) {}
