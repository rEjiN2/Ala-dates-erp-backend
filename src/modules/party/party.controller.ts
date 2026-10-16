import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { PartyService } from './party.service.js';
import {
  CreatePartyDto,
  PartyLookupQueryDto,
  PartyQueryDto,
  UpdatePartyDto,
  UploadPartyDocumentDto,
} from './dto/party.dto.js';

/** Customers and suppliers. Reads for any logged-in user; writes need parties:manage. */
@Controller('parties')
@UseGuards(JwtAuthGuard)
export class PartyController {
  constructor(private readonly partyService: PartyService) {}

  @Get()
  list(@Query() query: PartyQueryDto) {
    return this.partyService.list(query);
  }

  // Declared before ':id' so "lookup" is not captured as an id.
  @Get('lookup')
  lookup(@Query() query: PartyLookupQueryDto) {
    return this.partyService.lookup(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.partyService.findById(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PARTIES_MANAGE)
  create(@Body() dto: CreatePartyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.partyService.create(dto, user);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PARTIES_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdatePartyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.partyService.update(id, dto, user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PARTIES_MANAGE)
  remove(@Param('id') id: string) {
    return this.partyService.remove(id);
  }

  /** multipart/form-data: `file`, plus an optional `title`. */
  @Post(':id/documents')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PARTIES_MANAGE)
  @UseInterceptors(FileInterceptor('file'))
  addDocument(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadPartyDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.partyService.addDocument(id, file, dto, user);
  }

  @Delete(':id/documents/:docId')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PARTIES_MANAGE)
  removeDocument(@Param('id') id: string, @Param('docId') docId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.partyService.removeDocument(id, docId, user);
  }
}
