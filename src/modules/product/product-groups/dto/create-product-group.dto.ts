import { IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';

// No `code`: it is generated server-side, and the global pipe
// (forbidNonWhitelisted) rejects a client that sends one.
export class CreateProductGroupDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsMongoId()
  under?: string | null;
}
