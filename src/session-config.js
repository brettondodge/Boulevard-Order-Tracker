import session from 'express-session';

class PostgresSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
  }
  async get(sid, callback) {
    try {
      const result = await this.pool.query('SELECT sess FROM sessions WHERE sid = $1 AND expires_at > NOW()', [sid]);
      const session = result.rows[0]?.sess || null;
      callback && callback(null, session ? session : null);
    } catch (error) {
      callback && callback(error);
    }
  }
  async set(sid, session, callback) {
    try {
      const payload = JSON.stringify(session);
      const expiresAt = new Date(Date.now() + (session.cookie?.maxAge || 12 * 60 * 60 * 1000)).toISOString();
      await this.pool.query(
        `INSERT INTO sessions (sid, sess, expires_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expires_at = EXCLUDED.expires_at`,
        [sid, payload, expiresAt]
      );
      callback && callback(null);
    } catch (error) {
      callback && callback(error);
    }
  }
  async destroy(sid, callback) {
    try {
      await this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid]);
      callback && callback(null);
    } catch (error) {
      callback && callback(error);
    }
  }
  async touch(sid, session, callback) {
    try {
      const expiresAt = new Date(Date.now() + (session.cookie?.maxAge || 12 * 60 * 60 * 1000)).toISOString();
      await this.pool.query('UPDATE sessions SET expires_at = $1 WHERE sid = $2', [expiresAt, sid]);
      callback && callback(null);
    } catch (error) {
      callback && callback(error);
    }
  }
}

export function createPostgresSessionStore(pool) {
  return new PostgresSessionStore(pool);
}

export function getSessionMiddlewareOptions({
  store,
  isProduction = false,
  secret = process.env.SESSION_SECRET || 'boulevard-session-secret-change-me'
} = {}) {
  return {
    store,
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      sameSite: 'lax',
      httpOnly: true,
      secure: isProduction
    }
  };
}

export function configureSessionMiddleware(app, { store, isProduction = false, secret } = {}) {
  if (isProduction) app.set('trust proxy', 1);
  app.use(session(getSessionMiddlewareOptions({ store, isProduction, secret })));
}
