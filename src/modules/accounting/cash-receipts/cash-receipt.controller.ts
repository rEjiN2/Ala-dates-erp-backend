import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CashReceiptService } from './cash-receipt.service.js';
import { CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';

@Controller('cash-receipts')
@UseGuards(JwtAuthGuard)
export class CashReceiptController {
  constructor(private readonly cashReceiptService: CashReceiptService) {}

  @Get()
  findAll(@Query() query: CashReceiptQueryDto) {
    return this.cashReceiptService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cashReceiptService.findById(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission('cash-receipts:manage')
  create(@Body() dto: CreateCashReceiptDto) {
    return this.cashReceiptService.create(dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission('cash-receipts:manage')
  update(@Param('id') id: string, @Body() dto: UpdateCashReceiptDto) {
    return this.cashReceiptService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission('cash-receipts:manage')
  remove(@Param('id') id: string) {
    return this.cashReceiptService.remove(id);
  }
}
