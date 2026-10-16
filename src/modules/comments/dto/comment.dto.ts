import { Transform } from 'class-transformer';
import { IsMongoId, IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';
import { COMMENT_MAX_LENGTH } from '../schemas/comment.schema.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Identifies the record a comment or timeline belongs to. Used as both query and body shape. */
export class EntityRefQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  entityType: string;

  @IsMongoId()
  entityId: string;
}

export class CreateCommentDto extends EntityRefQueryDto {
  /** Trimmed before validation, so whitespace-only text is rejected as empty. */
  @Transform(trim)
  @IsString()
  @Length(1, COMMENT_MAX_LENGTH)
  text: string;
}
