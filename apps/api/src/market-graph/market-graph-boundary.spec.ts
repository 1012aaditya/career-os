import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The phase boundary, enforced against the schema and the source tree.
 *
 * Phase 8 answers what employers are advertising. Phase 9 answers what a
 * particular person should do about it. The whole value of the first
 * depends on it not quietly starting to do the second, and "we intend not
 * to" is not a control - a nullable column added in a hurry is all it
 * would take.
 *
 * So the boundary is asserted three ways: no relation from a Market model
 * into a Career Graph one, no relation back, and no Market Graph module
 * importing or querying a Career Graph model.
 */

const SCHEMA = fileURLToPath(
  new URL('../../prisma/schema.prisma', import.meta.url),
);

const MARKET_DIR = fileURLToPath(new URL('./', import.meta.url));

/*
 * Every model the Market Graph must not reach. The Career Graph is frozen
 * at Phase 6.9 and the external-evidence tables at Phase 7.
 */
const FOREIGN_MODELS = [
  'User',
  'Profile',
  'Education',
  'Company',
  'ResumeImport',
  'Experience',
  'Project',
  'Skill',
  'UserSkill',
  'Achievement',
  'Evidence',
  'Goal',
  'CareerGraphIngestion',
  'ExperienceProject',
  'ExperienceSkill',
  'ProjectSkill',
  'ExperienceAchievement',
  'ProjectAchievement',
  'EvidenceExperience',
  'EvidenceProject',
  'EvidenceSkill',
  'EvidenceEducation',
  'EvidenceAchievement',
  'ExternalConnection',
  'OAuthAuthorizationRequest',
  'ExternalSyncRun',
];

type Block = { name: string; body: string };

function models(schema: string): Block[] {
  return [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)].map(
    (match) => ({ name: match[1] ?? '', body: match[2] ?? '' }),
  );
}

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

describe('the Market Graph and the Career Graph do not touch', () => {
  const schema = readFileSync(SCHEMA, 'utf8');
  const blocks = models(schema);
  const market = blocks.filter((block) => block.name.startsWith('Market'));
  const foreign = blocks.filter((block) => !block.name.startsWith('Market'));

  it('found both halves of the schema, so the checks are not vacuous', () => {
    expect(market.length).toBeGreaterThanOrEqual(13);
    expect(foreign.length).toBeGreaterThanOrEqual(20);
  });

  /*
   * The test that would fail the day somebody adds
   * `userId String @db.Uuid` to a Market model - which is the first line
   * of the Opportunity Engine, written in the wrong phase.
   */
  it('declares no relation from a Market model into a frozen model', () => {
    const offenders: string[] = [];

    for (const block of market) {
      for (const line of block.body.split('\n')) {
        const trimmed = line.trim();

        if (trimmed.startsWith('//') || trimmed.startsWith('///')) {
          continue;
        }

        for (const model of FOREIGN_MODELS) {
          if (new RegExp(`\\b${model}\\b`).test(trimmed)) {
            offenders.push(`${block.name}: ${trimmed}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /* The sneakier direction: a relation added on the frozen side. */
  it('declares no relation from a frozen model into a Market model', () => {
    const offenders: string[] = [];

    for (const block of foreign) {
      for (const line of block.body.split('\n')) {
        const trimmed = line.trim();

        if (trimmed.startsWith('//') || trimmed.startsWith('///')) {
          continue;
        }

        if (/\bMarket\w+/.test(trimmed)) {
          offenders.push(`${block.name}: ${trimmed}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('gives every Market model a name that says which graph it is in', () => {
    for (const block of market) {
      expect(block.name.startsWith('Market')).toBe(true);
    }
  });

  /*
   * Counts are money here: a signal's numerator and denominator must be
   * whole postings. A float column is the surface a "demand score" grows
   * on, and it would also make byte-equality determinism tests unstable.
   */
  it('declares no floating-point column on any Market model', () => {
    const offenders: string[] = [];

    for (const block of market) {
      for (const line of block.body.split('\n')) {
        if (/^\s*\w+\s+(Float|Decimal)\b/.test(line)) {
          offenders.push(`${block.name}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /*
   * Vocabulary that would mean Phase 9 had leaked backwards. Each of these
   * is a judgement about a person, and none of them is something a job
   * posting asserts.
   */
  it('declares no column naming a score, a fit or a recommendation', () => {
    const forbidden =
      /\b\w*(score|fitness|recommend|opportunity|ranking|weight|proficien|seniority)\w*\s+(String|Int|Float|Boolean|DateTime|Decimal|Json)/i;

    const offenders: string[] = [];

    for (const block of market) {
      for (const line of block.body.split('\n')) {
        if (forbidden.test(line)) {
          offenders.push(`${block.name}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the Market Graph source tree', () => {
  const files = sources(MARKET_DIR);

  it('found a real tree to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports nothing from the Career Graph or the GitHub integration', () => {
    const offenders = files.filter((file) =>
      /from\s+'[^']*(career-graph|integrations|resume-import|resume-processing)[^']*'/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });

  /*
   * A Prisma client is a live connection to every table, so "no import" is
   * not enough - a Market service could simply call prisma.evidence. This
   * is the check that catches that, and it is the value-join loophole a
   * schema scan alone cannot see.
   */
  it('queries no Career Graph or Phase 7 model through Prisma', () => {
    const accessors = FOREIGN_MODELS.map(
      (model) => `prisma.${model[0]?.toLowerCase()}${model.slice(1)}.`,
    );

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const found = accessors.find((accessor) => code.includes(accessor));

      expect(`${file}: ${found ?? 'clean'}`).toBe(`${file}: clean`);
    }
  });

  it('passes no caught error object to a logger', () => {
    /*
     * Ported from the Phase 7 security boundary. A caught error carries
     * the request that produced it, headers included; logging one is how
     * credentials reach log files. Greenhouse needs no credentials, but
     * the second source will.
     */
    const bare =
      /\.(log|warn|error|debug|verbose|fatal)\s*\(\s*(error|err|e|exception|cause)\s*[,)]/;
    const inObject =
      /\.(log|warn|error|debug|verbose|fatal)\s*\(\s*\{[^}]*\b(error|err|exception|cause)\b/;

    const offenders = files.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));

      return bare.test(code) || inObject.test(code);
    });

    expect(offenders).toEqual([]);
  });

  /*
   * Every one of these is ICU-version and locale dependent, so a container
   * with a different base image can sort or casefold differently - and a
   * skill would resolve differently depending on where the process ran.
   */
  it('uses no locale-dependent comparison or casing anywhere', () => {
    const offenders = files.filter((file) =>
      /localeCompare|toLocale[A-Z]|\bIntl\./.test(
        stripComments(readFileSync(file, 'utf8')),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('reads no clock inside a pure layer', () => {
    const pure = files.filter((file) =>
      /\/(observations|normalization|signals)\//.test(file),
    );

    expect(pure.length).toBeGreaterThan(3);

    const offenders = pure.filter((file) => {
      /*
       * The two services in those directories legitimately take a clock as
       * a parameter; what is forbidden is READING one, so the check is for
       * Date.now and new Date() with no arguments.
       */
      const code = stripComments(readFileSync(file, 'utf8'));

      return /Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random\s*\(/.test(code);
    });

    expect(offenders).toEqual([]);
  });
});

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
