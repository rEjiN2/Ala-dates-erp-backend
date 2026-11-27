import { Transform } from 'class-transformer';

/**
 * Query-string boolean. Reads the raw input (`obj[key]`): with
 * enableImplicitConversion the `value` handed to @Transform is already
 * Boolean("false") === true. "true"/"1" -> true, "false"/"0" -> false,
 * undefined stays undefined, anything else is left for @IsBoolean() to reject.
 */
export const ToBoolean = () =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    if (raw === true || raw === 'true' || raw === '1' || raw === 1) return true;
    if (raw === false || raw === 'false' || raw === '0' || raw === 0) return false;
    return raw;
  });
