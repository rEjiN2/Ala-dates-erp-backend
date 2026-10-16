import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { CompanyService } from './company.service.js';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto.js';

@Controller('company')
@UseGuards(JwtAuthGuard)
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  get() {
    return this.companyService.get();
  }

  @Put()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.COMPANY_MANAGE)
  update(@Body() dto: UpdateCompanySettingsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.companyService.update(dto, user);
  }
}
