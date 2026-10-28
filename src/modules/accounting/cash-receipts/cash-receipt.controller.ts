import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceiptPrintService } from './cash-receipt-print.service.js';
import { CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { CancelCashReceiptDto, UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';
import { voucherView } from '../vouchers/voucher-view.js';
import { AllocationService } from '../allocations/allocation.service.js';
import { CASH_RECEIPT_ENTITY_TYPE, ReceiptKind } from './schemas/cash-receipt.schema.js';

/** [standard, reference] permission for each action. */
const KIND_PERMISSIONS = {
  read: [Permission.CASH_RECEIPTS_READ, Permission.REFERENCE_RECEIPTS_READ],
  create: [Permission.CASH_RECEIPTS_CREATE, Permission.REFERENCE_RECEIPTS_CREATE],
  edit: [Permission.CASH_RECEIPTS_EDIT, Permission.REFERENCE_RECEIPTS_EDIT],
  cancel: [Permission.CASH_RECEIPTS_CANCEL, Permission.REFERENCE_RECEIPTS_CANCEL],
} as const;

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

  /**
   * Standard receipts need cash-receipts:<action>, reference receipts
   * reference-receipts:<action>; the kind comes from the body, the query or
   * the stored receipt, so there is no static @RequirePermission here.
   */
  private async authorize(user: AuthenticatedUser, action: 'read' | 'create' | 'edit' | 'cancel', id?: string, kind?: ReceiptKind) {
    const [standard, reference] = KIND_PERMISSIONS[action].map((permission) => hasPermission(user, permission));
    if (!standard && !reference) throw new ForbiddenException('Insufficient permissions');
    if (standard && reference) return;
    const target = kind ?? (id ? (await this.cashReceiptService.findById(id, user)).receiptKind : ReceiptKind.STANDARD);
    if (!(target === ReceiptKind.REFERENCE ? reference : standard)) throw new ForbiddenException('Insufficient permissions');
  }

  @Get()
  async findAll(@Query() query: CashReceiptQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const kind = query.kind ?? ReceiptKind.STANDARD;
    if (kind === 'all') {
      const [standard, reference] = KIND_PERMISSIONS.read.map((permission) => hasPermission(user, permission));
      if (!standard && !reference) throw new ForbiddenException('Insufficient permissions');
      query = { ...query, kind: standard && reference ? 'all' : standard ? ReceiptKind.STANDARD : ReceiptKind.REFERENCE };
    } else {
      await this.authorize(user, 'read', undefined, kind);
    }
    return this.cashReceiptService.findAll(query, user);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.authorize(user, 'read', id);
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
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    await this.authorize(user, 'read', id);
    const printed = await this.printService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  async create(@Body() dto: CreateCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    await this.authorize(user, 'create', undefined, dto.receiptKind ?? ReceiptKind.STANDARD);
    return voucherView(await this.cashReceiptService.create(dto, user), user);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    await this.authorize(user, 'edit', id);
    return voucherView(await this.cashReceiptService.update(id, dto, user), user);
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() dto: CancelCashReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    await this.authorize(user, 'cancel', id);
    return voucherView(await this.cashReceiptService.cancel(id, dto, user), user);
  }

  /** multipart/form-data `file`: a cheque photo or transfer slip (PDF or image). */
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async addAttachment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorize(user, 'create', id);
    return voucherView(await this.cashReceiptService.addAttachment(id, file, user), user);
  }

  @Delete(':id/attachments/:attachmentId')
  async removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorize(user, 'edit', id);
    return voucherView(await this.cashReceiptService.removeAttachment(id, attachmentId, user), user);
  }

  /** Hard delete (reverses the posting). Kept from before cancellation existed; needs the cancel permission. */
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.authorize(user, 'cancel', id);
    return this.cashReceiptService.remove(id, user);
  }
}
