import { z } from 'zod';

export const STORAGE_DRIVERS = ['r2', 'mega'] as const;

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  /**
   * Bare domain the auth cookies are scoped to, e.g. ".example.com" when the
   * API and frontend share a parent domain. Leave unset to scope them to the
   * API's own host (required when they are on different sites, e.g. two
   * *.vercel.app projects). A bad value would otherwise only surface as a
   * crash on login, so it is checked here.
   */
  COOKIE_DOMAIN: z
    .string()
    .trim()
    .regex(
      /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i,
      'COOKIE_DOMAIN must be a bare domain like ".example.com" (no https://, path, port or quotes), or left empty',
    )
    .refine(
      (domain) => !/^\.?vercel\.app$/i.test(domain),
      'COOKIE_DOMAIN cannot be "vercel.app": browsers reject cookies for that shared suffix. Leave it empty',
    )
    .optional(),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CORS_ORIGIN: z.string().optional(),

  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('r2'),
  STORAGE_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),

  R2_ENDPOINT: z.string().url().optional(),
  R2_REGION: z.string().default('auto'),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  MEGA_EMAIL: z.string().email().optional(),
  MEGA_PASSWORD: z.string().optional(),
  /** Top-level folder in the MEGA account's Cloud Drive; created on first use if missing. */
  MEGA_FOLDER_NAME: z
    .string()
    .trim()
    .regex(/^[^/\\]+$/, 'MEGA_FOLDER_NAME must be a single folder name, not a path')
    .optional(),

  /** Only read by `pnpm seed:dev-user`; the API itself never uses them. */
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8, 'SEED_ADMIN_PASSWORD must be at least 8 characters').optional(),
});

type EnvKey = keyof z.infer<typeof baseEnvSchema>;

const DRIVER_REQUIRED_KEYS: Record<(typeof STORAGE_DRIVERS)[number], readonly EnvKey[]> = {
  r2: ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
  mega: ['MEGA_EMAIL', 'MEGA_PASSWORD', 'MEGA_FOLDER_NAME'],
};

/**
 * Provider credentials are only demanded for the driver actually selected, so
 * adding an adapter later does not force every environment to carry every
 * provider's config.
 */
export const envSchema = baseEnvSchema.superRefine((config, ctx) => {
  for (const key of DRIVER_REQUIRED_KEYS[config.STORAGE_DRIVER]) {
    if (!config[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when STORAGE_DRIVER is "${config.STORAGE_DRIVER}"`,
      });
    }
  }
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  // `KEY=` in a .env file arrives as "", which would fail e.g. `.url().optional()`
  // for a provider that isn't even selected. Blank (or only spaces, easy to
  // save by accident in a hosting dashboard) means "not set".
  const provided = Object.fromEntries(
    Object.entries(config).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );
  const parsed = envSchema.safeParse(provided);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  return parsed.data;
}
