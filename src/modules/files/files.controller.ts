import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { FilesService } from './files.service.js';
import { UploadFileDto } from './dto/upload-file.dto.js';

/**
 * The single file surface for the whole API. Domain modules record the
 * returned id against their own document instead of exposing their own
 * upload routes, and every read is streamed through here so storage stays
 * private regardless of which provider backs it.
 */
@Controller('files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadFileDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.upload(file, dto, user?.id);
  }

  @Get(':id')
  // Authenticated content: never let a shared cache keep it, and never let the
  // browser second-guess the stored type.
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('id') id: string): Promise<StreamableFile> {
    const file = await this.filesService.download(id);
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.size,
      disposition: contentDisposition(file.originalName),
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.filesService.remove(id);
  }
}

/**
 * Inline so images/PDFs render in the browser (the upload whitelist keeps out
 * anything executable). The ASCII fallback strips quotes and control chars so
 * a crafted filename can't break out of the header.
 */
function contentDisposition(originalName: string): string {
  const fallback = originalName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}
