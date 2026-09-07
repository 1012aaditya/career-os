import { apiRequest } from './client';

/*
 * The GitHub integration endpoints.
 *
 * Every one goes through apiRequest, so they carry the same Supabase
 * bearer token as the rest of the app. There is no second authentication
 * mechanism here and there must not be: the GitHub credential lives on
 * the server, and the only thing the device proves is who it is.
 *
 * These types mirror what the API actually returns - not what would be
 * convenient. Nothing is declared that the server does not send.
 */

/** What POST /v1/github/connect returns. Contains no secret. */
export type GithubAuthorizationRequest = {
  /*
   * The GitHub authorization URL, built by the server. It carries the
   * client id, the OAuth state and the PKCE challenge - all public or
   * one-way values - and no secret. The device opens it and nothing more;
   * it never parses it, stores it or reasons about its contents.
   */
  authorizationUrl: string;
  expiresAt: string;
};

/** What GET /v1/github/status returns. */
export type GithubStatus = {
  connected: boolean;
  accountId: string | null;
  login: string | null;
  grantedScopes: string[];
  status: string | null;
  lastVerifiedAt: string | null;
  lastSyncedAt: string | null;
};

export type GithubSyncCounts = {
  created: number;
  updated: number;
  reposScanned: number;
  reposRevalidated: number;
  reposTotal: number;
  reposSkipped: number;
};

/** What POST /v1/github/sync returns. */
export type GithubSyncSummary = {
  runId: string;
  status: string;
  counts: GithubSyncCounts;
  scannedAt: string;
  finishedAt: string;
  listingTruncated: boolean;
  error: string | null;
};

export type GithubDisconnectResult = {
  disconnected: boolean;
  revokedAtProvider: boolean;
};

/**
 * Starts the flow. The server creates the OAuth state and PKCE material
 * and binds them to the authenticated user; the device supplies nothing
 * and learns nothing about them.
 */
export function startGithubConnect() {
  return apiRequest<GithubAuthorizationRequest>(
    '/github/connect',
    { method: 'POST' },
  );
}

/**
 * The authoritative connection state.
 *
 * Called after every callback, success or failure. The deep link is a
 * hint from the operating system; this is the answer.
 */
export function fetchGithubStatus() {
  return apiRequest<GithubStatus>(
    '/github/status',
  );
}

export function syncGithub() {
  return apiRequest<GithubSyncSummary>(
    '/github/sync',
    { method: 'POST' },
  );
}

export function disconnectGithub() {
  return apiRequest<GithubDisconnectResult>(
    '/github/disconnect',
    { method: 'DELETE' },
  );
}
