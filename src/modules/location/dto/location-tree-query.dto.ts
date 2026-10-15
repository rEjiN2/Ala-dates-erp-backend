import { IsMongoId, IsOptional } from 'class-validator';

export class LocationTreeQueryDto {
  @IsOptional()
  @IsMongoId()
  rootId?: string;
}
