import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { StockTransferService } from './stock-transfer.service.js';
import {
  CancelStockTransferDto,
  CreateStockTransferDto,
  ReceiveStockTransferDto,
  StockTransferQueryDto,
  UpdateStockTransferDto,
} from './dto/stock-transfer.dto.js';

/** Every route needs a stock-transfers permission; the actor always comes from the token. Edit needs :create and being the sender (or admin). */
@Controller('stock-transfers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StockTransferController {
  constructor(private readonly stockTransferService: StockTransferService) {}

  @Get()
  @RequirePermission(Permission.STOCK_TRANSFERS_READ)
  findAll(@Query() query: StockTransferQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.findAll(query, user);
  }

  @Get('to-receive-count')
  @RequirePermission(Permission.STOCK_TRANSFERS_READ)
  toReceiveCount(@CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.toReceiveCount(user);
  }

  @Get(':id')
  @RequirePermission(Permission.STOCK_TRANSFERS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.findById(id, user);
  }

  /** STOCK TRANSFER NOTE as an A4 PDF. Every call is a print: it is audited. */
  @Get(':id/pdf')
  @RequirePermission(Permission.STOCK_TRANSFERS_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Query('size') size?: string) {
    const printed = await this.stockTransferService.pdf(id, user, size);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @RequirePermission(Permission.STOCK_TRANSFERS_CREATE)
  create(@Body() dto: CreateStockTransferDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission(Permission.STOCK_TRANSFERS_CREATE)
  update(@Param('id') id: string, @Body() dto: UpdateStockTransferDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.update(id, dto, user);
  }

  @Post(':id/receive')
  @RequirePermission(Permission.STOCK_TRANSFERS_RECEIVE)
  receive(@Param('id') id: string, @Body() dto: ReceiveStockTransferDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.receive(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.STOCK_TRANSFERS_CANCEL)
  cancel(@Param('id') id: string, @Body() dto: CancelStockTransferDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockTransferService.cancel(id, dto, user);
  }
}
