import jwt from 'jsonwebtoken';
import { SystemRoles } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';

interface BrowserSession {
  expiration?: Date;
}

interface BrowserSessionDeps {
  findSession: (query: { userId: string; refreshToken: string }) => Promise<BrowserSession | null>;
  getUserById: (id: string, projection: string) => Promise<IUser | null>;
  runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  establishTenantContext: (req: ServerRequest, res: Response, next: NextFunction) => void;
  warn: (message: string, error?: string) => void;
  parseCookies: (header: string) => Record<string, string | undefined>;
}

interface OpenIdSessionData {
  openidTokens?: {
    expiresAt?: number;
    refreshToken?: string;
    userId?: string;
  };
}

const getSignedUserId = (token: string | undefined): string | null => {
  if (!token || !process.env.JWT_REFRESH_SECRET) {
    return null;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    return typeof payload === 'object' && typeof payload.id === 'string' ? payload.id : null;
  } catch {
    return null;
  }
};

/** Creates cookie authentication for browser navigations which cannot attach
 * LibreChat's in-memory Bearer token. The refresh credential is only verified;
 * it is never rotated, returned, or forwarded to a sidecar. */
export function createBrowserSessionAuth(deps: BrowserSessionDeps) {
  const getLocalUserId = async (refreshToken: string): Promise<string | null> => {
    const userId = getSignedUserId(refreshToken);
    if (!userId) {
      return null;
    }
    const session = await deps.runAsSystem(() => deps.findSession({ userId, refreshToken }));
    if (!session?.expiration || session.expiration <= new Date()) {
      return null;
    }
    return userId;
  };

  const getOpenIdUserId = (
    parsedCookies: Record<string, string | undefined>,
    req: ServerRequest,
  ): string | null => {
    if (parsedCookies.token_provider !== 'openid') {
      return null;
    }
    const session = req.session as typeof req.session & OpenIdSessionData;
    const openidTokens = session.openidTokens;
    if (
      !openidTokens?.refreshToken ||
      parsedCookies.refreshToken !== openidTokens.refreshToken ||
      !openidTokens.userId ||
      typeof openidTokens.expiresAt !== 'number' ||
      openidTokens.expiresAt <= Date.now()
    ) {
      return null;
    }
    const signedUserId = getSignedUserId(parsedCookies.openid_user_id);
    if (signedUserId && signedUserId !== openidTokens.userId) {
      return null;
    }
    return openidTokens.userId;
  };

  return async (req: ServerRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsedCookies = req.headers.cookie ? deps.parseCookies(req.headers.cookie) : {};
      const userId =
        getOpenIdUserId(parsedCookies, req) ||
        (parsedCookies.refreshToken ? await getLocalUserId(parsedCookies.refreshToken) : null);
      if (!userId) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      const user = await deps.runAsSystem(() =>
        deps.getUserById(userId, '-password -__v -totpSecret -backupCodes -federatedTokens'),
      );
      if (!user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      user.id = user._id.toString();
      user.role = user.role || SystemRoles.USER;
      req.user = user;
      deps.establishTenantContext(req, res, next);
    } catch (error) {
      deps.warn(
        '[createBrowserSessionAuth] browser session auth failed:',
        error instanceof Error ? error.message : String(error),
      );
      res.status(401).json({ message: 'Authentication required' });
    }
  };
}
