import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * What the app is allowed to claim, and what it is allowed to log.
 *
 * These read the source tree rather than render anything, for the same
 * reason the API has boundary specs: a comment cannot stop the next person
 * writing "Recommended for you" above an empty list, and a code review can
 * miss a console.log with a filename in it. This can hold both rules for
 * screens nobody has written yet.
 */

const SRC = fileURLToPath(new URL('../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;

    if (entry.isDirectory()) {
      return sources(`${path}/`);
    }

    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const files = sources(SRC);

describe('the scan itself', () => {
  it('found a real tree, so nothing below passes vacuously', () => {
    expect(files.length).toBeGreaterThan(25);
  });
});

describe('the Opportunities screen', () => {
  const path = `${SRC}screens/main/OpportunitiesScreen.tsx`;
  const code = stripComments(readFileSync(path, 'utf8'));

  /*
   * The Opportunity Engine is Phase 12 and does not exist. The screen used
   * to head a section "Recommended for you" and explain the empty state as
   * "Career OS needs more information about your experience, skills, and
   * goals" - which tells a user a recommender exists and is waiting on
   * them. Someone who then completed their profile would find the same
   * empty state, having been told the fault was theirs.
   */
  it('does not claim recommendations exist', () => {
    expect(code).not.toMatch(/recommended for you/i);
    expect(code).not.toMatch(/needs more information/i);
    expect(code).not.toMatch(/we recommend/i);
  });

  it('says plainly that matching is not available yet', () => {
    expect(code).toMatch(/not available yet|coming soon|does not.*yet/i);
  });

  /*
   * No invented data. A screen that renders a hard-coded list of
   * "opportunities" is worse than one that says nothing, because it looks
   * like a working feature.
   */
  it('renders no fabricated opportunity data', () => {
    expect(code).not.toMatch(/const\s+\w*(opportunities|matches|jobs)\s*[:=]\s*\[/i);
    expect(code).not.toMatch(/\bmatchScore|fitScore|relevanceScore\b/i);
  });

  /*
   * And it does not quietly call Market Search and present the results as
   * though they had been matched to this user - which would be the same
   * claim with more steps.
   */
  it('does not dress market search up as personalised matching', () => {
    expect(code).not.toMatch(/searchMarket|market-search|marketSearch/);
  });
});

describe('what the app writes to the console', () => {
  /*
   * PR-3 removed four console.log calls from the resume upload path that
   * printed the user's filename, the local file URI and the storage path -
   * which embeds their user id. There is no babel transform stripping
   * console calls from release builds, so they shipped.
   *
   * The honest amount of logging in an app that handles resumes, until
   * PR-5 builds real logging, is none.
   */
  it('logs nothing at all', () => {
    const offenders = files.filter((file) =>
      /\bconsole\.(log|error|warn|info|debug)\s*\(/.test(
        stripComments(readFileSync(file, 'utf8')),
      ),
    );

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it('detects a planted log, so the scan is not vacuous', () => {
    expect(
      /\bconsole\.(log|error|warn|info|debug)\s*\(/.test(
        'console.log("SELECTED RESUME:", file.name)',
      ),
    ).toBe(true);
  });
});

describe('where the session is kept', () => {
  /*
   * PR-3 moved the Supabase session from AsyncStorage to the iOS Keychain.
   * AsyncStorage is an unencrypted file in the app sandbox and is included
   * in unencrypted device backups; the session is a credential that opens
   * somebody's resume and employment history.
   */
  it('uses the Keychain-backed adapter and not AsyncStorage', () => {
    const supabaseClient = readFileSync(`${SRC}lib/supabase.ts`, 'utf8');

    expect(supabaseClient).toContain('secureSessionStorage');
    expect(stripComments(supabaseClient)).not.toContain('AsyncStorage');
  });

  it('does not reintroduce AsyncStorage for auth anywhere else', () => {
    const offenders = files.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));

      return (
        code.includes('async-storage') &&
        /auth|session|token/i.test(code)
      );
    });

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});

describe('how a screen reacts to a failed request', () => {
  /*
   * Screens must not render a raw caught error. `describeError` is the one
   * place that decides what a person is shown, and it refuses to surface
   * the message of anything that is not an ApiError - which is what keeps
   * an internal string out of an Alert.
   */
  it('routes errors through describeError rather than error.message', () => {
    const screens = files.filter(
      (file) => file.includes('/screens/') && file.endsWith('.tsx'),
    );

    expect(screens.length).toBeGreaterThan(5);

    const offenders = screens.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));

      /*
       * The pattern that leaks: reading `.message` off a caught value and
       * rendering it. ResumeReviewScreen was the last screen doing this
       * and was converted in PR-4, so the correct expectation is now zero
       * rather than a list of known offenders.
       */
      return /error instanceof Error\s*\?\s*error\.message/.test(code);
    });

    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});

describe('the Evidence screens', () => {
  const evidenceFiles = files.filter(
    (file) =>
      file.includes('/screens/main/evidence/') ||
      file.includes('/evidence/'),
  );

  it('found the Evidence layer, so the checks below are not vacuous', () => {
    expect(evidenceFiles.length).toBeGreaterThan(6);
  });

  /*
   * The rule the whole Evidence layer exists to keep. A number is easier
   * to render and impossible to argue with, which is the objection: "87"
   * hides which part is weak, and invites comparing people.
   */
  it('renders no numeric trust score anywhere', () => {
    const offenders: string[] = [];

    for (const file of evidenceFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));

      /* A percentage, a score out of something, or a 0-100 rating. */
      if (/\b(trustScore|confidenceScore|evidenceScore|scoreOf)\b/.test(code)) {
        offenders.push(`${file.slice(SRC.length)}: score identifier`);
      }

      for (const match of code.matchAll(/'[^']*'|"[^"]*"|`[^`]*`/g)) {
        const text = match[0];

        /*
         * A percentage only counts as a score when it appears in COPY. A
         * bare '75%' is a layout value - maxHeight on the filter sheet -
         * and flagging it would train the next person to disable this
         * test rather than to read it.
         */
        const isCopy = /[a-z]/i.test(text);

        if (
          isCopy &&
          /\d+\s*%|\/\s*100\b|\bout of 100\b/.test(text)
        ) {
          offenders.push(`${file.slice(SRC.length)}: ${text.slice(0, 40)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /*
   * Evidence may never assert a level. The strength classes describe how
   * well something is KNOWN; they say nothing about the person, and no
   * string in this layer is allowed to blur that.
   */
  it('claims no seniority, expertise or leadership', () => {
    const offenders: string[] = [];

    /* The limitation copy legitimately NAMES these in order to deny them. */
    const DENIALS =
      /does not|doesn.t|not establish|never|cannot|limits|Seniority or career level|Expertise or level of skill|Leadership or ownership/i;

    for (const file of evidenceFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));

      for (const match of code.matchAll(/'[^']{12,}'|"[^"]{12,}"/g)) {
        const text = match[0];

        if (!/\b(senior|expert|proficien|leadership|leader)\b/i.test(text)) {
          continue;
        }

        if (DENIALS.test(text)) {
          continue;
        }

        offenders.push(`${file.slice(SRC.length)}: ${text.slice(0, 60)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still catches a percentage that appears in copy', () => {
    const layout = "'75%'";
    const score = "'87% confidence in this evidence'";

    const flags = (text: string) =>
      /[a-z]/i.test(text) && /\d+\s*%|\/\s*100\b/.test(text);

    expect(flags(layout)).toBe(false);
    expect(flags(score)).toBe(true);
  });

  it('detects a planted claim, so the scan is not vacuous', () => {
    const planted = "'You are a senior engineer based on this evidence'";

    expect(/\b(senior|expert)\b/i.test(planted)).toBe(true);
    expect(/does not|not establish/i.test(planted)).toBe(false);
  });

  /*
   * Unimplemented connectors must never be presented as usable. The
   * catalogue marks them `planned`, and nothing may call them available.
   */
  it('does not present unbuilt connectors as available', () => {
    const catalogue = stripComments(
      readFileSync(`${SRC}evidence/sources-catalogue.ts`, 'utf8'),
    );

    for (const unbuilt of [
      'figma',
      'notion',
      'linkedin',
      'dribbble',
      'kaggle',
      'leetcode',
      'jira',
      'linear',
    ]) {
      const entry = new RegExp(`id: '${unbuilt}'[\\s\\S]{0,400}?openable: (true|false)`);
      const found = catalogue.match(entry);

      expect(found, `${unbuilt} entry`).not.toBeNull();
      expect(found![1], `${unbuilt} openable`).toBe('false');
    }
  });

  /*
   * The manual-evidence form has no endpoint behind it. It must say so,
   * and it must not pretend to save.
   */
  it('says plainly that adding evidence cannot be saved yet', () => {
    const manual = stripComments(
      readFileSync(`${SRC}evidence/manual-evidence.ts`, 'utf8'),
    );

    expect(manual).toMatch(/available: false/);
    expect(manual).toMatch(/not available yet/i);
  });
});
