/*
 * Career timeline.
 *
 * A deterministic projection of the existing /career-graph response into an
 * ordered list of career events. No new API call, no derived facts: every
 * field below is copied or formatted from a record the API returned.
 *
 * Rules that matter:
 *   - A date is only ever read from the payload. Missing dates stay missing;
 *     undated records are separated out instead of being placed on the axis.
 *   - Ordering is a total order (it ends on the entity id), so records that
 *     share a date always come back in the same sequence.
 *   - Provenance comes from evidence rows linked to the record. Where the
 *     schema exposes no link, provenance is reported as unknown.
 */

import type { CareerGraph } from '../api/career-graph';

import {
  getBooleanField,
  getObjectField,
  getStringField,
  getTimeField,
  toArray,
} from './graph-fields';

export type TimelineItemType =
  | 'experience'
  | 'education'
  | 'project'
  | 'achievement'
  | 'evidence';

export type TimelineDate = {
  /** The value exactly as the API returned it. */
  iso: string;
  time: number;
  year: number;
  /** e.g. "Mar 2024" — a formatting of `iso`, never a guess. */
  label: string;
};

export type TimelineProvenance = {
  known: boolean;
  /** Distinct EvidenceSourceType values backing this item. */
  sources: string[];
  /** Evidence records this item was linked to. */
  evidenceIds: string[];
  label: string;
};

export type TimelineItem = {
  /** Stable across refreshes: `${type}:${entityId}`. */
  id: string;
  type: TimelineItemType;
  entityId: string;
  title: string;
  subtitle: string | null;
  start: TimelineDate | null;
  end: TimelineDate | null;
  isCurrent: boolean;
  /** True when the record carries at least one real date. */
  isDated: boolean;
  /** A moment (achievement, evidence) rather than a span. */
  isPointEvent: boolean;
  /** Null when the record has no dates at all. */
  rangeLabel: string | null;
  provenance: TimelineProvenance;
};

export type TimelineYearGroup = {
  year: number;
  items: TimelineItem[];
};

export type CareerTimeline = {
  /** Dated items, most recent first. */
  items: TimelineItem[];
  /** `items` bucketed by anchor year, most recent year first. */
  groups: TimelineYearGroup[];
  /** Records with no usable date. Never placed on the axis. */
  undated: TimelineItem[];
  counts: {
    total: number;
    dated: number;
    undated: number;
    byType: Record<TimelineItemType, number>;
  };
  /*
   * Evidence rows deliberately left off the timeline because they record
   * when we captured something, not when it happened. Surfaced so the UI
   * can be honest that the timeline is not the whole graph.
   */
  excludedEvidenceCount: number;
  isEmpty: boolean;
  hasUndated: boolean;
};

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/*
 * Tie-break priority for records sharing an anchor date. Fixed order so the
 * result never depends on the order the API happened to return rows in.
 */
const TYPE_ORDER: TimelineItemType[] = [
  'experience',
  'education',
  'project',
  'achievement',
  'evidence',
];

const SOURCE_LABELS: Record<string, string> =
  {
    RESUME: 'Resume',
    GITHUB: 'GitHub',
    MANUAL: 'Added manually',
    PORTFOLIO: 'Portfolio',
    LINKEDIN: 'LinkedIn',
    CERTIFICATION: 'Certification',
    DOCUMENT: 'Document',
    OTHER: 'Other source',
  };

export function buildCareerTimeline(
  graph: CareerGraph | null,
): CareerTimeline {
  const items: TimelineItem[] = [];

  let excludedEvidenceCount = 0;

  if (graph) {
    toArray(graph.experiences).forEach(
      (record, index) => {
        const item = buildExperienceItem(
          record,
          index,
        );

        if (item) {
          items.push(item);
        }
      },
    );

    toArray(graph.educations).forEach(
      (record, index) => {
        const item = buildEducationItem(
          record,
          index,
        );

        if (item) {
          items.push(item);
        }
      },
    );

    toArray(graph.projects).forEach(
      (record, index) => {
        const item = buildProjectItem(
          record,
          index,
        );

        if (item) {
          items.push(item);
        }
      },
    );

    toArray(graph.achievements).forEach(
      (record, index) => {
        const item = buildAchievementItem(
          record,
          index,
        );

        if (item) {
          items.push(item);
        }
      },
    );

    toArray(graph.evidence).forEach(
      (record, index) => {
        const item = buildEvidenceItem(
          record,
          index,
        );

        if (item) {
          items.push(item);
        } else {
          excludedEvidenceCount += 1;
        }
      },
    );
  }

  const dated = items
    .filter((item) => item.isDated)
    .sort(compareDated);

  const undated = items
    .filter((item) => !item.isDated)
    .sort(compareUndated);

  return {
    items: dated,
    groups: groupByYear(dated),
    undated,
    counts: {
      total: items.length,
      dated: dated.length,
      undated: undated.length,
      byType: countByType(items),
    },
    excludedEvidenceCount,
    isEmpty: items.length === 0,
    hasUndated: undated.length > 0,
  };
}

/*
 * ----------------------------------------------------------------------
 * ITEM BUILDERS
 * ----------------------------------------------------------------------
 */

function buildExperienceItem(
  record: unknown,
  index: number,
): TimelineItem | null {
  const title = getStringField(
    record,
    'title',
  );

  if (title === null) {
    return null;
  }

  const start = readDate(record, 'startDate');
  const end = readDate(record, 'endDate');

  const isCurrent = getBooleanField(
    record,
    'isCurrent',
  );

  return {
    id: `experience:${readEntityId(record, index)}`,
    type: 'experience',
    entityId: readEntityId(record, index),
    title,
    subtitle: getStringField(
      getObjectField(record, 'company'),
      'name',
    ),
    start,
    end,
    isCurrent,
    isDated:
      start !== null || end !== null,
    isPointEvent: false,
    rangeLabel: formatRange(
      start,
      end,
      isCurrent,
      false,
    ),
    provenance: readLinkedProvenance(record),
  };
}

function buildEducationItem(
  record: unknown,
  index: number,
): TimelineItem | null {
  const institution = getStringField(
    record,
    'institution',
  );

  if (institution === null) {
    return null;
  }

  const start = readDate(record, 'startDate');
  const end = readDate(record, 'endDate');

  const subtitle = [
    getStringField(record, 'degree'),
    getStringField(record, 'fieldOfStudy'),
  ]
    .filter(
      (part): part is string =>
        part !== null,
    )
    .join(' · ');

  return {
    id: `education:${readEntityId(record, index)}`,
    type: 'education',
    entityId: readEntityId(record, index),
    title: institution,
    subtitle:
      subtitle.length > 0 ? subtitle : null,
    start,
    end,
    isCurrent: false,
    isDated:
      start !== null || end !== null,
    isPointEvent: false,
    rangeLabel: formatRange(
      start,
      end,
      false,
      false,
    ),
    /*
     * Education carries no evidence relation in the schema, so there is
     * nothing to read. Reported as unknown rather than assumed to be
     * resume-sourced.
     */
    provenance: unknownProvenance(),
  };
}

function buildProjectItem(
  record: unknown,
  index: number,
): TimelineItem | null {
  const name = getStringField(
    record,
    'name',
  );

  if (name === null) {
    return null;
  }

  const start = readDate(record, 'startDate');
  const end = readDate(record, 'endDate');

  return {
    id: `project:${readEntityId(record, index)}`,
    type: 'project',
    entityId: readEntityId(record, index),
    title: name,
    subtitle: null,
    start,
    end,
    isCurrent: false,
    isDated:
      start !== null || end !== null,
    isPointEvent: false,
    rangeLabel: formatRange(
      start,
      end,
      false,
      false,
    ),
    provenance: readLinkedProvenance(record),
  };
}

function buildAchievementItem(
  record: unknown,
  index: number,
): TimelineItem | null {
  const title = getStringField(
    record,
    'title',
  );

  if (title === null) {
    return null;
  }

  const occurredAt = readDate(
    record,
    'occurredAt',
  );

  return {
    id: `achievement:${readEntityId(record, index)}`,
    type: 'achievement',
    entityId: readEntityId(record, index),
    title,
    subtitle: null,
    start: occurredAt,
    end: null,
    isCurrent: false,
    isDated: occurredAt !== null,
    isPointEvent: true,
    rangeLabel: formatRange(
      occurredAt,
      null,
      false,
      true,
    ),
    provenance: readLinkedProvenance(record),
  };
}

/*
 * Evidence only earns a place on the timeline when it says when something
 * happened (`occurredAt`). `capturedAt` is when the record was ingested —
 * resume evidence would otherwise land on the axis at import time as a
 * career event that never occurred.
 */
function buildEvidenceItem(
  record: unknown,
  index: number,
): TimelineItem | null {
  const title = getStringField(
    record,
    'title',
  );

  const occurredAt = readDate(
    record,
    'occurredAt',
  );

  if (title === null || occurredAt === null) {
    return null;
  }

  const sourceType = getStringField(
    record,
    'sourceType',
  );

  const entityId = readEntityId(
    record,
    index,
  );

  return {
    id: `evidence:${entityId}`,
    type: 'evidence',
    entityId,
    title,
    subtitle: sourceType
      ? formatSourceLabel(sourceType)
      : null,
    start: occurredAt,
    end: null,
    isCurrent: false,
    isDated: true,
    isPointEvent: true,
    rangeLabel: formatRange(
      occurredAt,
      null,
      false,
      true,
    ),
    provenance: sourceType
      ? {
          known: true,
          sources: [sourceType],
          evidenceIds: [entityId],
          label: `From ${formatSourceLabel(sourceType)}`,
        }
      : unknownProvenance(),
  };
}

/*
 * ----------------------------------------------------------------------
 * PROVENANCE
 * ----------------------------------------------------------------------
 */

/*
 * Experiences, projects and achievements arrive with their linked evidence
 * hydrated (`evidence: [{ evidence: { ... } }]`). Anything with no link is
 * left unknown.
 */
function readLinkedProvenance(
  record: unknown,
): TimelineProvenance {
  const sources: string[] = [];
  const evidenceIds: string[] = [];

  toArray(
    getObjectField(record, 'evidence'),
  ).forEach((link) => {
    const evidence =
      getObjectField(link, 'evidence') ??
      link;

    const evidenceId = getStringField(
      evidence,
      'id',
    );

    const sourceType = getStringField(
      evidence,
      'sourceType',
    );

    if (
      evidenceId !== null &&
      !evidenceIds.includes(evidenceId)
    ) {
      evidenceIds.push(evidenceId);
    }

    if (
      sourceType !== null &&
      !sources.includes(sourceType)
    ) {
      sources.push(sourceType);
    }
  });

  if (sources.length === 0) {
    return {
      known: false,
      sources: [],
      evidenceIds,
      label: 'Source not recorded',
    };
  }

  const labels = [...sources]
    .sort()
    .map(formatSourceLabel);

  return {
    known: true,
    sources: [...sources].sort(),
    evidenceIds,
    label: `From ${labels.join(', ')}`,
  };
}

function unknownProvenance(): TimelineProvenance {
  return {
    known: false,
    sources: [],
    evidenceIds: [],
    label: 'Source not recorded',
  };
}

/** Unrecognised source types pass through verbatim rather than be relabelled. */
function formatSourceLabel(
  sourceType: string,
) {
  return (
    SOURCE_LABELS[sourceType] ?? sourceType
  );
}

/*
 * ----------------------------------------------------------------------
 * DATES
 * ----------------------------------------------------------------------
 */

function readDate(
  record: unknown,
  key: string,
): TimelineDate | null {
  const iso = getStringField(record, key);
  const time = getTimeField(record, key);

  if (iso === null || time === null) {
    return null;
  }

  const date = new Date(time);

  return {
    iso,
    time,
    year: date.getUTCFullYear(),
    label: `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
  };
}

/*
 * "Present" is only ever printed when the record actually says isCurrent.
 * A start with no end and no flag becomes "From <date>", because the
 * payload does not claim the span is still open.
 */
function formatRange(
  start: TimelineDate | null,
  end: TimelineDate | null,
  isCurrent: boolean,
  isPointEvent: boolean,
): string | null {
  if (isPointEvent) {
    return start ? start.label : null;
  }

  if (start && isCurrent) {
    return `${start.label} — Present`;
  }

  if (start && end) {
    return start.label === end.label
      ? start.label
      : `${start.label} — ${end.label}`;
  }

  if (start) {
    return `From ${start.label}`;
  }

  if (end) {
    return `Until ${end.label}`;
  }

  if (isCurrent) {
    return 'Current';
  }

  return null;
}

/*
 * ----------------------------------------------------------------------
 * ORDERING
 * ----------------------------------------------------------------------
 */

/** Start date if present, otherwise the end date. Dated items always have one. */
function getAnchorTime(item: TimelineItem) {
  return (
    item.start?.time ??
    item.end?.time ??
    Number.NEGATIVE_INFINITY
  );
}

function getAnchorYear(item: TimelineItem) {
  return (
    item.start?.year ?? item.end?.year ?? 0
  );
}

/*
 * Most recent first. `isCurrent` is carried on the item and rendered as
 * "Present" rather than being allowed to distort chronology. The chain ends
 * on the entity id, so the comparator is a total order: same-date events
 * cannot reorder between renders.
 */
function compareDated(
  a: TimelineItem,
  b: TimelineItem,
) {
  const anchorDelta =
    getAnchorTime(b) - getAnchorTime(a);

  if (anchorDelta !== 0) {
    return anchorDelta;
  }

  const endDelta =
    (b.end?.time ?? getAnchorTime(b)) -
    (a.end?.time ?? getAnchorTime(a));

  if (endDelta !== 0) {
    return endDelta;
  }

  return compareUndated(a, b);
}

function compareUndated(
  a: TimelineItem,
  b: TimelineItem,
) {
  const typeDelta =
    TYPE_ORDER.indexOf(a.type) -
    TYPE_ORDER.indexOf(b.type);

  if (typeDelta !== 0) {
    return typeDelta;
  }

  if (a.title !== b.title) {
    return a.title < b.title ? -1 : 1;
  }

  if (a.entityId === b.entityId) {
    return 0;
  }

  return a.entityId < b.entityId ? -1 : 1;
}

function groupByYear(
  items: TimelineItem[],
): TimelineYearGroup[] {
  const groups: TimelineYearGroup[] = [];

  items.forEach((item) => {
    const year = getAnchorYear(item);

    const current =
      groups.length > 0
        ? groups[groups.length - 1]
        : null;

    if (current && current.year === year) {
      current.items.push(item);

      return;
    }

    groups.push({ year, items: [item] });
  });

  return groups;
}

function countByType(
  items: TimelineItem[],
): Record<TimelineItemType, number> {
  const counts: Record<
    TimelineItemType,
    number
  > = {
    experience: 0,
    education: 0,
    project: 0,
    achievement: 0,
    evidence: 0,
  };

  items.forEach((item) => {
    counts[item.type] += 1;
  });

  return counts;
}

/*
 * Falls back to the record's position only when the payload has no id, so a
 * malformed row still gets a stable key instead of colliding with others.
 */
function readEntityId(
  record: unknown,
  index: number,
) {
  return (
    getStringField(record, 'id') ??
    `index-${index}`
  );
}

export function getTimelineTypeLabel(
  type: TimelineItemType,
) {
  switch (type) {
    case 'experience':
      return 'Work';

    case 'education':
      return 'Education';

    case 'project':
      return 'Project';

    case 'achievement':
      return 'Achievement';

    case 'evidence':
      return 'Event';
  }
}
