/*
 * Evidence projection.
 *
 * Answers "what supports this claim?" from the existing /career-graph
 * response. A deterministic, read-only projection — no new API call, no
 * derived facts.
 *
 * Scope for v1 is deliberately narrow. Support is only ever Unsupported or
 * Supported. Corroborated and Demonstrated are NOT derivable from the
 * current schema (there is nothing that distinguishes an artifact from a
 * claim, and every resume-ingested entity has exactly one RESUME evidence
 * row), so they are not represented. Likewise the Fact / Inferred /
 * Recommended provenance states, which have no backing columns.
 *
 * Every relationship below is resolved by stable database id. Display
 * names are carried for rendering only and are never used for matching.
 */

import type { CareerGraph } from '../api/career-graph';

import {
  getObjectField,
  getStringField,
  getTimeField,
  toArray,
} from './graph-fields';

export type EvidenceEntityType =
  | 'skill'
  | 'experience'
  | 'project'
  | 'achievement'
  | 'education';

/** v1 vocabulary. Nothing stronger is derivable yet. */
export type SupportState =
  | 'unsupported'
  | 'supported';

export type EvidenceLink = {
  /** Stable id of the related entity. */
  entityId: string;
  entityType: EvidenceEntityType;
  /** Display only. Null when the API did not hydrate a name. */
  name: string | null;
};

export type EvidenceSource = {
  /** Raw EvidenceSourceType from the payload. */
  sourceType: string | null;
  /** Human label; unrecognised values pass through verbatim. */
  label: string;
  resumeImportId: string | null;
  /** Only from the hydrated relation — never parsed out of the title. */
  fileName: string | null;
  resumeStatus: string | null;
  /*
   * True only when this is RESUME evidence whose import is CONFIRMED.
   * Ingestion refuses to run on anything else, but this checks the payload
   * rather than relying on that invariant.
   */
  isConfirmedResume: boolean;
  /*
   * A sentence that is safe to show, or null. Never says verified, proven
   * or demonstrated.
   */
  statement: string | null;
};

export type EvidenceView = {
  id: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  /** When the thing happened. Null for resume-import evidence. */
  occurredAt: string | null;
  /** When the record was captured. Never a career date. */
  capturedAt: string | null;
  source: EvidenceSource;
  links: EvidenceLink[];
  linkedSkillIds: string[];
  linkedExperienceIds: string[];
  linkedProjectIds: string[];
  linkedAchievementIds: string[];
  totalLinks: number;
};

export type EvidenceIndex = {
  /** All evidence, most recently captured first. */
  records: EvidenceView[];
  byId: Record<string, EvidenceView>;
  /** entity id -> evidence ids, keyed by entity type. */
  bySkillId: Record<string, string[]>;
  byExperienceId: Record<string, string[]>;
  byProjectId: Record<string, string[]>;
  byAchievementId: Record<string, string[]>;
  counts: {
    records: number;
    linkedSkills: number;
    linkedExperiences: number;
    linkedProjects: number;
    linkedAchievements: number;
  };
};

export type EntitySupport = {
  entityType: EvidenceEntityType;
  entityId: string;
  state: SupportState;
  label: string;
  evidenceCount: number;
  evidence: EvidenceView[];
  /*
   * Set when the absence of evidence is structural rather than a gap in
   * the user's data.
   */
  note: string | null;
};

export type UnsupportedEntity = {
  entityType: EvidenceEntityType;
  entityId: string;
  name: string;
  note: string | null;
};

const SOURCE_LABELS: Record<string, string> =
  {
    MANUAL: 'Added manually',
    RESUME: 'Resume',
    GITHUB: 'GitHub',
    PORTFOLIO: 'Portfolio',
    LINKEDIN: 'LinkedIn',
    CERTIFICATION: 'Certification',
    DOCUMENT: 'Document',
    OTHER: 'Other source',
  };

/*
 * Education has no evidence relation in the schema — there is no
 * EvidenceEducation table — so it can never be supported today. That is a
 * structural gap, not a missing document, and it is reported as such.
 */
const EDUCATION_NOTE =
  'Education records cannot carry evidence yet.';

const CONFIRMED_RESUME_STATEMENT =
  'Confirmed from a resume you reviewed';

export function buildEvidenceIndex(
  graph: CareerGraph | null,
): EvidenceIndex {
  const records: EvidenceView[] = toArray(
    graph?.evidence,
  )
    .map(readEvidence)
    .filter(
      (record): record is EvidenceView =>
        record !== null,
    )
    .sort(compareRecords);

  const byId: Record<string, EvidenceView> =
    {};

  const bySkillId: Record<string, string[]> =
    {};

  const byExperienceId: Record<
    string,
    string[]
  > = {};

  const byProjectId: Record<
    string,
    string[]
  > = {};

  const byAchievementId: Record<
    string,
    string[]
  > = {};

  records.forEach((record) => {
    byId[record.id] = record;

    record.linkedSkillIds.forEach((id) =>
      push(bySkillId, id, record.id),
    );

    record.linkedExperienceIds.forEach((id) =>
      push(byExperienceId, id, record.id),
    );

    record.linkedProjectIds.forEach((id) =>
      push(byProjectId, id, record.id),
    );

    record.linkedAchievementIds.forEach((id) =>
      push(byAchievementId, id, record.id),
    );
  });

  return {
    records,
    byId,
    bySkillId,
    byExperienceId,
    byProjectId,
    byAchievementId,
    counts: {
      records: records.length,
      linkedSkills:
        Object.keys(bySkillId).length,
      linkedExperiences: Object.keys(
        byExperienceId,
      ).length,
      linkedProjects:
        Object.keys(byProjectId).length,
      linkedAchievements: Object.keys(
        byAchievementId,
      ).length,
    },
  };
}

/*
 * ----------------------------------------------------------------------
 * LOOKUPS — all by stable id
 * ----------------------------------------------------------------------
 */

export function getEvidenceForSkill(
  index: EvidenceIndex,
  skillId: string,
): EvidenceView[] {
  return resolve(index, index.bySkillId, skillId);
}

export function getEvidenceForExperience(
  index: EvidenceIndex,
  experienceId: string,
): EvidenceView[] {
  return resolve(
    index,
    index.byExperienceId,
    experienceId,
  );
}

export function getEvidenceForProject(
  index: EvidenceIndex,
  projectId: string,
): EvidenceView[] {
  return resolve(
    index,
    index.byProjectId,
    projectId,
  );
}

export function getEvidenceForAchievement(
  index: EvidenceIndex,
  achievementId: string,
): EvidenceView[] {
  return resolve(
    index,
    index.byAchievementId,
    achievementId,
  );
}

/*
 * Always empty. Kept so callers can treat education uniformly instead of
 * special-casing it into silence.
 */
export function getEvidenceForEducation(): EvidenceView[] {
  return [];
}

export function getEvidenceForEntity(
  index: EvidenceIndex,
  entityType: EvidenceEntityType,
  entityId: string,
): EvidenceView[] {
  switch (entityType) {
    case 'skill':
      return getEvidenceForSkill(
        index,
        entityId,
      );

    case 'experience':
      return getEvidenceForExperience(
        index,
        entityId,
      );

    case 'project':
      return getEvidenceForProject(
        index,
        entityId,
      );

    case 'achievement':
      return getEvidenceForAchievement(
        index,
        entityId,
      );

    case 'education':
      return getEvidenceForEducation();
  }
}

/*
 * ----------------------------------------------------------------------
 * SUPPORT STATE
 * ----------------------------------------------------------------------
 */

export function getSupportState(
  index: EvidenceIndex,
  entityType: EvidenceEntityType,
  entityId: string,
): SupportState {
  return getEvidenceForEntity(
    index,
    entityType,
    entityId,
  ).length > 0
    ? 'supported'
    : 'unsupported';
}

export function getSupportSummary(
  index: EvidenceIndex,
  entityType: EvidenceEntityType,
  entityId: string,
): EntitySupport {
  const evidence = getEvidenceForEntity(
    index,
    entityType,
    entityId,
  );

  const state: SupportState =
    evidence.length > 0
      ? 'supported'
      : 'unsupported';

  return {
    entityType,
    entityId,
    state,
    label: getSupportLabel(state),
    evidenceCount: evidence.length,
    evidence,
    note:
      entityType === 'education'
        ? EDUCATION_NOTE
        : null,
  };
}

export function getSupportLabel(
  state: SupportState,
) {
  return state === 'supported'
    ? 'Supported'
    : 'Unsupported';
}

/*
 * Every entity in the graph with no evidence behind it, in a stable order.
 * Education is always here, flagged with the structural reason.
 */
export function getUnsupportedEntities(
  graph: CareerGraph | null,
  index: EvidenceIndex,
): UnsupportedEntity[] {
  const out: UnsupportedEntity[] = [];

  const collect = (
    entityType: EvidenceEntityType,
    items: unknown[],
    readId: (item: unknown) => string | null,
    readName: (item: unknown) => string,
    note: string | null,
  ) => {
    items.forEach((item) => {
      const entityId = readId(item);

      if (entityId === null) {
        return;
      }

      if (
        getEvidenceForEntity(
          index,
          entityType,
          entityId,
        ).length > 0
      ) {
        return;
      }

      out.push({
        entityType,
        entityId,
        name: readName(item),
        note,
      });
    });
  };

  collect(
    'skill',
    toArray(graph?.userSkills),
    (item) =>
      getStringField(item, 'skillId') ??
      getStringField(
        getObjectField(item, 'skill'),
        'id',
      ),
    (item) =>
      getStringField(
        getObjectField(item, 'skill'),
        'name',
      ) ?? 'Skill',
    null,
  );

  collect(
    'experience',
    toArray(graph?.experiences),
    (item) => getStringField(item, 'id'),
    (item) =>
      getStringField(item, 'title') ??
      'Experience',
    null,
  );

  collect(
    'project',
    toArray(graph?.projects),
    (item) => getStringField(item, 'id'),
    (item) =>
      getStringField(item, 'name') ??
      'Project',
    null,
  );

  collect(
    'achievement',
    toArray(graph?.achievements),
    (item) => getStringField(item, 'id'),
    (item) =>
      getStringField(item, 'title') ??
      'Achievement',
    null,
  );

  collect(
    'education',
    toArray(graph?.educations),
    (item) => getStringField(item, 'id'),
    (item) =>
      getStringField(item, 'institution') ??
      'Education',
    EDUCATION_NOTE,
  );

  return out;
}

/*
 * ----------------------------------------------------------------------
 * READING
 * ----------------------------------------------------------------------
 */

function readEvidence(
  record: unknown,
): EvidenceView | null {
  const id = getStringField(record, 'id');
  const title = getStringField(
    record,
    'title',
  );

  if (id === null || title === null) {
    return null;
  }

  const links: EvidenceLink[] = [
    ...readLinks(
      record,
      'skills',
      'skillId',
      'skill',
      'name',
      'skill',
    ),
    ...readLinks(
      record,
      'experiences',
      'experienceId',
      'experience',
      'title',
      'experience',
    ),
    ...readLinks(
      record,
      'projects',
      'projectId',
      'project',
      'name',
      'project',
    ),
    ...readLinks(
      record,
      'achievements',
      'achievementId',
      'achievement',
      'title',
      'achievement',
    ),
  ];

  const idsOf = (
    entityType: EvidenceEntityType,
  ) =>
    links
      .filter(
        (link) =>
          link.entityType === entityType,
      )
      .map((link) => link.entityId);

  return {
    id,
    title,
    description: getStringField(
      record,
      'description',
    ),
    sourceUrl: getStringField(
      record,
      'sourceUrl',
    ),
    externalId: getStringField(
      record,
      'externalId',
    ),
    occurredAt: getStringField(
      record,
      'occurredAt',
    ),
    capturedAt: getStringField(
      record,
      'capturedAt',
    ),
    source: readSource(record),
    links,
    linkedSkillIds: idsOf('skill'),
    linkedExperienceIds: idsOf('experience'),
    linkedProjectIds: idsOf('project'),
    linkedAchievementIds: idsOf('achievement'),
    totalLinks: links.length,
  };
}

/*
 * Reads join rows. The id comes from the join row's own foreign key, which
 * is always present; the name comes from the hydrated relation and stays
 * null when the API did not include one. A row with no id is skipped
 * rather than guessed at.
 */
function readLinks(
  record: unknown,
  arrayKey: string,
  idKey: string,
  relationKey: string,
  nameKey: string,
  entityType: EvidenceEntityType,
): EvidenceLink[] {
  const seen = new Set<string>();

  const links: EvidenceLink[] = [];

  toArray(
    getObjectField(record, arrayKey),
  ).forEach((row) => {
    const relation = getObjectField(
      row,
      relationKey,
    );

    const entityId =
      getStringField(row, idKey) ??
      getStringField(relation, 'id');

    if (
      entityId === null ||
      seen.has(entityId)
    ) {
      return;
    }

    seen.add(entityId);

    links.push({
      entityId,
      entityType,
      name: getStringField(
        relation,
        nameKey,
      ),
    });
  });

  return links;
}

function readSource(
  record: unknown,
): EvidenceSource {
  const sourceType = getStringField(
    record,
    'sourceType',
  );

  const resumeImport = getObjectField(
    record,
    'resumeImport',
  );

  const resumeStatus = getStringField(
    resumeImport,
    'status',
  );

  /*
   * Only the hydrated relation can name the file. Evidence.title happens
   * to embed it ("Resume: cv.pdf") but parsing a display string would be
   * inventing structure, so an un-hydrated import stays nameless.
   */
  const fileName = getStringField(
    resumeImport,
    'fileName',
  );

  const isConfirmedResume =
    sourceType === 'RESUME' &&
    resumeStatus === 'CONFIRMED';

  return {
    sourceType,
    label: sourceType
      ? SOURCE_LABELS[sourceType] ??
        sourceType
      : 'Source not recorded',
    resumeImportId: getStringField(
      record,
      'resumeImportId',
    ),
    fileName,
    resumeStatus,
    isConfirmedResume,
    statement: isConfirmedResume
      ? CONFIRMED_RESUME_STATEMENT
      : null,
  };
}

/*
 * ----------------------------------------------------------------------
 * HELPERS
 * ----------------------------------------------------------------------
 */

function push(
  target: Record<string, string[]>,
  key: string,
  value: string,
) {
  const existing = target[key];

  if (existing) {
    if (!existing.includes(value)) {
      existing.push(value);
    }

    return;
  }

  target[key] = [value];
}

function resolve(
  index: EvidenceIndex,
  map: Record<string, string[]>,
  entityId: string,
): EvidenceView[] {
  const ids = map[entityId];

  if (!ids) {
    return [];
  }

  return ids
    .map((id) => index.byId[id])
    .filter(
      (record): record is EvidenceView =>
        record !== undefined,
    );
}

/*
 * Most recently captured first. The chain ends on the id, so the
 * comparator is a total order and identical input always yields identical
 * output.
 */
function compareRecords(
  a: EvidenceView,
  b: EvidenceView,
) {
  const aTime =
    getTimeField(a, 'capturedAt') ??
    Number.NEGATIVE_INFINITY;

  const bTime =
    getTimeField(b, 'capturedAt') ??
    Number.NEGATIVE_INFINITY;

  if (aTime !== bTime) {
    return bTime - aTime;
  }

  if (a.title !== b.title) {
    return a.title < b.title ? -1 : 1;
  }

  if (a.id === b.id) {
    return 0;
  }

  return a.id < b.id ? -1 : 1;
}
