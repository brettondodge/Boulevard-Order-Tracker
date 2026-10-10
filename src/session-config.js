import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

export function createPostgresSessionStore(pool, tableName = 'sessions') {
  const PostgresStore = connectPgSimple(session);
  return new PostgresStore({
    pool,
    tableName,
    createTable: false,
    pruneSessionInterval: false
  });
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
    proxy: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      sameSite: isProduction ? 'none' : 'lax',
      httpOnly: true,
      secure: isProduction
    }
  };
}

export function configureSessionMiddleware(app, { store, isProduction = false, secret } = {}) {
  app.set('trust proxy', 1);
  app.use(session(getSessionMiddlewareOptions({ store, isProduction, secret })));
}
