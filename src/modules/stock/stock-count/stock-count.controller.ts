import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { StockCountService } from './stock-count.service.js';
import {
  ApproveStockCountDto,
  CancelStockCountDto,
  CreateStockCountDto,
  LoadStockCountDto,
  RejectStockCountDto,
  StockCountQueryDto,
  UpdateStockCountDto,
  ValidateStockCountDto,
} from './dto/stock-count.dto.js';

const asPdf = (printed: { buffer: Buffer; filename: string }) =>
  new StreamableFile(printed.buffer, {
    type: 'application/pdf',
    length: printed.buffer.length,
    disposition: `inline; filename="${printed.filename}"`,
  });

/** Every route needs a stock-counts permission; the actor always comes from the token. */
@Controller('stock-counts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StockCountController {
  constructor(private readonly stockCountService: StockCountService) {}

  @Get()
  @RequirePermission(Permission.STOCK_COUNTS_READ)
  findAll(@Query() query: StockCountQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.findAll(query, user);
  }

  /** Lines by product code, resolved, with per-row errors. Saves nothing. */
  @Post('validate')
  @RequirePermission(Permission.STOCK_COUNTS_CREATE)
  validate(@Body() dto: ValidateStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.validate(dto, user);
  }

  @Get(':id')
  @RequirePermission(Permission.STOCK_COUNTS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.findById(id, user);
  }

  /** STOCK COUNT SHEET (blind) as an A4 PDF. Every call is a print: it is audited. */
  @Get(':id/pdf')
  @RequirePermission(Permission.STOCK_COUNTS_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return asPdf(await this.stockCountService.sheetPdf(id, user));
  }

  /** Adjustment summary of an approved count; needs stock:view-system-qty. */
  @Get(':id/adjustment-pdf')
  @RequirePermission(Permission.STOCK_COUNTS_READ)
  @Header('Cache-Control', 'private, no-store')
  async adjustmentPdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return asPdf(await this.stockCountService.adjustmentPdf(id, user));
  }

  @Post()
  @RequirePermission(Permission.STOCK_COUNTS_CREATE)
  create(@Body() dto: CreateStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission(Permission.STOCK_COUNTS_CREATE)
  update(@Param('id') id: string, @Body() dto: UpdateStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.update(id, dto, user);
  }

  @Post(':id/load')
  @RequirePermission(Permission.STOCK_COUNTS_CREATE)
  load(@Param('id') id: string, @Body() dto: LoadStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.loadProducts(id, dto, user);
  }

  @Post(':id/submit')
  @RequirePermission(Permission.STOCK_COUNTS_CREATE)
  submit(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.submit(id, user);
  }

  @Post(':id/approve')
  @RequirePermission(Permission.STOCK_COUNTS_APPROVE)
  approve(@Param('id') id: string, @Body() dto: ApproveStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.approve(id, dto, user);
  }

  @Post(':id/reject')
  @RequirePermission(Permission.STOCK_COUNTS_APPROVE)
  reject(@Param('id') id: string, @Body() dto: RejectStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.reject(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.STOCK_COUNTS_CANCEL)
  cancel(@Param('id') id: string, @Body() dto: CancelStockCountDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockCountService.cancel(id, dto, user);
  }
}
