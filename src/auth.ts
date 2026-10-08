import { CanActivate, ExecutionContext, HttpException, Inject } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Config } from './config';

export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const COOKIE = 'shorts_session';
export function sessionCookie(c: Config, secure: boolean, logout = false) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + 12 * 3600000, nonce: randomUUID() }),
  ).toString('base64url');
  const signature = createHmac('sha256', c.ADMIN_TOKEN).update(payload).digest('base64url');
  return `${COOKIE}=${logout ? '' : payload + '.' + signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${logout ? 0 : 43200}${secure ? '; Secure' : ''}`;
}
export function hasSession(req: any, c: Config): boolean {
  const cookie = String(req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + '='))
    ?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const [payload, signature, extra] = cookie.split('.');
  if (!payload || !signature || extra) return false;
  const expected = createHmac('sha256', c.ADMIN_TOKEN).update(payload).digest('base64url');
  if (!equal(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}
export function sameOrigin(req: any) {
  return req.headers.origin === `${req.protocol}://${req.headers.host}`;
}
export class AdminGuard implements CanActivate {
  constructor(@Inject('CONFIG') private c: Config) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (equal(String(req.headers.authorization || ''), `Bearer ${this.c.ADMIN_TOKEN}`)) return true;
    if (!hasSession(req, this.c)) throw new HttpException('Unauthorized', 401);
    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req))
      throw new HttpException('Invalid request origin', 403);
    return true;
  }
}
