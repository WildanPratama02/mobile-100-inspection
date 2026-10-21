import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiProblem } from '../errors/problem';
import { type AuthRequest, authLevel } from './auth.decorator';
import { bearerToken, TabletTokens } from './tablet-token';

/**
 * The PSI's token on routes that need it (`@Auth('tablet')`, the default). Runs after `DeviceKeyGuard`, so the
 * device is known: a token issued to another device is `TOKEN_INVALID`, an expired one `TOKEN_EXPIRED` (the tablet
 * refreshes and resends, doc 04 §5). The claims go to `req.tablet`.
 */
@Injectable()
export class TokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TabletTokens) private readonly tokens: TabletTokens,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (authLevel(this.reflector, context) !== 'tablet') return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new ApiProblem('TOKEN_INVALID');
    const result = this.tokens.verify(token);
    if (!result.ok) {
      throw new ApiProblem(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
    }
    if (result.claims.dev !== req.device?.id) throw new ApiProblem('TOKEN_INVALID');
    req.tablet = result.claims;
    return true;
  }
}
