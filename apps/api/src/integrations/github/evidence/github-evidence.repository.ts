import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service.js';
import { canonicalJson } from '../observations/canonical-json.js';

import type { EvidenceInput } from './evidence-input.js';

/*
 * Persistence for projected GitHub evidence.
 *
 * This layer writes Evidence rows and nothing else. It does not create
 * Project, Experience, Skill, UserSkill, Achievement, Education, Goal or
 * CareerGraphIngestion rows, and it writes none of the
 * Evidence{Skill,Project,Experience,Achievement,Education} join rows.
 * Interpretation - deciding that a repository is a Project, or that a
 * language is a Skill the user has - is 7.5's job. Doing it here would
 * mean the act of observing GitHub silently rewrote the career graph,
 * with no confirmation step and no way to tell an observation from a
 * claim.
 *
 * It also never deletes. See RETENTION below.
 */

const SOURCE_TYPE = 'GITHUB' as const;

/*
 * RETENTION: absence from a sync is not evidence of absence.
 *
 * There is no delete/prune/reconcile method here on purpose. A repository
 * that appeared last run and not this one has not been proven gone: the
 * token may have lost a scope, the listing may have been truncated, the
 * repository may have been transferred to an org we can no longer read,
 * or a single page of the API may simply have failed. Every one of those
 * looks identical to a deletion from where this code stands.
 *
 * Deleting on that signal would destroy a user's evidence because of our
 * own rate limit. So evidence accumulates and is only ever updated in
 * place; the per-run completeness record on ExternalSyncRun is where a
 * reader learns that a run saw less than the whole picture. If deliberate
 * removal is ever wanted it needs an explicit user action, not an
 * inference from a partial scan.
 */

/**
 * The columns a re-sync is allowed to move.
 *
 * Deliberately narrow. userId, sourceType and externalId are identity and
 * are never updated - moving any of them would turn an update into an
 * impersonation. resumeImportId is absent for the reason given at the
 * update site.
 */
type EvidenceWritableFields = {
  title: string;
  description: string | null;
  sourceUrl: string | null;
  occurredAt: Date | null;
  capturedAt: Date;
  metadata: Prisma.InputJsonObject;
};

/** The subset of an existing row needed to decide whether to write. */
type ExistingEvidence = {
  id: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  occurredAt: Date | null;
  capturedAt: Date;
  metadata: unknown;
};

export type PersistResult = {
  /** True when this call inserted the row rather than updating one. */
  created: boolean;
};

export type PersistManyResult = {
  created: number;
  updated: number;
};

/**
 * Narrows projected metadata to something the Json column can hold.
 *
 * A round-trip through the canonical-JSON primitive rather than a bare
 * cast, because `Record<string, unknown>` is strictly wider than JSON: a
 * Date, a function, a bigint or an Infinity smuggled into metadata by an
 * upstream change would be silently mangled on the way into jsonb - a
 * Date becomes a string, Infinity becomes null - and the corruption would
 * only surface much later, in a column nobody validates. canonicalize()
 * throws on all of them, so a projection bug fails at the write instead
 * of being persisted as a plausible-looking wrong value.
 */
function jsonMetadata(
  value: Record<string, unknown>,
): Prisma.InputJsonObject {
  return JSON.parse(
    canonicalJson(value),
  ) as Prisma.InputJsonObject;
}

function writableFields(
  input: EvidenceInput,
): EvidenceWritableFields {
  return {
    title: input.title,
    description: input.description,
    sourceUrl: input.sourceUrl,
    occurredAt: input.occurredAt,
    capturedAt: input.capturedAt,
    metadata: jsonMetadata(input.metadata),
  };
}

function sameInstant(
  a: Date | null,
  b: Date | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  return a.getTime() === b.getTime();
}

/**
 * Whether a re-sync observed anything the stored row does not already say.
 *
 * capturedAt is excluded from the comparison on purpose. It moves on
 * every single run by definition - it is when we looked - so including it
 * would make every re-sync a write, every row's updatedAt churn, and the
 * audit trail useless for spotting an actual change. When something real
 * did change, capturedAt is written along with it, so the timestamp on a
 * row still answers "when did we last see this state".
 *
 * metadata is compared through the canonical-JSON primitive rather than
 * with JSON.stringify, because Postgres jsonb does not preserve key
 * order: the object read back is structurally equal but textually
 * different, and a naive string compare would report a change on every
 * run.
 */
/*
 * Fields that move on every run by construction, and therefore say
 * nothing about whether the OBSERVATION changed.
 *
 * scannedAt is this run's clock. reposScanned/reposTotal/listingTruncated
 * describe the run, not the repository - a repository untouched since
 * last week still gets a new reposScanned when a sibling is added.
 * previouslyObservedAt is bookkeeping written by the merge above.
 */
const RUN_VARYING_COMPLETENESS = [
  'scannedAt',
  'reposScanned',
  'reposTotal',
  'listingTruncated',
  'previouslyObservedAt',
  /*
   * Not an observation about the work - it says the repository row was
   * touched, and this run recorded it either way.
   */
  'revalidatedBy',
];

/*
 * Repository fields that move without the work moving.
 *
 * GitHub's repo updated_at advances on a star, a watch, a topic edit, a
 * description change or an archive - none of which is a push, and all of
 * which are far more common than pushes on any repository with an
 * audience. Comparing it would make isUnchanged fail on those, rewrite
 * the row, and re-stamp capturedAt - which then reorders the evidence
 * sheet, since it sorts by capturedAt desc. The value is still STORED;
 * it is only excluded from the question "did anything we care about
 * change".
 *
 * pushedAt is deliberately NOT in this list: a push is exactly the thing
 * that means the work moved.
 */
const RUN_VARYING_REPOSITORY = ['updatedAt'];

/*
 * The comparable view of metadata: everything except the run-varying
 * fields.
 *
 * Comparing raw metadata looked correct and was not. Because scannedAt is
 * inside the completeness block, two runs over an identical repository
 * always differed, so the guard below could never fire - every sync
 * rewrote every row and re-stamped every capturedAt. The test that
 * claimed otherwise passed only because its fixture omitted the very
 * fields that made it false, which is the failure mode of a fixture that
 * is hand-written rather than produced by the projection.
 */
function comparableMetadata(
  metadata: unknown,
): string {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return canonicalJson(metadata);
  }

  const source = metadata as Record<
    string,
    unknown
  >;

  const completeness =
    typeof source['completeness'] === 'object' &&
    source['completeness'] !== null
      ? { ...(source['completeness'] as Record<string, unknown>) }
      : undefined;

  if (completeness) {
    for (const field of RUN_VARYING_COMPLETENESS) {
      delete completeness[field];
    }
  }

  const repository =
    typeof source['repository'] === 'object' &&
    source['repository'] !== null
      ? { ...(source['repository'] as Record<string, unknown>) }
      : undefined;

  if (repository) {
    for (const field of RUN_VARYING_REPOSITORY) {
      delete repository[field];
    }
  }

  return canonicalJson({
    ...source,
    ...(completeness ? { completeness } : {}),
    ...(repository ? { repository } : {}),
  });
}

function isUnchanged(
  existing: ExistingEvidence,
  next: EvidenceWritableFields,
): boolean {
  return (
    existing.title === next.title &&
    existing.description === next.description &&
    existing.sourceUrl === next.sourceUrl &&
    sameInstant(
      existing.occurredAt,
      next.occurredAt,
    ) &&
    comparableMetadata(existing.metadata) ===
      comparableMetadata(next.metadata)
  );
}

function isUniqueViolation(
  error: unknown,
): boolean {
  return (
    error instanceof
      Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

const NON_OBSERVING = new Set([
  'NOT_SCANNED',
  'ACCESS_LOST',
]);

/*
 * Would this write replace a real count with an absence?
 *
 * The merge above is gated on the INCOMING completeness being NOT_SCANNED
 * or ACCESS_LOST. That covered every case that existed when it was
 * written, and stops covering them the moment anything can produce a
 * DEFAULT_BRANCH_ONLY row with a null count - which incremental sync can,
 * if the prior-state read fails, a key does not match, or an exception
 * path returns the bare listing shell.
 *
 * Such a row is self-consistently wrong: the projection renders "commit
 * attribution was not established", which reads as an honest sentence
 * over a row that just erased 214 commits. Nothing downstream would flag
 * it. So the guard is here, at the write, where the previous value is
 * still visible.
 *
 * Deliberately asymmetric: a real count replacing an absence is fine, and
 * a real count replacing a different real count is fine. Only the
 * direction that destroys knowledge is refused.
 */
function wouldEraseKnownCount(
  storedMetadata: unknown,
  incomingMetadata: unknown,
): boolean {
  const stored = commitCountOf(storedMetadata);

  return (
    stored !== null &&
    commitCountOf(incomingMetadata) === null
  );
}

function commitCountOf(
  metadata: unknown,
): number | null {
  if (
    typeof metadata !== 'object' ||
    metadata === null
  ) {
    return null;
  }

  const activity = (
    metadata as Record<string, unknown>
  )['activity'];

  if (
    typeof activity !== 'object' ||
    activity === null
  ) {
    return null;
  }

  const count = (
    activity as Record<string, unknown>
  )['commitsAttributed'];

  return typeof count === 'number' &&
    Number.isFinite(count)
    ? count
    : null;
}

function completenessOf(
  metadata: unknown,
): string | null {
  if (
    typeof metadata !== 'object' ||
    metadata === null
  ) {
    return null;
  }

  const completeness = (
    metadata as Record<string, unknown>
  )['completeness'];

  if (
    typeof completeness !== 'object' ||
    completeness === null
  ) {
    return null;
  }

  const commits = (
    completeness as Record<string, unknown>
  )['commits'];

  return typeof commits === 'string'
    ? commits
    : null;
}

/*
 * Merges a non-observing run over an existing row without erasing it.
 *
 * This is the difference between "we did not look" and "there is nothing
 * there", enforced at the only layer that can tell them apart. The
 * ingestion service is deliberately database-free, so it cannot know a
 * previous observation exists; it builds NOT_SCANNED and ACCESS_LOST rows
 * from the bare listing shell, with every count null and no languages. If
 * that were written through, a repository with 214 attributed commits and
 * six languages would be blanked by the next rate-limited sync - which,
 * for any account past the scan budget, is the NORMAL case rather than an
 * edge one.
 *
 * So the stored activity, languages and account block survive, and only
 * the completeness block moves. That also makes the projected sentence
 * true: it says "not scanned in this sync, so anything recorded for it is
 * as last captured", and after this merge that is exactly what the row
 * holds. Written through, the same statement would have described a
 * record it had just emptied.
 *
 * `previouslyObservedAt` preserves when the surviving numbers were really
 * gathered, so a consumer can say how stale they are rather than reading
 * this run's scannedAt as their age.
 */
function mergeNonObserving(
  storedMetadata: unknown,
  incomingMetadata: Record<string, unknown>,
): Record<string, unknown> {
  if (
    typeof storedMetadata !== 'object' ||
    storedMetadata === null ||
    Array.isArray(storedMetadata)
  ) {
    /*
     * Nothing worth keeping - a first-ever sighting that is already
     * unreadable. The incoming shell is the best available truth.
     */
    return incomingMetadata;
  }

  const stored = storedMetadata as Record<
    string,
    unknown
  >;

  const storedCompleteness =
    typeof stored['completeness'] === 'object' &&
    stored['completeness'] !== null
      ? (stored['completeness'] as Record<
          string,
          unknown
        >)
      : {};

  const incomingCompleteness =
    typeof incomingMetadata['completeness'] ===
      'object' &&
    incomingMetadata['completeness'] !== null
      ? (incomingMetadata[
          'completeness'
        ] as Record<string, unknown>)
      : {};

  return {
    ...stored,
    /*
     * Repository facts DO move: a rename or an archive is a fact this run
     * genuinely established from the listing, which succeeded.
     */
    repository:
      incomingMetadata['repository'] ??
      stored['repository'],
    completeness: {
      ...incomingCompleteness,
      /*
       * When the surviving numbers were really gathered.
       *
       * Read from the stored scannedAt only when the stored record was
       * itself an OBSERVATION. If it was not - a previous unscanned run -
       * its scannedAt is the clock of a run that gathered nothing, and
       * taking it would drag the age forward on every further unscanned
       * sync: a count a year old would report as observed last week,
       * which is the opposite of what this field exists to say. In that
       * case the stored previouslyObservedAt is already the real answer,
       * so it is carried forward unchanged.
       */
      previouslyObservedAt: NON_OBSERVING.has(
        typeof storedCompleteness['commits'] ===
          'string'
          ? (storedCompleteness[
              'commits'
            ] as string)
          : '',
      )
        ? (storedCompleteness[
            'previouslyObservedAt'
          ] ?? null)
        : (storedCompleteness['scannedAt'] ??
          null),
    },
  };
}

@Injectable()
export class GithubEvidenceRepository {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

/*
 * Which observation states are a REPORT rather than an OBSERVATION.
 *
 * NOT_SCANNED means "we ran out of budget or hit a rate limit before we
 * looked". ACCESS_LOST means "we looked and could not read it any more".
 * Neither is a finding about the repository; both are findings about the
 * sync.
 */
  /**
   * Writes one projected repository as Evidence, exactly once.
   *
   * Idempotency is the database's, not this method's. The authority is
   * the @@unique([userId, sourceType, externalId]) index: the upsert
   * below keys on it, and the P2002 recovery path exists because even an
   * upsert can lose the race.
   *
   * A "does it exist yet?" pre-check could not provide this. Under READ
   * COMMITTED - Postgres's default, and what this app runs on - a row
   * inserted by a concurrent transaction is invisible to our SELECT until
   * that transaction commits, so two overlapping syncs would both read
   * "absent" and both INSERT. One would then fail on the constraint. The
   * constraint is doing the work in every design; the only question is
   * whether we handle its complaint or 500 on it.
   */
  async persist(
    userId: string,
    input: EvidenceInput,
  ): Promise<PersistResult> {
    const next = writableFields(input);

    /*
     * Read first - but only to decide two things that are not
     * correctness: whether to report this as created or updated, and
     * whether the row already says what we are about to say (in which
     * case we write nothing at all and the row's updatedAt stays put).
     *
     * If this read races and loses, the worst outcome is a miscounted
     * created/updated tally in a log line. The row itself is still
     * correct, because the write below is keyed on the unique index and
     * recovers from its violation.
     */
    const existing = await this.findExisting(
      userId,
      input.externalId,
    );


    /*
     * A run that did not observe this repository must not overwrite one
     * that did. See mergeNonObserving: the incoming shell carries null
     * counts and no languages, and writing it through would destroy an
     * observation that was true when it was captured.
     */
    /*
     * Merge when the incoming run did not observe, OR when it claims to
     * have observed but carries no count over a row that has one. The
     * second condition is the one that catches a carry-forward that
     * silently failed to carry.
     */
    const merged =
      existing !== null &&
      (NON_OBSERVING.has(
        completenessOf(next.metadata) ?? '',
      ) ||
        wouldEraseKnownCount(
          existing.metadata,
          next.metadata,
        ))
        ? {
            ...next,
            metadata: jsonMetadata(
              mergeNonObserving(
                existing.metadata,
                next.metadata as Record<
                  string,
                  unknown
                >,
              ),
            ),
          }
        : next;

    /*
     * The no-churn check runs HERE, after the merge, because `merged` is
     * what will actually be written.
     *
     * Checking `next` instead would compare the raw NOT_SCANNED shell -
     * all nulls, no languages - against a stored row full of real
     * observations. They always differ, so every unscanned run would
     * write unconditionally and re-stamp capturedAt: the same churn
     * defect this guard exists to prevent, still open on the path that
     * runs for every repository past the scan budget. Found by review
     * after the merge was added, which is exactly the kind of seam a
     * merge introduces.
     */
    if (
      existing &&
      isUnchanged(existing, merged)
    ) {
      return { created: false };
    }

    try {
      await this.prisma.evidence.upsert({
        where: {
          userId_sourceType_externalId: {
            userId,
            sourceType: SOURCE_TYPE,
            externalId: input.externalId,
          },
        },
        create: {
          userId,
          sourceType: SOURCE_TYPE,
          externalId: input.externalId,
          /*
           * GitHub evidence is not resume evidence and must never be
           * attached to a ResumeImport. Written explicitly here, and
           * deliberately absent from the update payload below: a code
           * path that can set this column is a code path that can set it
           * to something other than null.
           */
          resumeImportId: null,
          ...next,
        },
        /*
         * Identity is not in this payload. A rename - same numeric
         * repository id, new full_name and new html_url - therefore
         * lands on the SAME row and rewrites its title and URL, instead
         * of orphaning the old row and inserting a second one. That is
         * the entire reason externalId is built from the immutable id.
         */
        update: merged,
      });

      return { created: existing === null };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      /*
       * Lost the race: between our read and our insert, a concurrent
       * sync committed this exact (userId, sourceType, externalId).
       *
       * That is not an error condition - it is the constraint doing its
       * job - so it is recovered rather than surfaced. Re-read the row
       * the winner wrote and apply our observation to it by primary key.
       * The result is the same row either way, which is what idempotent
       * means; nothing is duplicated and no caller sees a 500.
       */
      const winner = await this.findExisting(
        userId,
        input.externalId,
      );

      if (!winner) {
        /*
         * A P2002 with no row behind it is not our race - it is some
         * other constraint failing, and swallowing it would hide a real
         * bug. Rethrow untouched.
         */
        throw error;
      }

      /*
       * The same protection as the primary path. Without it the merge
       * would hold only when we win the race - and a rate-limited sync
       * that loses one would still blank the winner's observation, which
       * is precisely the case the merge exists for.
       */
      const recovered =
        NON_OBSERVING.has(
          completenessOf(next.metadata) ?? '',
        ) ||
        wouldEraseKnownCount(
          winner.metadata,
          next.metadata,
        )
        ? {
            ...next,
            metadata: jsonMetadata(
              mergeNonObserving(
                winner.metadata,
                next.metadata as Record<
                  string,
                  unknown
                >,
              ),
            ),
          }
        : next;

      if (isUnchanged(winner, recovered)) {
        return { created: false };
      }

      await this.prisma.evidence.update({
        where: { id: winner.id },
        data: recovered,
      });

      return { created: false };
    }
  }

  /**
   * Writes a whole run's worth of projected repositories.
   *
   * Sequential, and not wrapped in a single transaction. Each row is
   * independently idempotent, so a run that dies halfway leaves a
   * partially-updated but entirely valid set that the next sync
   * completes. One transaction around the batch would trade that for the
   * opposite: a single unwritable repository would roll back every other
   * repository's evidence, so one bad row could erase a whole sync's
   * work.
   *
   * Counts are reported honestly rather than assumed - see persist() for
   * why a created/updated tally is a report and not a guarantee.
   */
  async persistMany(
    userId: string,
    inputs: EvidenceInput[],
  ): Promise<PersistManyResult> {
    let created = 0;
    let updated = 0;

    for (const input of inputs) {
      const result = await this.persist(
        userId,
        input,
      );

      if (result.created) {
        created += 1;
      } else {
        updated += 1;
      }
    }

    return { created, updated };
  }

  /**
   * Looks up one GitHub evidence row for one user.
   *
   * Scoped by userId AND sourceType through the unique index, which is
   * what keeps this away from every other kind of evidence. RESUME rows
   * carry a NULL externalId and Postgres treats NULLs as distinct, so
   * they can never be selected here - but the scoping is explicit
   * regardless, because "it cannot match anyway" is a property of today's
   * data, and quietly rewriting a user's confirmed resume evidence from a
   * GitHub sync is not a bug worth leaving one refactor away.
   */
  private async findExisting(
    userId: string,
    externalId: string,
  ): Promise<ExistingEvidence | null> {
    return await this.prisma.evidence.findUnique({
      where: {
        userId_sourceType_externalId: {
          userId,
          sourceType: SOURCE_TYPE,
          externalId,
        },
      },
      select: {
        id: true,
        title: true,
        description: true,
        sourceUrl: true,
        occurredAt: true,
        capturedAt: true,
        metadata: true,
      },
    });
  }
}
