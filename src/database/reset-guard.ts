/** The --confirm=<name> value of a command line, if any. */
export function confirmArg(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length);
}

/**
 * db:reset drops every collection, so it needs three things: not production,
 * ALLOW_RESET_DB set to the connected database name, and --confirm=<same name>.
 * Throws before anything is touched.
 */
export function assertResetAllowed(input: {
  nodeEnv?: string;
  allowResetDb?: string;
  confirm?: string;
  databaseName: string;
}): void {
  if (input.nodeEnv === 'production') {
    throw new Error('db:reset refuses to run with NODE_ENV=production');
  }
  if (input.allowResetDb !== input.databaseName) {
    throw new Error(`Set ALLOW_RESET_DB=${input.databaseName} (the connected database name) to allow a reset`);
  }
  if (input.confirm !== input.databaseName) {
    throw new Error(`Pass --confirm=${input.databaseName} to confirm dropping every collection in it`);
  }
}
