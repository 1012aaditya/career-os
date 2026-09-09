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
      'MarketAggregateObservation.datasetVersion: Cascade',
      'MarketDatasetVersion.source: Restrict',
      'MarketIngestionRun.source: Restrict',
      'MarketPosting.source: Restrict',
      'MarketPostingNormalization.role: Restrict',
      'MarketPostingNormalization.roleAlias: Restrict',
      'MarketPostingNormalization.version: Cascade',
      /*
       * Phase 10, and CASCADE on both rather than RESTRICT.
       *
       * Every other edge in this list is RESTRICT because deleting the
       * row behind it would destroy evidence somebody observed. A search
       * document is not evidence: it asserts nothing the tables it was
       * built from do not already say, and losing one costs the time to
       * rebuild it. So a purge that deletes a posting should take its
       * document with it rather than be blocked by it - the awkward
       * ordering the purge service follows is a safety property about
       * OBSERVATIONS, and adding a derived table to it would buy nothing
       * and make the purge harder to get right.
       */
      'MarketPostingSearchDocument.posting: Cascade',
      'MarketPostingSearchDocument.version: Cascade',
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
      'MarketTaxonomyTerm.datasetVersion: Cascade',
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

    expect(migrations).toEqual([
      '20260908120000_add_market_graph_foundation',
      /*
       * The second migration, added deliberately. Taxonomy terms and
       * aggregate statistics are not observed postings, and forcing them
       * into MarketPosting would mean inventing observations nobody made.
       * The extension is three source-neutral models, not one table per
       * source.
       */
      '20260908201948_add_market_dataset_evidence',
      /*
       * The third, added deliberately in Phase 10. Search needs one
       * projection table, and it needs it for a reason the query layer
       * cannot work around: nothing in the schema says which
       * MarketPostingVersion is a posting's CURRENT one, so every search
       * would open with a window function over 76,968 version rows joined
       * to normalization and skill mentions.
       *
       * It stores no new fact. Every column is a copy of something
       * already recorded, arranged so it can be filtered and ordered in
       * one indexed pass, and both its foreign keys cascade because
       * losing a row costs a rebuild and nothing else.
       */
      '20260909120000_add_market_search_projection',
      /*
       * The fourth, added deliberately in Phase 11. Partner, company and
       * ATS coverage needed the source registry to be able to say what
       * KIND of relationship a source is and where it stands in its access
       * lifecycle - neither of which any existing column expressed, and
       * both of which decide whether a source may be walked at all.
       *
       * Five columns on MarketSource, two enums, one CHECK constraint. No
       * new table, and in particular no per-company or per-vendor
       * structure: there is no CompanySource, no AtsSource and no
       * GoogleSource, because the whole point of the phase is that a
       * Google vacancy and a JobTech vacancy are the same kind of row.
       *
       * The CHECK constraint is the part that is not bookkeeping. It says
       * a source may be enabled only from the ENABLED access state, which
       * had been true in code and false in this database: two descriptors
       * read `isEnabled: false` while their rows read true, because
       * ensureSource's update block was empty and rows are not created
       * twice.
       */
      '20260909180000_add_market_partner_source_access',
    ]);
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
  /*
   * Phase 8's rule was "serve no description text at all", and it was
   * enforced by scanning ONE file - whose own comment worried that
   * splitting the read logic out would leave the check passing over
   * nothing. Phase 10 split the read logic out. So the scan now covers
   * the whole module and carries an explicit allowlist, which is the only
   * form in which "only these files may touch a body" is a control rather
   * than a habit.
   *
   * The rule is NARROWED, not lifted. A job the reader cannot read is not
   * a search result, so a body may be served - from one file, after
   * redaction, and the test below checks that file actually redacts.
   */
  const BODY_COLUMN_ALLOWLIST = [
    /* Produces descriptionText. It is the normalizer's output. */
    'normalization/market-normalization.service.ts',
    /* The pure normalizer that derives it. Reads no database. */
    'normalization/normalize.ts',
    /* Hashes a body into a content identity. Serves nothing. */
    'observations/posting-identity.ts',
    /* Rewrites bodies in place to remove contact details. */
    'observations/market-legacy-sanitizer.service.ts',
    /* Defines the redaction the ingestion path applies. */
    'observations/redaction.ts',
    /* The ONE place a body may leave the Market Graph. */
    'search/served-description.ts',
    /* Reads a body and hands it straight to servedDescription. */
    'search/market-search.service.ts',
  ];

  /*
   * The WRITE path, which is a different question.
   *
   * An adapter names descriptionRaw because it CONSTRUCTS one from a
   * publisher's response; the ingestion service names it because it
   * stores it. Neither serves anything. The rule this test enforces is
   * about what leaves the system, so the layer that puts a body in is
   * outside its scope - and saying so explicitly is better than a scan
   * that quietly happened not to reach it.
   */
  const WRITE_PATH_PREFIXES = ['sources/', 'ingestion/'];

  it('serves no description text and no raw payload from any read path', () => {
    const scanned: string[] = [];
    const offenders: string[] = [];

    for (const file of sources(MARKET_DIR)) {
      const relative = file.slice(MARKET_DIR.length);

      if (
        BODY_COLUMN_ALLOWLIST.includes(relative) ||
        WRITE_PATH_PREFIXES.some((prefix) => relative.startsWith(prefix))
      ) {
        continue;
      }

      scanned.push(relative);

      const code = stripComments(readFileSync(file, 'utf8'));

      for (const forbidden of [
        'descriptionRaw',
        'descriptionText',
        'rawPayload:',
      ]) {
        if (code.includes(forbidden)) {
          offenders.push(`${relative}: ${forbidden}`);
        }
      }
    }

    /*
     * Non-vacuity, and it is worth more here than it was: the scan now
     * covers a directory, so an allowlist typo that swallowed everything
     * would leave it passing over nothing at all.
     */
    expect(scanned.length).toBeGreaterThan(20);
    expect(scanned).toContain('market-graph.service.ts');
    expect(scanned).toContain('search/market-search-projection.service.ts');

    expect(offenders).toEqual([]);
  });

  /*
   * The other half of the narrowed rule. Allowing one file to read a body
   * is worth nothing unless that file demonstrably redacts it, and a
   * string scan is the same control used everywhere else in this file.
   */
  it('redacts every body the one permitted file returns', () => {
    const code = stripComments(
      readFileSync(
        fileURLToPath(
          new URL('./search/served-description.ts', import.meta.url),
        ),
        'utf8',
      ),
    );

    expect(code).toContain('redactContactText');

    /*
     * One exported function, one return path, and it returns the
     * REDACTED value. A second export, or a return of the raw argument,
     * would let a caller pick the wrong one of a pair.
     */
    const exported = [...code.matchAll(/export function (\w+)/g)].map(
      (match) => match[1],
    );

    expect(exported).toEqual(['servedDescription']);
    expect(code).not.toMatch(/return\s+stored\s*;/);
  });

  /*
   * And the file that reads the column must hand it straight over. This
   * is the seam the allowlist opens, so it is the seam that gets pinned.
   */
  it('passes the body it reads through the redactor and nowhere else', () => {
    const code = stripComments(
      readFileSync(
        fileURLToPath(
          new URL('./search/market-search.service.ts', import.meta.url),
        ),
        'utf8',
      ),
    );

    const reads = [...code.matchAll(/descriptionText/g)];

    /* Named exactly twice: once in the select, once in the read of it. */
    expect(reads.length).toBe(2);
    expect(code).toContain('servedDescription(');
  });

  /*
   * The hole a string scan cannot see.
   *
   * Naming a forbidden column is not the only way to serve it: a Prisma
   * read with no `select` returns EVERY scalar column, so a findMany on
   * MarketPostingVersion without one would serve descriptionRaw while the
   * scan above reported clean. Every read on this path must name its
   * columns. groupBy and count return no columns and are not matched.
   */
  it('names the columns of every read, so none can return a whole row', () => {
    const code = stripComments(
      readFileSync(
        fileURLToPath(new URL('./market-graph.service.ts', import.meta.url)),
        'utf8',
      ),
    );

    const reads = [
      ...code.matchAll(
        /\.(findMany|findFirst|findUnique|findUniqueOrThrow)\(/g,
      ),
    ];

    expect(reads.length).toBeGreaterThan(5);

    for (const read of reads) {
      /*
       * The call's OWN argument object, found by matching parentheses.
       * A fixed-size window forward does not work: it reaches into the
       * next query and finds ITS select, so removing a select here left
       * the check passing. Proven by mutation, which is why it is written
       * this way.
       */
      const open = (read.index ?? 0) + read[0].length - 1;
      let depth = 0;
      let close = open;

      for (let i = open; i < code.length; i += 1) {
        if (code[i] === '(') depth += 1;
        if (code[i] === ')') {
          depth -= 1;

          if (depth === 0) {
            close = i;
            break;
          }
        }
      }

      const argument = code.slice(open, close);

      expect(`${read[1]}@${open}: ${argument.includes('select:')}`).toBe(
        `${read[1]}@${open}: true`,
      );
    }
  });
});

/*
 * Phase 11: credentials, and internal access material.
 *
 * Two rules, both enforced by reading the source tree, because both are
 * the kind of rule that is kept by habit right up until the afternoon
 * somebody is in a hurry.
 *
 *   A credential is read in ONE file and used in the client that needs
 *   it. Nothing else may reach the environment for one.
 *
 *   The access lifecycle is INTERNAL. Which sources were refused, who was
 *   asked what, and whether this host is configured are operator
 *   questions; the read API answers reader questions.
 */
describe('what a credential may touch', () => {
  const files = sources(MARKET_DIR);

  it('found a real tree to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  /*
   * The environment is read in exactly one place. A client that read
   * process.env itself would be a client holding a credential, and a
   * client holding a credential is one console.log away from a log file
   * full of them.
   */
  it('reads the environment for a credential in exactly one file', () => {
    const offenders = files.filter((file) => {
      const relative = file.slice(MARKET_DIR.length);

      if (relative === 'sources/source-credentials.ts') {
        return false;
      }

      return /process\.env|ConfigService/.test(
        stripComments(readFileSync(file, 'utf8')),
      );
    });

    expect(offenders).toEqual([]);
  });

  it('detects a planted environment read, so the scan is not vacuous', () => {
    expect(
      /process\.env|ConfigService/.test('const key = process.env.SOME_KEY;'),
    ).toBe(true);
  });

  /*
   * The credential RESOLVER - the call that returns actual values - is
   * reachable only from a source client. `state()` is fine anywhere,
   * because it returns key names and an enum; `resolve()` is not.
   */
  it('resolves credential values only inside a source client', () => {
    const offenders = files.filter((file) => {
      const relative = file.slice(MARKET_DIR.length);

      if (
        relative === 'sources/source-credentials.ts' ||
        /^sources\/[a-z0-9-]+\/[a-z0-9-]+\.client\.ts$/.test(relative)
      ) {
        return false;
      }

      return /credentials\.resolve\s*\(/.test(
        stripComments(readFileSync(file, 'utf8')),
      );
    });

    expect(offenders).toEqual([]);
  });

  /*
   * A credential must never become part of what is STORED. queryParams is
   * written verbatim onto every ingestion run and hashed into a
   * fingerprint the API serves, so a key placed there would be a
   * plaintext secret in the database and a brute-forceable commitment to
   * it over HTTP. The registry spec checks the values; this checks that
   * no code path assembles one.
   */
  it('never puts a resolved credential into a descriptor', () => {
    const registry = readFileSync(
      `${MARKET_DIR}sources/source-registry.ts`,
      'utf8',
    );

    expect(/credentials\.resolve|process\.env/.test(stripComments(registry))).toBe(
      false,
    );
  });
});

describe('what the read API may not learn about a source', () => {
  const READ_PATHS = [
    'market-graph.service.ts',
    'market-graph.controller.ts',
    'search/market-search.service.ts',
    'search/market-search.controller.ts',
  ];

  /*
   * accessNote records what was asked of whom, which partnerships are
   * open, and why a source was refused. licenceNote is our own working
   * reasoning about a licence - what was verified, which residual risks
   * remain, and in one case which of a publisher's two APIs must never be
   * called.
   *
   * Neither is reader-facing, and licenceNote was in fact being served on
   * every job detail until Phase 11 replaced it with `attribution` - the
   * credit a licence actually obliges us to display. The mobile client
   * never rendered the note, so nothing was lost and a paragraph of
   * internal material stopped leaving the building.
   */
  it('selects no internal access or licence prose on a job detail', () => {
    const code = stripComments(
      readFileSync(`${MARKET_DIR}search/market-search.service.ts`, 'utf8'),
    );

    for (const forbidden of ['accessNote', 'licenceNote', 'accessState']) {
      expect(`market-search.service.ts: ${code.includes(forbidden)}`).toBe(
        `market-search.service.ts: false`,
      );
    }

    /* And the thing that replaced it is there, so this is not vacuous. */
    expect(code).toContain('attribution');
  });

  it('never selects an access note on any read path', () => {
    const offenders = READ_PATHS.filter((relative) =>
      stripComments(readFileSync(`${MARKET_DIR}${relative}`, 'utf8')).includes(
        'accessNote',
      ),
    );

    expect(offenders).toEqual([]);
  });

  /*
   * The health report names credential variables and quotes access notes.
   * It is an operator tool, so it must not be reachable from anything with
   * a route on it - the CLI is the only caller.
   */
  it('keeps the source health report off every HTTP surface', () => {
    const offenders = sources(MARKET_DIR).filter((file) => {
      const relative = file.slice(MARKET_DIR.length);

      if (
        relative === 'sources/market-source-health.service.ts' ||
        relative === 'market-graph.cli.ts' ||
        relative === 'market-graph-core.module.ts'
      ) {
        return false;
      }

      return stripComments(readFileSync(file, 'utf8')).includes(
        'MarketSourceHealthService',
      );
    });

    expect(offenders).toEqual([]);
  });
});
