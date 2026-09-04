import { supabase } from '../lib/supabase';

const apiUrl = process.env.EXPO_PUBLIC_API_URL;

if (!apiUrl) {
  throw new Error('EXPO_PUBLIC_API_URL must be configured');
}

const API_BASE_URL = `${apiUrl.replace(/\/$/, '')}/v1`;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
};

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body),
  });

  if (!response.ok) {
    let message = `API request failed with status ${response.status}`;

    try {
      const errorBody = (await response.json()) as {
        message?: string | string[];
      };

      if (Array.isArray(errorBody.message)) {
        message = errorBody.message.join(', ');
      } else if (errorBody.message) {
        message = errorBody.message;
      }
    } catch {
      // Keep the default error message when the response isn't JSON.
    }

    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
