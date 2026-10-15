import { IsEnum, IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';
import { LocationStatus, LocationType } from '../schemas/location.schema.js';

// No `code`: it is generated server-side from the type's sequence, and the
// global pipe (forbidNonWhitelisted) rejects a client that sends one.
export class CreateLocationDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsEnum(LocationType)
  type: LocationType;

  @IsOptional()
  @IsMongoId()
  parentId?: string | null;

  @IsOptional()
  @IsEnum(LocationStatus)
  status?: LocationStatus;
}
