import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceiptPrintService } from './cash-receipt-print.service.js';
import { CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { CancelCashReceiptDto, UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';

/** Every write takes its actor from the authenticated user, never from the body. */
@Controller('cash-receipts')
@UseGuards(JwtAuthGuard)
export class CashReceiptController {
  constructor(
    private readonly cashReceiptService: CashReceiptService,
    private readonly printService: CashReceiptPrintService,
  ) {}

  @Get()
  findAll(@Query() query: CashReceiptQueryDto) {
    return this.cashReceiptService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cashReceiptService.findById(id);
  }

  /**
   * The voucher as an A4 PDF, shown inline. Every call is a print: it is
   * audited, and every copy after the first is marked DUPLICATE.
   */
  @Get(':id/pdf')
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.printService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_RECEIPTS_MANAGE)
  create(@Body() dto: CreateCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashReceiptService.create(dto, user);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_RECEIPTS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashReceiptService.update(id, dto, user);
  }

  @Post(':id/cancel')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_RECEIPTS_MANAGE)
  cancel(@Param('id') id: string, @Body() dto: CancelCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashReceiptService.cancel(id, dto, user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_RECEIPTS_MANAGE)
  remove(@Param('id') id: string) {
    return this.cashReceiptService.remove(id);
  }
}
