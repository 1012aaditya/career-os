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
    /*
     * market-graph.service.ts is in this list deliberately. It was not,
     * and a `new Date()` inserted into it passed all 321 tests - which
     * would have made a freshness verdict a function of when the request
     * happened to be handled rather than of a stated instant, and would
     * have let two postings in one response carry verdicts taken against
     * different clocks. The read service takes `asOf` from the controller,
     * which is the request edge and the one place a clock belongs.
     */
    const pure = files.filter(
      (file) =>
        /\/(observations|normalization|signals)\//.test(file) ||
        file.endsWith('market-graph.service.ts'),
    );

    expect(pure.length).toBeGreaterThan(3);
    expect(pure.some((file) => file.endsWith('market-graph.service.ts'))).toBe(
      true,
    );

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

describe('what a purge may not quietly make easier', () => {
  /*
   * The referential actions, pinned by name.
   *
   * Sixteen RESTRICT edges are the reason a source cannot be deleted with
   * one statement, and they were protected by nothing but reviewer memory:
   * no spec in this repository mentioned onDelete, Restrict or the
   * migration directory. Flipping any of them to Cascade turns
   * `DELETE FROM "MarketSource"` into a one-liner that takes a source's
   * entire history - which is exactly what a purge author in a hurry would
   * reach for. The awkward ordering the purge service has to follow IS the
   * safety property, so changing one of these must be a deliberate act
   * that edits this list.
   */
  it('declares exactly the referential actions Phase 8 relies on', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const actions: string[] = [];

    for (const model of schema.matchAll(
      /^model\s+(Market\w+)\s*\{([\s\S]*?)^\}/gm,
    )) {
      for (const line of (model[2] ?? '').split('\n')) {
        if (!line.includes('@relation(') || !line.includes('onDelete:')) {
          continue;
        }

        const field = line.trim().split(/\s+/)[0];
        const action = /onDelete:\s*(\w+)/.exec(line)?.[1];

        actions.push(`${model[1]}.${field}: ${action}`);
      }
    }

    expect(actions.sort()).toEqual([
      'MarketIngestionRun.source: Restrict',
      'MarketPosting.source: Restrict',
      'MarketPostingNormalization.role: Restrict',
      'MarketPostingNormalization.roleAlias: Restrict',
      'MarketPostingNormalization.version: Cascade',
      'MarketPostingSighting.posting: Cascade',
      'MarketPostingSighting.run: Restrict',
      'MarketPostingSighting.version: Cascade',
      'MarketPostingSkillMention.alias: Restrict',
      'MarketPostingSkillMention.normalization: Cascade',
      'MarketPostingSkillMention.skill: Restrict',
      'MarketPostingVersion.firstSeenRun: Restrict',
      'MarketPostingVersion.posting: Cascade',
      'MarketRole.supersededBy: Restrict',
      'MarketRoleAlias.role: Restrict',
      'MarketRunScopeCoverage.run: Restrict',
      'MarketRunScopeCoverage.source: Restrict',
      'MarketSignal.role: Restrict',
      'MarketSignal.run: Cascade',
      'MarketSignal.skill: Restrict',
      'MarketSkill.supersededBy: Restrict',
      'MarketSkillAlias.skill: Restrict',
    ]);
  });

  /*
   * Phase 8 has one migration, and the second source needed none. That is
   * a claim about the canonical contract holding across sources, and it
   * stops being true the moment anything adds a column - so it is asserted
   * rather than repeated in a document.
   */
  it('adds no migration beyond the one that created the Market Graph', () => {
    const migrations = readdirSync(
      fileURLToPath(new URL('../../prisma/migrations', import.meta.url)),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isDirectory() && entry.name.includes('market'))
      .map((entry) => entry.name);

    expect(migrations).toEqual(['20260908120000_add_market_graph_foundation']);
  });
});

describe('what the Market Graph may not store or serve', () => {
  /*
   * D7: freshness is derived at an explicit asOf and never stored. A
   * stored verdict is a judgement made at time T that goes on asserting
   * itself at T plus six months, and keeping it honest needs the sweeper
   * whose write churn this phase exists to avoid.
   *
   * The existing forbidden-column scan covers score/fit/ranking vocabulary
   * and Float columns, and none of `freshnessVerdict`, `isStale`,
   * `lastCompleteCoverageAt` or `purgedAt` matched any of it - a String or
   * a DateTime slips straight through a Float scan.
   */
  it('declares no stored freshness, coverage-instant or purge column', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const offenders: string[] = [];

    for (const model of schema.matchAll(
      /^model\s+(Market\w+)\s*\{([\s\S]*?)^\}/gm,
    )) {
      for (const line of (model[2] ?? '').split('\n')) {
        const field = line.trim().split(/\s+/)[0] ?? '';

        if (
          line.includes('@relation(') ||
          field.startsWith('@') ||
          field === ''
        ) {
          continue;
        }

        if (
          /fresh|stale|aging|unavailable|coverageat|purg|tombstone/i.test(field)
        ) {
          offenders.push(`${model[1]}.${field}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a planted freshness column, so the scan above is not vacuous', () => {
    expect(
      /fresh|stale|aging|unavailable|coverageat|purg|tombstone/i.test(
        'freshnessVerdict',
      ),
    ).toBe(true);
    expect(
      /fresh|stale|aging|unavailable|coverageat|purg|tombstone/i.test(
        'lastCompleteCoverageAt',
      ),
    ).toBe(true);
    expect(
      /fresh|stale|aging|unavailable|coverageat|purg|tombstone/i.test(
        'companyNormalized',
      ),
    ).toBe(false);
  });

  /*
   * The JobTech adapter strips application_contacts and the employer's
   * email and phone before storage - but it never stripped the ad BODY,
   * and 2320 of 6671 stored descriptions carry an email address (1420
   * distinct) with 993 carrying a Swedish mobile number. Greenhouse adds
   * 389. Neither column is in any read select today, and this is what
   * keeps it that way: the protection is a test, not a convention.
   */
  it('serves no description text and no raw payload from the read side', () => {
    const code = stripComments(
      readFileSync(
        fileURLToPath(new URL('./market-graph.service.ts', import.meta.url)),
        'utf8',
      ),
    );

    for (const forbidden of [
      'descriptionRaw',
      'descriptionText',
      'rawPayload:',
    ]) {
      expect(`${forbidden}: ${code.includes(forbidden)}`).toBe(
        `${forbidden}: false`,
      );
    }
  });
});
