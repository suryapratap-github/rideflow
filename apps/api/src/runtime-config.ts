/** Startup configuration checks. Never use demo credentials in production. */
export function jwtSigningSecret(env: Record<string, string | undefined>): string {
  const secret = env.JWT_SECRET?.trim();
  if (env.NODE_ENV === 'production') {
    if (!secret || secret.length < 32 || secret === 'development-only-change-me') {
      throw new Error('Production JWT_SECRET must be set to a unique secret of at least 32 characters');
    }
  }
  return secret || 'development-only-change-me';
}

export function allowedCorsOrigins(env: Record<string, string | undefined>): string[] {
  const origins = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (env.NODE_ENV === 'production' && (!origins.length || origins.some(value => value === '*' || !/^https:\/\//.test(value)))) {
    throw new Error('Production CORS_ORIGINS must list explicit HTTPS origins');
  }
  return origins.length ? origins : ['http://localhost:3000'];
}
