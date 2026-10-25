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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { voucherView } from '../vouchers/voucher-view.js';
import { AllocationService } from '../allocations/allocation.service.js';
import { CASH_RECEIPT_ENTITY_TYPE } from './schemas/cash-receipt.schema.js';

/**
 * Every route needs a cash-receipts permission; every write takes its actor
 * from the authenticated user, never from the body. "own"-scoped users only
 * ever see their own receipts (others are 404). Line balances need balances:view.
 */
@Controller('cash-receipts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CashReceiptController {
  constructor(
    private readonly cashReceiptService: CashReceiptService,
    private readonly printService: CashReceiptPrintService,
    private readonly allocationService: AllocationService,
  ) {}

  @Get()
  @RequirePermission(Permission.CASH_RECEIPTS_READ)
  findAll(@Query() query: CashReceiptQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashReceiptService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.CASH_RECEIPTS_READ)
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const voucher = await this.cashReceiptService.findById(id, user);
    const view = voucherView(voucher, user);
    // Active allocations per line: the edit form sends them back, or saving the lines drops them.
    return {
      ...(view === voucher ? voucher.toJSON() : view),
      allocations: await this.allocationService.forPayment(CASH_RECEIPT_ENTITY_TYPE, voucher._id),
    };
  }

  /**
   * The voucher as an A4 PDF, shown inline. Every call is a print: it is
   * audited, and every copy after the first is marked DUPLICATE.
   */
  @Get(':id/pdf')
  @RequirePermission(Permission.CASH_RECEIPTS_READ)
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
  @RequirePermission(Permission.CASH_RECEIPTS_CREATE)
  async create(@Body() dto: CreateCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashReceiptService.create(dto, user), user);
  }

  @Patch(':id')
  @RequirePermission(Permission.CASH_RECEIPTS_EDIT)
  async update(@Param('id') id: string, @Body() dto: UpdateCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashReceiptService.update(id, dto, user), user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.CASH_RECEIPTS_CANCEL)
  async cancel(@Param('id') id: string, @Body() dto: CancelCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashReceiptService.cancel(id, dto, user), user);
  }

  /** multipart/form-data `file`: a cheque photo or transfer slip (PDF or image). */
  @Post(':id/attachments')
  @RequirePermission(Permission.CASH_RECEIPTS_CREATE)
  @UseInterceptors(FileInterceptor('file'))
  async addAttachment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return voucherView(await this.cashReceiptService.addAttachment(id, file, user), user);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermission(Permission.CASH_RECEIPTS_EDIT)
  async removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return voucherView(await this.cashReceiptService.removeAttachment(id, attachmentId, user), user);
  }

  /** Hard delete (reverses the posting). Kept from before cancellation existed; needs the cancel permission. */
  @Delete(':id')
  @RequirePermission(Permission.CASH_RECEIPTS_CANCEL)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.cashReceiptService.remove(id, user);
  }
}
