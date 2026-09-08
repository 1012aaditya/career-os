import { Injectable, Optional } from '@nestjs/common';

import type { SourceClient, SourcePage } from '../source-adapter.js';

/*
 * The Canada Job Bank open-data HTTP layer.
 *
 * No credential. Licence verified from the Government of Canada's own CKAN
 * metadata, which returns "license_id": "ca-ogl-lgo" - the Open Government
 * Licence – Canada, granting use "in any medium, mode or format for any
 * lawful purpose", commercial use included. Attribution required.
 *
 * The shape that makes this source worth having: it is NOT JSON. A monthly
 * UTF-16LE, tab-separated file of 65 columns, published per calendar month
 * rather than served as a query. The decoding lives here, in the client,
 * for the same reason the Swedish occupational-field map does - it is
 * knowledge about one source, and the canonical layers must not acquire
 * it. What crosses into the adapter is an array of row objects, which is
 * the same arrangement by which a JSON client hands over a parsed
 * envelope.
 */

const PACKAGE_URL =
  'https://open.canada.ca/data/api/action/package_show?id=ea639e28-c0fc-48bf-b5dd-b8899bd43072';

const USER_AGENT = 'career-os';

/*
 * A month is the scope, because a month is what the publisher actually
 * publishes: one complete file per calendar month, which can be read to
 * the end. That is what makes "completely read" a meaningful claim here.
 */
const SCOPE_SHAPE = /^\d{4}-\d{2}$/;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/*
 * One file is one page. There is nothing to paginate - the whole month
 * arrives in a single response - so a scope is complete or it failed.
 */
const MAX_PAGES = 1;

const INTER_SCOPE_DELAY_MS = 2_000;

const MAX_ATTEMPTS = 3;

const BACKOFF_MS = [500, 1_500];

export type CanadaJobBankFailure =
  | 'unknown_scope'
  | 'scope_not_published'
  | 'unavailable'
  | 'network_error'
  | 'unexpected_response';

export class CanadaJobBankRequestError extends Error {
  readonly scope: string;

  readonly status: number | null;

  readonly reason: CanadaJobBankFailure;

  constructor(
    scope: string,
    status: number | null,
    reason: CanadaJobBankFailure,
  ) {
    super(`Canada Job Bank request failed: ${scope} (${reason})`);

    this.name = 'CanadaJobBankRequestError';
    this.scope = scope;
    this.status = status;
    this.reason = reason;
  }
}

type Sleep = (ms: number) => Promise<void>;

/**
 * A UTF-16LE tab-separated file, as row objects.
 *
 * Deliberately not a general CSV parser. This file is tab-separated with
 * no quoting, so a general parser would add failure modes it does not
 * need. A row whose column count disagrees with the header is REFUSED
 * rather than zipped up short: a misaligned row is not a row with missing
 * fields, it is a row whose every value now belongs to the wrong column,
 * and reading it would put a postcode in a job title silently.
 */
export function parseUtf16Tsv(buffer: ArrayBuffer): {
  rows: Array<Record<string, string>>;
  malformed: number;
} {
  const text = new TextDecoder('utf-16le').decode(buffer);
  const lines = text.split(/\r?\n/);
  const headerLine = lines.shift() ?? '';

  /* Strip the byte-order mark, which survives decoding as U+FEFF. */
  const header = headerLine.replace(/^﻿/, '').split('\t');

  const rows: Array<Record<string, string>> = [];
  let malformed = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    const values = line.split('\t');

    if (values.length !== header.length) {
      malformed += 1;
      continue;
    }

    const row: Record<string, string> = {};

    header.forEach((column, index) => {
      row[column] = values[index] ?? '';
    });

    rows.push(row);
  }

  return { rows, malformed };
}

@Injectable()
export class CanadaJobBankClient implements SourceClient {
  private resources: Map<string, string> | null = null;

  constructor(
    @Optional()
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  readonly interScopeDelayMs = INTER_SCOPE_DELAY_MS;

  readonly maxPagesPerScope = MAX_PAGES;

  /**
   * Month slug -> download URL, read from the publisher's own catalogue.
   *
   * The URLs are not guessable: the August file is "…-en-aug2026.csv" and
   * the July one "…-en-july2026.csv", so the month abbreviation is not
   * consistent and each URL carries an opaque resource uuid. Constructing
   * them by pattern would break silently on whichever month the publisher
   * spelled differently.
   */
  private async catalogue(scope: string): Promise<Map<string, string>> {
    if (this.resources !== null) {
      return this.resources;
    }

    const body = (await this.getJson(PACKAGE_URL, scope)) as {
      result?: { resources?: Array<{ url?: unknown; name?: unknown }> };
    };

    const found = new Map<string, string>();

    for (const resource of body.result?.resources ?? []) {
      const url = typeof resource.url === 'string' ? resource.url : '';
      const name = typeof resource.name === 'string' ? resource.name : '';

      /* English files only; the French ones carry the same rows. */
      if (!/-en-/.test(url)) {
        continue;
      }

      const year = /(\d{4})\.csv$/.exec(url)?.[1];
      const month = MONTHS.findIndex((label) =>
        new RegExp(`\\b${label}\\b`, 'i').test(name),
      );

      if (year === undefined || month < 0) {
        continue;
      }

      found.set(`${year}-${String(month + 1).padStart(2, '0')}`, url);
    }

    this.resources = found;

    return found;
  }

  async fetchScope(scope: string, cursor: string | null): Promise<SourcePage> {
    if (!SCOPE_SHAPE.test(scope)) {
      throw new CanadaJobBankRequestError(scope, null, 'unknown_scope');
    }

    if (cursor !== null) {
      throw new CanadaJobBankRequestError(scope, null, 'unexpected_response');
    }

    const url = (await this.catalogue(scope)).get(scope);

    if (url === undefined) {
      /*
       * A month the publisher has not released is not an empty month, and
       * the distinction matters: failing here records the scope as NOT
       * read, so it can never be mistaken for "Canada advertised no jobs".
       */
      throw new CanadaJobBankRequestError(scope, null, 'scope_not_published');
    }

    const buffer = await this.getBuffer(url, scope);
    const { rows, malformed } = parseUtf16Tsv(buffer);

    return {
      body: { rows, malformed, sourceUrl: url },
      /* One file, one page. */
      nextCursor: null,
    };
  }

  classifyFailure(error: unknown): string {
    return error instanceof CanadaJobBankRequestError
      ? error.reason
      : 'unexpected_response';
  }

  private async getJson(url: string, scope: string): Promise<unknown> {
    const response = await this.request(url, scope);

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new CanadaJobBankRequestError(
        scope,
        response.status,
        'unexpected_response',
      );
    }
  }

  private async getBuffer(url: string, scope: string): Promise<ArrayBuffer> {
    const response = await this.request(url, scope);

    try {
      return await response.arrayBuffer();
    } catch {
      throw new CanadaJobBankRequestError(
        scope,
        response.status,
        'unexpected_response',
      );
    }
  }

  private async request(url: string, scope: string): Promise<Response> {
    let lastError: CanadaJobBankRequestError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      } catch {
        /* The caught error is never inspected and never attached. */
        lastError = new CanadaJobBankRequestError(scope, null, 'network_error');

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (response.status >= 500) {
        lastError = new CanadaJobBankRequestError(
          scope,
          response.status,
          'unavailable',
        );

        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1] ?? 0);
          continue;
        }

        throw lastError;
      }

      if (!response.ok) {
        throw new CanadaJobBankRequestError(
          scope,
          response.status,
          'unexpected_response',
        );
      }

      return response;
    }

    throw (
      lastError ??
      new CanadaJobBankRequestError(scope, null, 'unexpected_response')
    );
  }
}
