/**
 * Construye la URL de PostgreSQL a partir de las variables POSTGRES_* cuando
 * POSTGRES_HOST está definido; de lo contrario conserva DATABASE_URL.
 */
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const host = env.POSTGRES_HOST?.trim();
  if (!host) {
    return env.DATABASE_URL?.trim() || undefined;
  }

  const user = encodeURIComponent(env.POSTGRES_USER?.trim() || 'postgres');
  const password = encodeURIComponent(env.POSTGRES_PASSWORD || 'postgres');
  const port = env.POSTGRES_PORT?.trim() || '5432';
  const db = encodeURIComponent(env.POSTGRES_DB?.trim() || 'postgres');

  return `postgresql://${user}:${password}@${host}:${port}/${db}?schema=public`;
}

/**
 * Sincroniza process.env.DATABASE_URL con la URL resuelta para que Prisma
 * utilice siempre la conexión construida desde POSTGRES_*.
 */
export function syncDatabaseUrlEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const url = resolveDatabaseUrl(env);
  if (url) {
    env.DATABASE_URL = url;
  }
  return url;
}
