import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createAccessMiddleware({ teamDomain, audience, hostname = 'tools.blvdglass.com', keys } = {}) {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain || '') || !audience) {
    throw new Error('Set CF_ACCESS_TEAM_DOMAIN to your team.cloudflareaccess.com hostname and CF_ACCESS_AUD to the Access application audience.');
  }
  const issuer = `https://${teamDomain}`;
  const keySet = keys || createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (req, res, next) => {
    try {
      if (req.hostname !== hostname) throw new Error('Wrong hostname');
      const token = req.get('Cf-Access-Jwt-Assertion');
      if (!token) throw new Error('Missing token');
      const { payload } = await jwtVerify(token, keySet, {
        issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email']
      });
      if (typeof payload.email !== 'string' || !payload.email.includes('@')) throw new Error('Missing staff identity');
      req.accessUser = { id: payload.sub, username: payload.email, full_name: payload.email };
      next();
    } catch {
      res.status(403).json({ error: 'Sign in through tools.blvdglass.com with an approved staff account.' });
    }
  };
}
