import { IsMongoId, IsOptional } from 'class-validator';

export class ProductGroupTreeQueryDto {
  @IsOptional()
  @IsMongoId()
  rootId?: string;
}
