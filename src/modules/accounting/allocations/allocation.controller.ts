import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { AllocationService } from './allocation.service.js';
import { CreateAllocationDto, ReverseAllocationDto } from './dto/allocation.dto.js';

/**
 * Applying payments to bills. The open-bills and unallocated lists also serve
 * the cash payment and receipt screens, so cash-payments:create or
 * cash-receipts:create is enough to read them.
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AllocationController {
  constructor(private readonly allocationService: AllocationService) {}

  @Get('parties/:id/open-bills')
  openBills(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    assertCanAllocate(user);
    return this.allocationService.openBills(id);
  }

  @Get('parties/:id/unallocated-payments')
  unallocatedPayments(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    assertCanAllocate(user);
    return this.allocationService.unallocatedPayments(id);
  }

  @Post('allocations')
  @RequirePermission(Permission.ALLOCATIONS_MANAGE)
  create(@Body() dto: CreateAllocationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.allocationService.create(dto, user);
  }

  @Post('allocations/:id/reverse')
  @RequirePermission(Permission.ALLOCATIONS_MANAGE)
  reverse(@Param('id') id: string, @Body() dto: ReverseAllocationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.allocationService.reverse(id, dto.reason, user);
  }
}

function assertCanAllocate(user: AuthenticatedUser): void {
  if (
    !hasPermission(user, Permission.ALLOCATIONS_MANAGE) &&
    !hasPermission(user, Permission.CASH_PAYMENTS_CREATE) &&
    !hasPermission(user, Permission.CASH_RECEIPTS_CREATE)
  ) {
    throw new ForbiddenException('You do not have permission to allocate payments');
  }
}
