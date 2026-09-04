import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { AuthGuard, AuthenticatedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let authService: {
    verifyAccessToken: ReturnType<typeof vi.fn>;
  };

  const createContext = (
    authorization?: string,
  ): ExecutionContext => {
    const request = {
      headers: {
        ...(authorization ? { authorization } : {}),
      },
    } as AuthenticatedRequest;

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    authService = {
      verifyAccessToken: vi.fn(),
    };

    guard = new AuthGuard(
      authService as unknown as AuthService,
    );
  });

  it('should reject a missing authorization header', async () => {
    await expect(guard.canActivate(createContext())).rejects.toThrow(
      new UnauthorizedException('Missing bearer token'),
    );

    expect(authService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('should reject an authorization header without Bearer', async () => {
    await expect(
      guard.canActivate(createContext('Basic abc123')),
    ).rejects.toThrow(new UnauthorizedException('Missing bearer token'));

    expect(authService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('should reject an empty bearer token', async () => {
    await expect(
      guard.canActivate(createContext('Bearer   ')),
    ).rejects.toThrow(new UnauthorizedException('Missing bearer token'));

    expect(authService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('should propagate an invalid-token error', async () => {
    authService.verifyAccessToken.mockRejectedValue(
      new UnauthorizedException('Invalid or expired access token'),
    );

    await expect(
      guard.canActivate(createContext('Bearer invalid-token')),
    ).rejects.toThrow(
      new UnauthorizedException('Invalid or expired access token'),
    );

    expect(authService.verifyAccessToken).toHaveBeenCalledWith(
      'invalid-token',
    );
  });

  it('should authenticate a valid token and attach the user', async () => {
    authService.verifyAccessToken.mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
    });

    const request = {
      headers: {
        authorization: 'Bearer valid-token',
      },
    } as AuthenticatedRequest;

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(authService.verifyAccessToken).toHaveBeenCalledWith(
      'valid-token',
    );
    expect(request.user).toEqual({
      id: 'user-123',
      email: 'test@example.com',
    });
  });
});
