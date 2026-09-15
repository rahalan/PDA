const ROLES = ['User', 'Administrator', 'Compliance'];

export function canAccess(principal, pathname) {
  const roles = principal?.roles || [];
  if (pathname.startsWith('/api/ledger') || /^\/compliance(?:\.html)?$/.test(pathname)) {
    return roles.includes('Compliance');
  }
  if (/^\/api\/(policy|settings|credentials|routes)(\/|$)/.test(pathname) || /^\/admin(?:\.html)?$/.test(pathname)) {
    return roles.includes('Administrator');
  }
  if (pathname.startsWith('/api/chats') || pathname === '/api/demo/preflight' || ['/', '/chat', '/chat.html', '/index.html'].includes(pathname)) {
    return roles.includes('User') || roles.includes('Administrator');
  }
  if (pathname.startsWith('/api/') && !['/api/me', '/api/state'].includes(pathname)) return false;
  return ROLES.some(role => roles.includes(role));
}

export async function createAuthenticator(env = process.env) {
  if (env.PDA_ALLOW_REMOTE !== '1') {
    return async () => ({ id: 'local-operator', roles: [...ROLES], local: true });
  }
  const tenant = env.PDA_AUTH_TENANT_ID;
  const audience = env.PDA_AUTH_CLIENT_ID;
  const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (!guid.test(tenant || '') || !guid.test(audience || '')) {
    throw new Error('Cloud hosting requires PDA_AUTH_TENANT_ID and PDA_AUTH_CLIENT_ID.');
  }
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const keys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`), { timeoutDuration: 5000 });
  return async req => {
    const token = req.headers['x-ms-token-aad-id-token'];
    if (typeof token !== 'string' || token.length > 16384) return null;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'oid', 'tid'],
      });
      if (payload.tid !== tenant || !guid.test(payload.oid)) return null;
      return { id: `${tenant}:${payload.oid}`, roles: Array.isArray(payload.roles) ? payload.roles.filter(role => ROLES.includes(role)) : [], local: false };
    } catch {
      return null;
    }
  };
}