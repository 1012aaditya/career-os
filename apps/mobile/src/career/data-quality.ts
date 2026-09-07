/*
 * Career state and data quality.
 *
 * Two related jobs, both pure and both read-only:
 *
 *   1. Give career state an explicit vocabulary. "Is this role current?"
 *      currently resolves to a single persisted boolean whose derivation is
 *      invisible at the point of use. getCareerState names the state AND
 *      the basis it rests on, so a caller can tell a role that carries an
 *      end date from one that is merely missing one.
 *
 *   2. Detect records that need the user's attention — contradictory
 *      dates, roles marked current, skills attached to nothing.
 *
 * What this module deliberately does NOT do:
 *
 *   - It produces no score, percentage, grade or completeness metric. A
 *     career is not a number, and a number would invite optimising the
 *     number rather than the record.
 *   - It never says a record is wrong, invalid, or low quality. It says
 *     what is missing or what disagrees, and leaves the judgement to the
 *     person whose career it is.
 *   - It never repairs anything. Records that read alike — two Experience
 *     rows for the same title at the same company, which repeat resume
 *     imports genuinely produce — are reported as looking alike and left
 *     alone. Merging distinct database identities here would hide a
 *     normalisation decision inside a display layer.
 *
 * Everything is resolved by stable id and ordered deterministically, so
 * the same graph always yields the same report.
 */

import type { CareerGraph } from '../api/career-graph';

import {
  getBooleanField,
  getObjectField,
  getStringField,
  getTimeField,
  toArray,
} from './graph-fields';

import {
  getAchievementTitle,
  getExperienceTitle,
  getLinkedSkillIds,
  getProjectName,
  getSkillName,
  type DetailEntityType,
} from './graph-model';

/*
 * ----------------------------------------------------------------------
 * CAREER STATE
 * ----------------------------------------------------------------------
 */

export type CareerState =
  | 'current'
  | 'ended'
  | 'unknown';

/*
 * Why the state was reached. This is the part that matters: `flagged`
 * looks identical to `ended` at the call site today, and only the basis
 * says which fact is doing the work.
 */
export type CareerStateBasis =
  /** The record carries an end date. A concrete fact. */
  | 'has-end-date'
  /*
   * The record states it: the end date it carries is an ongoing marker
   * ("Present", "Current").
   *
   * Stronger than an inference, but NOT proof the AI extracted it —
   * ingestion reads the CONFIRMED extraction, which the user may have
   * edited during review. Read this as "the confirmed record says
   * ongoing", never as "the resume said ongoing". Separating those two
   * needs the preserved raw extraction, which is now recorded but not yet
   * consulted here.
   */
  | 'stated-current'
  /*
   * isCurrent is set and the source supplied no end date at all. Treating
   * the role as open is the resume convention, but it is an INFERENCE —
   * the source never said the role is ongoing. Callers must not present
   * this as something the user stated.
   */
  | 'assumed-current'
  /** isCurrent is set but an end date is also present; they disagree. */
  | 'conflicting'
  /** Neither signal is present. Nothing is known either way. */
  | 'no-signal';

export type CareerStateResult = {
  state: CareerState;
  basis: CareerStateBasis;
};

/*
 * An explicit end date always wins over the isCurrent flag. The date is a
 * value the record actually carries; the flag may have been derived from
 * that value's absence at ingestion, so it is the weaker signal.
 *
 * When the record kept the source's own end-date text, the basis separates
 * a role the source SAID was ongoing from one where the absence of a date
 * was merely read that way. Records written before endDateText existed
 * cannot make that distinction and report the weaker of the two.
 */
/*
 * MIRRORS the list in apps/api/src/career-graph/career-graph-ingestion.service.ts
 * (ONGOING_MARKERS). Ingestion uses it to decide isCurrent; this uses it to
 * decide whether that decision was stated by the source or assumed from a
 * missing date. No shared package spans the two apps, so they must be kept
 * in step by hand — a value present in one and not the other silently
 * downgrades a stated fact to an inference.
 */
const ONGOING_MARKERS = new Set([
  'present',
  'current',
  'currently',
  'now',
  'ongoing',
  'to date',
  'till date',
  'to present',
  'till present',
]);

export function getCareerState(
  record: unknown,
): CareerStateResult {
  const hasEndDate =
    getTimeField(record, 'endDate') !== null;

  const isCurrent = getBooleanField(
    record,
    'isCurrent',
  );

  const endDateText = getStringField(
    record,
    'endDateText',
  );

  const statedOngoing =
    endDateText !== null &&
    ONGOING_MARKERS.has(
      endDateText.toLowerCase(),
    );

  if (hasEndDate && isCurrent) {
    return {
      state: 'ended',
      basis: 'conflicting',
    };
  }

  if (hasEndDate) {
    return {
      state: 'ended',
      basis: 'has-end-date',
    };
  }

  if (isCurrent) {
    return {
      state: 'current',
      basis: statedOngoing
        ? 'stated-current'
        : 'assumed-current',
    };
  }

  return {
    state: 'unknown',
    basis: 'no-signal',
  };
}

/*
 * ----------------------------------------------------------------------
 * DATA QUALITY
 * ----------------------------------------------------------------------
 */

export type DataQualityIssueKind =
  | 'date-range-reversed'
  | 'current-with-end-date'
  | 'multiple-current-roles'
  | 'role-state-unknown'
  | 'work-missing-dates'
  | 'work-without-skills'
  | 'skill-not-connected'
  | 'achievement-without-evidence'
  | 'evidence-without-links'
  | 'similar-records';

export type DataQualityEntity = {
  entityType: DetailEntityType;
  entityId: string;
  label: string;
};

export type DataQualityIssue = {
  /** Stable render key and test handle. */
  id: string;
  kind: DataQualityIssueKind;
  /** Calm, factual, singular-or-plural aware. */
  message: string;
  entities: DataQualityEntity[];
};

export type DataQualityReport = {
  issues: DataQualityIssue[];
  /*
   * Number of distinct ISSUE KINDS, not of affected records — three kinds
   * can cover forty rows. Named explicitly so no caller mistakes it for a
   * count of problems, and deliberately not rendered as a figure anywhere.
   */
  issueKindCount: number;
  isClean: boolean;
};

/*
 * Fixed order so the report reads the same way every time, most concrete
 * problem first. Contradictions and reversed dates are things the data
 * says about itself; missing links are things the data does not say yet.
 */
const KIND_ORDER: DataQualityIssueKind[] = [
  'date-range-reversed',
  'current-with-end-date',
  'multiple-current-roles',
  'role-state-unknown',
  'work-missing-dates',
  'work-without-skills',
  'skill-not-connected',
  'achievement-without-evidence',
  'evidence-without-links',
  'similar-records',
];

export function buildDataQualityReport(
  graph: CareerGraph | null,
): DataQualityReport {
  const experiences = toArray(
    graph?.experiences,
  );

  const projects = toArray(graph?.projects);
  const educations = toArray(
    graph?.educations,
  );

  const achievements = toArray(
    graph?.achievements,
  );

  const evidence = toArray(graph?.evidence);
  const userSkills = toArray(
    graph?.userSkills,
  );

  const issues: DataQualityIssue[] = [];

  const add = (
    kind: DataQualityIssueKind,
    message: string,
    entities: DataQualityEntity[],
  ) => {
    if (entities.length === 0) {
      return;
    }

    issues.push({
      id: kind,
      kind,
      message,
      entities: sortEntities(entities),
    });
  };

  /* --- dates that contradict themselves --- */

  const reversed = [
    ...collectReversedDates(
      experiences,
      'experience',
      getExperienceTitle,
    ),
    ...collectReversedDates(
      projects,
      'project',
      getProjectName,
    ),
    ...collectReversedDates(
      educations,
      'education',
      (item) =>
        getStringField(item, 'institution') ??
        'Education',
    ),
  ];

  add(
    'date-range-reversed',
    `${countPhrase(reversed.length, 'record')} ${reversed.length === 1 ? 'ends' : 'end'} before ${reversed.length === 1 ? 'it starts' : 'they start'}`,
    reversed,
  );

  /* --- current-state contradictions --- */

  const conflicting = experiences
    .filter(
      (item) =>
        getCareerState(item).basis ===
        'conflicting',
    )
    .map((item) =>
      toEntity(
        item,
        'experience',
        getExperienceTitle,
      ),
    )
    .filter(isEntity);

  add(
    'current-with-end-date',
    `${countPhrase(conflicting.length, 'role')} ${conflicting.length === 1 ? 'is' : 'are'} marked current but also ${conflicting.length === 1 ? 'has' : 'have'} an end date`,
    conflicting,
  );

  /* --- more than one role marked current --- */

  const current = experiences
    .filter(
      (item) =>
        getCareerState(item).state ===
        'current',
    )
    .map((item) =>
      toEntity(
        item,
        'experience',
        getExperienceTitle,
      ),
    )
    .filter(isEntity);

  if (current.length > 1) {
    add(
      'multiple-current-roles',
      `${current.length} roles are current at the same time`,
      current,
    );
  }

  /*
   * --- roles the data says nothing about ---
   *
   * A start date but no end date and no ongoing marker: ingestion could
   * not read the end date, so the record states neither that the role
   * ended nor that it continues. Surfaced rather than guessed at. This is
   * the check that consumes `basis` — the state alone cannot express it.
   */
  const stateUnknown = experiences
    .filter((item) => {
      const { basis } = getCareerState(item);

      return (
        basis === 'no-signal' &&
        getTimeField(item, 'startDate') !==
          null
      );
    })
    .map((item) =>
      toEntity(
        item,
        'experience',
        getExperienceTitle,
      ),
    )
    .filter(isEntity);

  add(
    'role-state-unknown',
    `${countPhrase(stateUnknown.length, 'role')} ${stateUnknown.length === 1 ? "doesn't" : "don't"} say whether ${stateUnknown.length === 1 ? "it's" : "they're"} still current`,
    stateUnknown,
  );

  /* --- work records with no dates at all --- */

  const undated = [
    ...collectUndated(
      experiences,
      'experience',
      getExperienceTitle,
    ),
    ...collectUndated(
      projects,
      'project',
      getProjectName,
    ),
  ];

  add(
    'work-missing-dates',
    `${countPhrase(undated.length, 'work record')} ${undated.length === 1 ? 'has' : 'have'} no dates yet`,
    undated,
  );

  /* --- work records not linked to any skill --- */

  const unskilled = [
    ...collectUnskilled(
      experiences,
      'experience',
      getExperienceTitle,
    ),
    ...collectUnskilled(
      projects,
      'project',
      getProjectName,
    ),
  ];

  add(
    'work-without-skills',
    `${countPhrase(unskilled.length, 'work record')} ${unskilled.length === 1 ? "doesn't" : "don't"} list the skills used`,
    unskilled,
  );

  /* --- skills attached to no work record --- */

  const usedSkillIds = new Set<string>();

  [...experiences, ...projects].forEach(
    (record) => {
      getLinkedSkillIds(record).forEach((id) =>
        usedSkillIds.add(id),
      );
    },
  );

  const orphanSkills: DataQualityEntity[] = [];

  const seenSkillIds = new Set<string>();

  userSkills.forEach((item) => {
    const skillId = readSkillId(item);

    if (
      skillId === null ||
      usedSkillIds.has(skillId) ||
      seenSkillIds.has(skillId)
    ) {
      return;
    }

    seenSkillIds.add(skillId);

    orphanSkills.push({
      entityType: 'skill',
      entityId: skillId,
      label: getSkillName(item),
    });
  });

  add(
    'skill-not-connected',
    `${countPhrase(orphanSkills.length, 'skill')} ${orphanSkills.length === 1 ? "isn't" : "aren't"} connected to a role or project yet`,
    orphanSkills,
  );

  /* --- achievements with nothing behind them --- */

  const unbacked = achievements
    .filter(
      (item) =>
        toArray(
          getObjectField(item, 'evidence'),
        ).length === 0,
    )
    .map((item) =>
      toEntity(
        item,
        'achievement',
        getAchievementTitle,
      ),
    )
    .filter(isEntity);

  add(
    'achievement-without-evidence',
    `${countPhrase(unbacked.length, 'achievement')} ${unbacked.length === 1 ? "doesn't" : "don't"} have supporting evidence yet`,
    unbacked,
  );

  /* --- evidence that supports nothing --- */

  const danglingEvidence = evidence
    .filter((item) =>
      (
        [
          'skills',
          'experiences',
          'projects',
          'achievements',
          'educations',
        ] as const
      ).every(
        (key) =>
          toArray(getObjectField(item, key))
            .length === 0,
      ),
    )
    .map((item) =>
      toEntity(item, 'evidence', (record) =>
        getStringField(record, 'title') ??
        'Evidence',
      ),
    )
    .filter(isEntity);

  add(
    'evidence-without-links',
    `${countPhrase(danglingEvidence.length, 'evidence record')} ${danglingEvidence.length === 1 ? "isn't" : "aren't"} linked to any career record`,
    danglingEvidence,
  );

  /*
   * --- records that read alike but are distinct rows ---
   *
   * Reported, never merged. Two Skill rows named "Python" are two
   * identities as far as the database is concerned, and collapsing them
   * here would bury a normalisation decision in a display layer.
   */
  const lookalikes = [
    /*
     * Experiences group on title AND company: holding "Software Engineer"
     * at two employers is an ordinary career, not a duplicate, and
     * reporting it would be permanent noise.
     *
     * Skills are deliberately absent. Skill.normalizedName is globally
     * unique and is the same normalisation this grouping applies, so two
     * Skill rows reading alike cannot exist — checking for them would be
     * detecting an impossible state.
     */
    ...findLookalikes(
      experiences,
      'experience',
      getExperienceTitle,
      (item) =>
        getStringField(item, 'title'),
      (item) =>
        getStringField(
          getObjectField(item, 'company'),
          'name',
        ),
    ),
    ...findLookalikes(
      projects,
      'project',
      getProjectName,
      (item) => getStringField(item, 'name'),
      () => null,
    ),
  ];

  add(
    'similar-records',
    `${countPhrase(lookalikes.length, 'record')} share a name with another record — worth checking they aren't duplicates`,
    lookalikes,
  );

  return finalise(issues);
}

/*
 * Groups records that read alike and returns every member of any group
 * holding more than one distinct id.
 *
 * `readKey` reads the RAW field rather than the display label, because the
 * label readers substitute "Experience"/"Project" when the field is
 * absent — grouping on those would report two nameless records as sharing
 * a name, which is a false claim about the data. Records with no key are
 * skipped.
 *
 * `readContext` narrows the key (company for a role) and doubles as the
 * disambiguating text the UI shows, so two same-titled rows can be told
 * apart on screen.
 *
 * Name comparison decides only what to SHOW. Nothing is matched or merged
 * by it — every member keeps its own id.
 */
function findLookalikes(
  records: unknown[],
  entityType: DetailEntityType,
  readLabel: (item: unknown) => string,
  readKey: (item: unknown) => string | null,
  readContext: (item: unknown) => string | null,
): DataQualityEntity[] {
  const byKey = new Map<
    string,
    DataQualityEntity[]
  >();

  records.forEach((item) => {
    const entityId = getStringField(
      item,
      'id',
    );

    const rawKey = readKey(item);

    if (entityId === null || rawKey === null) {
      return;
    }

    const context = readContext(item);

    const key = [
      rawKey.trim().toLowerCase(),
      context?.trim().toLowerCase() ?? '',
    ].join('\u0000');

    const bucket = byKey.get(key) ?? [];

    if (
      bucket.some(
        (entry) => entry.entityId === entityId,
      )
    ) {
      return;
    }

    bucket.push({
      entityType,
      entityId,
      label: context
        ? `${readLabel(item)} · ${context}`
        : readLabel(item),
    });

    byKey.set(key, bucket);
  });

  const out: DataQualityEntity[] = [];

  byKey.forEach((bucket) => {
    if (bucket.length > 1) {
      out.push(...bucket);
    }
  });

  return out;
}

/*
 * A skill counts only when the payload carries a real Skill.id. Falling
 * back to array position would make the report depend on row order. That
 * order is now fixed by getGraph, but position would still be the wrong
 * key: it identifies a slot rather than a skill, so any change to the
 * query would silently re-point the finding at a different record.
 */
function readSkillId(
  item: unknown,
): string | null {
  return (
    getStringField(item, 'skillId') ??
    getStringField(
      getObjectField(item, 'skill'),
      'id',
    )
  );
}

function finalise(
  issues: DataQualityIssue[],
): DataQualityReport {
  const ordered = [...issues].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) -
      KIND_ORDER.indexOf(b.kind),
  );

  return {
    issues: ordered,
    issueKindCount: ordered.length,
    isClean: ordered.length === 0,
  };
}

/*
 * ----------------------------------------------------------------------
 * HELPERS
 * ----------------------------------------------------------------------
 */

function collectReversedDates(
  records: unknown[],
  entityType: DetailEntityType,
  readLabel: (item: unknown) => string,
): DataQualityEntity[] {
  return records
    .filter((item) => {
      const start = getTimeField(
        item,
        'startDate',
      );

      const end = getTimeField(
        item,
        'endDate',
      );

      return (
        start !== null &&
        end !== null &&
        end < start
      );
    })
    .map((item) =>
      toEntity(item, entityType, readLabel),
    )
    .filter(isEntity);
}

function collectUnskilled(
  records: unknown[],
  entityType: DetailEntityType,
  readLabel: (item: unknown) => string,
): DataQualityEntity[] {
  return records
    .filter(
      (item) =>
        getLinkedSkillIds(item).length === 0,
    )
    .map((item) =>
      toEntity(item, entityType, readLabel),
    )
    .filter(isEntity);
}

function collectUndated(
  records: unknown[],
  entityType: DetailEntityType,
  readLabel: (item: unknown) => string,
): DataQualityEntity[] {
  return records
    .filter(
      (item) =>
        getTimeField(item, 'startDate') ===
          null &&
        getTimeField(item, 'endDate') === null,
    )
    .map((item) =>
      toEntity(item, entityType, readLabel),
    )
    .filter(isEntity);
}

function toEntity(
  item: unknown,
  entityType: DetailEntityType,
  readLabel: (item: unknown) => string,
): DataQualityEntity | null {
  const entityId = getStringField(item, 'id');

  if (entityId === null) {
    return null;
  }

  return {
    entityType,
    entityId,
    label: readLabel(item),
  };
}

function isEntity(
  entity: DataQualityEntity | null,
): entity is DataQualityEntity {
  return entity !== null;
}

function sortEntities(
  entities: DataQualityEntity[],
): DataQualityEntity[] {
  return [...entities].sort((a, b) => {
    if (a.label !== b.label) {
      return a.label < b.label ? -1 : 1;
    }

    return a.entityId < b.entityId
      ? -1
      : a.entityId > b.entityId
        ? 1
        : 0;
  });
}

function countPhrase(
  count: number,
  noun: string,
) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
