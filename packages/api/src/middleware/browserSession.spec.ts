import jwt from 'jsonwebtoken';
import type { IUser } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createBrowserSessionAuth } from './browserSession';

const makeResponse = () => {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response as unknown as Response;
};

describe('createBrowserSessionAuth', () => {
  const secret = 'browser-session-test-secret';
  const findSession = jest.fn();
  const getUserById = jest.fn();
  const runAsSystem = <T>(fn: () => Promise<T>): Promise<T> => fn();
  const establishTenantContext = jest.fn(
    (_req: ServerRequest, _res: Response, next: NextFunction) => next(),
  );
  const warn = jest.fn();
  const middleware = createBrowserSessionAuth({
    findSession,
    getUserById,
    runAsSystem,
    establishTenantContext,
    warn,
    parseCookies: (header) => Object.fromEntries(header.split('; ').map((part) => part.split('='))),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_REFRESH_SECRET = secret;
  });

  it('authenticates an active local refresh session without rotating it', async () => {
    const token = jwt.sign({ id: 'user-1' }, secret, { expiresIn: '1h' });
    const user = { _id: { toString: () => 'user-1' }, role: 'admin' } as unknown as IUser;
    findSession.mockResolvedValue({ expiration: new Date(Date.now() + 60_000) });
    getUserById.mockResolvedValue(user);
    const req = { headers: { cookie: `refreshToken=${token}` } } as ServerRequest;
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(findSession).toHaveBeenCalledWith({ userId: 'user-1', refreshToken: token });
    expect(req.user).toBe(user);
    expect(establishTenantContext).toHaveBeenCalledWith(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['expired', { expiration: new Date(Date.now() - 60_000) }],
  ])('rejects a %s local session', async (_label, session) => {
    const token = jwt.sign({ id: 'user-1' }, secret, { expiresIn: '1h' });
    findSession.mockResolvedValue(session);
    const req = { headers: { cookie: `refreshToken=${token}` } } as ServerRequest;
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('rejects a revoked or invalid signed refresh token before querying the user', async () => {
    const req = { headers: { cookie: 'refreshToken=invalid' } } as ServerRequest;
    const res = makeResponse();

    await middleware(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(findSession).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('requires the OpenID cookie to match the active server session', async () => {
    const userIdCookie = jwt.sign({ id: 'user-1' }, secret, { expiresIn: '1h' });
    const req = {
      headers: {
        cookie: `token_provider=openid; refreshToken=cookie-token; openid_user_id=${userIdCookie}`,
      },
      session: { openidTokens: { refreshToken: 'different-token' } },
    } as unknown as ServerRequest;
    const res = makeResponse();

    await middleware(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('authenticates OpenID with a matching active server session', async () => {
    const userIdCookie = jwt.sign({ id: 'user-1' }, secret, { expiresIn: '1h' });
    const user = { _id: { toString: () => 'user-1' }, role: 'admin' } as unknown as IUser;
    getUserById.mockResolvedValue(user);
    const req = {
      headers: {
        cookie: `token_provider=openid; refreshToken=session-token; openid_user_id=${userIdCookie}`,
      },
      session: {
        openidTokens: {
          refreshToken: 'session-token',
          userId: 'user-1',
          expiresAt: Date.now() + 60_000,
        },
      },
    } as unknown as ServerRequest;
    const res = makeResponse();

    await middleware(req, res, jest.fn());

    expect(req.user).toBe(user);
    expect(findSession).not.toHaveBeenCalled();
    expect(establishTenantContext).toHaveBeenCalled();
  });

  it('authenticates OpenID without the reuse-only signed user cookie', async () => {
    const user = { _id: { toString: () => 'user-1' }, role: 'admin' } as unknown as IUser;
    getUserById.mockResolvedValue(user);
    const req = {
      headers: { cookie: 'token_provider=openid; refreshToken=session-token' },
      session: {
        openidTokens: {
          refreshToken: 'session-token',
          userId: 'user-1',
          expiresAt: Date.now() + 60_000,
        },
      },
    } as unknown as ServerRequest;

    await middleware(req, makeResponse(), jest.fn());

    expect(req.user).toBe(user);
    expect(establishTenantContext).toHaveBeenCalled();
  });

  it('rejects an expired OpenID server session', async () => {
    const req = {
      headers: { cookie: 'token_provider=openid; refreshToken=session-token' },
      session: {
        openidTokens: {
          refreshToken: 'session-token',
          userId: 'user-1',
          expiresAt: Date.now() - 1,
        },
      },
    } as unknown as ServerRequest;
    const res = makeResponse();

    await middleware(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getUserById).not.toHaveBeenCalled();
  });
});
