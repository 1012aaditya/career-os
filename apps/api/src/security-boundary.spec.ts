import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Security properties that no single unit test can hold, enforced by
 * reading the source tree.
 *
 * Everything here is a rule that is kept by habit right up until the
 * afternoon somebody is in a hurry. A comment cannot enforce "no endpoint
 * accepts a user id"; this can, and it keeps holding for the endpoint
 * nobody has written yet.
 */

const SRC = fileURLToPath(new URL('./', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;

    if (entry.isDirectory()) {
      return sources(`${path}/`);
    }

    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const files = sources(SRC);
const controllers = files.filter((file) => file.endsWith('.controller.ts'));

describe('the scan itself', () => {
  it('found a real tree, so nothing below passes vacuously', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(controllers.length).toBeGreaterThan(5);
  });
});

describe('whose data an endpoint can reach', () => {
  /*
   * THE isolation property, in its strongest form. Not "we check that the
   * id matches the session" - a check can be forgotten - but "there is
   * nowhere to put another user's id in the first place".
   *
   * Every user-owned route derives identity from `req.user.id`, which the
   * guard sets from a token it verified with Supabase and which no header,
   * body or path segment can influence.
   */
  it('accepts no user id from a client, anywhere', () => {
    const offenders: string[] = [];

    for (const file of controllers) {
      const code = stripComments(readFileSync(file, 'utf8'));

      for (const match of code.matchAll(
        /@(?:Param|Body|Query)\(\s*['"]([^'"]+)['"]/g,
      )) {
        const name = match[1] ?? '';

        if (/^user_?id$/i.test(name) || /^userId$/.test(name)) {
          offenders.push(`${file.slice(SRC.length)}: ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a planted user-id parameter, so the scan is not vacuous', () => {
    const planted = `@Param('userId') id: string`;

    expect(/@(?:Param|Body|Query)\(\s*['"]userId['"]/.test(planted)).toBe(true);
  });

  /*
   * A route that reads or writes somebody's data must take its identity
   * from the session. The exceptions are named rather than inferred:
   * health is deliberately public, the worker routes authenticate with a
   * shared secret and act on imports by id rather than on a user, and the
   * OAuth callback is reached by a browser with no session at all.
   */
  it('guards every controller that touches user data', () => {
    const PUBLIC_BY_DESIGN = ['health.controller.ts'];
    const WORKER_AUTHENTICATED = ['resume-processing.controller.ts'];

    const offenders: string[] = [];

    for (const file of controllers) {
      const name = file.slice(file.lastIndexOf('/') + 1);

      if (PUBLIC_BY_DESIGN.includes(name)) {
        continue;
      }

      const code = readFileSync(file, 'utf8');

      if (WORKER_AUTHENTICATED.includes(name)) {
        /* Guarded by a secret rather than a session, checked in constant time. */
        expect(code).toContain('timingSafeEqual');
        continue;
      }

      if (!code.includes('AuthGuard')) {
        offenders.push(file.slice(SRC.length));
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('what may reach a log', () => {
  /*
   * The policy changed in PR-5, and this test changed with it.
   *
   * PR-3 enforced "log nothing", which was the honest interim position
   * while there was nothing safe to log INTO: PR-1 had found a
   * console.error printing a storage path - which embeds a user id and
   * their own filename, usually their real name.
   *
   * Silence is no longer the right answer, because it also meant a
   * production incident was invisible. PR-5 replaced it with a structured
   * logger over an allowlist, so the rule is now about HOW a line is
   * written rather than whether one is.
   */
  it('writes to the console only from the CLI, startup and the logger', () => {
    const ALLOWED = [
      /* The operator CLI. Its whole purpose is printing to a terminal. */
      'market-graph/market-graph.cli.ts',
      /*
       * The storage backup CLI, same reason. It prints COUNTS - copied,
       * unchanged, failed - and deliberately never the name of an object
       * it failed on: a resume's storage path ends in a filename that is
       * usually the person's real name.
       */
      'operations/storage-backup.cli.ts',
      /* One startup line naming the environment. No URL, no credential. */
      'main.ts',
      /*
       * The structured logger itself. It writes the JSON line that every
       * other module produces through it, and its fields have already been
       * filtered by log-fields.ts before they reach here.
       */
      'observability/structured-logger.ts',
    ];

    const offenders: string[] = [];

    for (const file of files) {
      const relative = file.slice(SRC.length);

      if (ALLOWED.includes(relative)) {
        continue;
      }

      if (
        /\bconsole\.(log|error|warn|info|debug)\s*\(|process\.stdout\.write/.test(
          stripComments(readFileSync(file, 'utf8')),
        )
      ) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  /*
   * The rule that replaces "log nothing": no value is interpolated into a
   * log call.
   *
   * A template literal in a logger argument is exactly how `for user
   * ${userId}` got into three Phase 7 services. It looks like formatting
   * and is in fact an unbounded channel for whatever the variable holds -
   * a token, an email, a filename - which no allowlist can filter, because
   * by the time it reaches the logger it is one opaque string.
   *
   * The structured logger takes an event CODE and a field object instead,
   * and that object IS filtered. So a backtick in a log call is the shape
   * this forbids.
   */
  it('interpolates no value into a log call', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const relative = file.slice(SRC.length);

      /* The CLIs print operator output to a terminal, not to a log sink. */
      if (
        relative === 'market-graph/market-graph.cli.ts' ||
        relative === 'operations/storage-backup.cli.ts'
      ) {
        continue;
      }

      const code = stripComments(readFileSync(file, 'utf8'));

      for (const match of code.matchAll(
        /\.(log|warn|error|debug|verbose|fatal|event|failure)\s*\(\s*`([^`]*)`/g,
      )) {
        if ((match[2] ?? '').includes('${')) {
          offenders.push(`${relative}: ${match[2]?.slice(0, 50)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a planted interpolated log, so the scan is not vacuous', () => {
    const planted = 'this.logger.warn(`sync failed for user ${userId}`)';

    const found = [
      ...planted.matchAll(
        /\.(log|warn|error|debug|verbose|fatal|event|failure)\s*\(\s*`([^`]*)`/g,
      ),
    ].some((match) => (match[2] ?? '').includes('${'));

    expect(found).toBe(true);
  });

  /*
   * Ported from the market-graph boundary spec, which has enforced this
   * since Phase 8, and widened to the whole API. A caught error carries
   * the request that produced it - headers included - so logging one is
   * how a bearer token or a service-role key reaches a log file.
   */
  it('passes no caught error object to a logger', () => {
    const bare =
      /\.(log|warn|error|debug|verbose|fatal)\s*\(\s*(error|err|e|exception|cause)\s*[,)]/;
    const inObject =
      /\.(log|warn|error|debug|verbose|fatal)\s*\(\s*\{[^}]*\b(error|err|exception|cause)\b/;

    const offenders = files.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));

      return bare.test(code) || inObject.test(code);
    });

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});

describe('where a privileged credential may be used', () => {
  /*
   * The service-role key bypasses every row-level policy in the project.
   * It is read in exactly one place, from configuration, and the client
   * that holds it is shared - so there is one object to reason about
   * rather than one per caller.
   */
  it('constructs the privileged Supabase client in exactly one file', () => {
    const offenders = files.filter((file) => {
      const relative = file.slice(SRC.length);

      if (relative === 'auth/supabase.client.ts') {
        return false;
      }

      return /createClient\s*\(/.test(stripComments(readFileSync(file, 'utf8')));
    });

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it('names the service-role key in exactly one file', () => {
    const offenders = files.filter(
      (file) =>
        file.slice(SRC.length) !== 'auth/supabase.client.ts' &&
        readFileSync(file, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY'),
    );

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  /*
   * The environment is read for a credential in one place, from PR-2.
   * Restated here because it is a security property rather than a
   * database one, and this is the file somebody reads when asking "where
   * do secrets enter this system".
   */
  it('reads the environment for a credential in exactly one file', () => {
    const ALLOWED = [
      'market-graph/sources/source-credentials.ts',
      /* Bootstrapping: port, environment name, CORS list. No secrets. */
      'main.ts',
      'environment.ts',
      /* Connection string and pool tuning, before the container exists. */
      'prisma/prisma.service.ts',
      /*
       * Names the destination bucket for the storage backup. Not a
       * credential - the Supabase client it copies with is the shared one
       * from auth/supabase.client.ts, so this CLI reads a bucket NAME and
       * never a key.
       */
      'operations/storage-backup.cli.ts',
    ];

    const offenders = files.filter((file) => {
      const relative = file.slice(SRC.length);

      if (ALLOWED.includes(relative)) {
        return false;
      }

      return /process\.env/.test(stripComments(readFileSync(file, 'utf8')));
    });

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});

describe('what an error may tell a caller', () => {
  /*
   * A provider's own message names buckets, tenants, internal endpoints
   * and occasionally request ids. None of it helps the person holding the
   * phone, and all of it describes our infrastructure to whoever asked.
   *
   * The rule: no thrown HTTP exception interpolates a provider error
   * message. Interpolating our OWN values - a status, a count - is fine,
   * so the scan looks for the shape that carries provider text.
   */
  it('interpolates no provider error message into an HTTP exception', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));

      for (const match of code.matchAll(
        /new\s+\w*(?:Exception|Error)\s*\(\s*`([^`]*)`/g,
      )) {
        const template = match[1] ?? '';

        if (/\$\{[^}]*error[^}]*\}/i.test(template)) {
          offenders.push(`${file.slice(SRC.length)}: ${template.slice(0, 60)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a planted provider message, so the scan is not vacuous', () => {
    const planted = 'new BadRequestException(`Failed: ${error.message}`)';

    expect(
      /new\s+\w*(?:Exception|Error)\s*\(\s*`[^`]*\$\{[^}]*error[^}]*\}/i.test(
        planted,
      ),
    ).toBe(true);
  });
});

describe('the GitHub token path', () => {
  /*
   * Phase 7 encrypts tokens at rest with key versioning. PR-3 does not
   * redesign any of that - it checks the properties that would make the
   * encryption pointless if they broke.
   */
  const githubFiles = files.filter((file) => file.includes('/github/'));

  it('found the integration, so the checks below are not vacuous', () => {
    expect(githubFiles.length).toBeGreaterThan(3);
  });

  it('never returns a decrypted token from a controller', () => {
    const controller = githubFiles.find((file) =>
      file.endsWith('github.controller.ts'),
    )!;

    const code = stripComments(readFileSync(controller, 'utf8'));

    expect(code).not.toContain('accessToken');
    expect(code).not.toContain('tokenCiphertext');
    expect(code).not.toContain('decrypt');
  });

  it('decrypts only where a request is being built', () => {
    const offenders = githubFiles.filter((file) => {
      const relative = file.slice(SRC.length);

      if (
        relative.includes('github-connection.service.ts') ||
        relative.includes('github-sync.service.ts') ||
        relative.includes('github.client.ts') ||
        relative.includes('crypto/')
      ) {
        return false;
      }

      return /\.decrypt\s*\(/.test(stripComments(readFileSync(file, 'utf8')));
    });

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});
