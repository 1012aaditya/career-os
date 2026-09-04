import { AuthService } from './auth.service.js';
import { SupabaseClientService } from './supabase.client.js';

describe('AuthService', () => {
  let service: AuthService;

  const supabaseClient = {
    auth: {
      getUser: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    service = new AuthService(
      { client: supabaseClient } as unknown as SupabaseClientService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return the authenticated user for a valid token', async () => {
    const user = {
      id: 'user-123',
      email: 'test@example.com',
    };

    supabaseClient.auth.getUser.mockResolvedValue({
      data: { user },
      error: null,
    });

    await expect(service.verifyAccessToken('valid-token')).resolves.toEqual(
      user,
    );

    expect(supabaseClient.auth.getUser).toHaveBeenCalledWith('valid-token');
  });

  it('should reject an invalid token', async () => {
    supabaseClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT' },
    });

    await expect(
      service.verifyAccessToken('invalid-token'),
    ).rejects.toThrow('Invalid or expired access token');
  });
});
