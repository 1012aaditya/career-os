/*
 * Entity relationships, with semantics.
 *
 * Replaces a flat "CONNECTED TO" list with grouped, named relationships:
 * a skill is USED IN work, a project USES SKILLS, an achievement is PART OF
 * a role. The heading states what the relationship actually is, so the
 * detail sheet explains structure rather than listing neighbours.
 *
 * Three rules govern everything here:
 *
 *   1. A group is emitted only when it has members. There are no empty
 *      sections and no "0 related records" rows.
 *   2. Every relationship is resolved by stable database id, read from a
 *      join row the API actually returned. Nothing is matched on a name,
 *      and nothing is inferred from similar text.
 *   3. Ordering never depends on payload position. getGraph applies no
 *      ORDER BY to nested relations, so row order is not stable between
 *      requests; every group is sorted by label then id.
 *
 * Evidence is deliberately absent here. "What supports this?" is answered
 * by Evidence Mode directly below these groups, with a support state and
 * the full provenance of each record; repeating it as a bare title would
 * be the same list twice.
 *
 * Unlike the graph canvas, this projection is not capped: the map draws at
 * most GRAPH_CAPS.skill skills, but a project that uses twenty of them
 * yields all twenty groups items here. The sheet renders a first page and
 * discloses the remainder, so nothing is silently dropped at either layer.
 */

import type { CareerGraph } from '../api/career-graph';

import {
  getObjectField,
  getStringField,
  toArray,
} from './graph-fields';

import {
  getAchievementTitle,
  getExperienceTitle,
  getProjectName,
  getSkillName,
  type DetailEntityType,
  type DetailSelection,
} from './graph-model';

export type RelationGroupKind =
  | 'uses-skills'
  | 'used-in'
  | 'related-projects'
  | 'part-of'
  | 'achievements';

export type RelationItem = {
  entityType: DetailEntityType;
  /** Stable database id of the related record. */
  entityId: string;
  /** Display only — never used to establish the relationship. */
  label: string;
};

export type RelationGroup = {
  kind: RelationGroupKind;
  /** Semantic heading, e.g. "USED IN", "PART OF". */
  title: string;
  items: RelationItem[];
};

const GROUP_TITLES: Record<
  RelationGroupKind,
  string
> = {
  'uses-skills': 'USES SKILLS',
  'used-in': 'USED IN',
  'related-projects': 'RELATED PROJECTS',
  'part-of': 'PART OF',
  achievements: 'ACHIEVEMENTS',
};

/** Heading for a kind, for callers that render groups themselves. */
export function getRelationGroupTitle(
  kind: RelationGroupKind,
) {
  return GROUP_TITLES[kind];
}

export function getEntityRelations(
  selection: DetailSelection,
  graph: CareerGraph | null,
): RelationGroup[] {
  switch (selection.type) {
    case 'skill':
      return buildGroups([
        usedIn(graph, selection.entityIds),
      ]);

    case 'experience':
      return buildGroups(
        experienceGroups(
          graph,
          selection.entityIds,
        ),
      );

    case 'project':
      return buildGroups(
        projectGroups(
          graph,
          selection.entityIds,
        ),
      );

    case 'achievement':
      return buildGroups([
        partOfForAchievement(
          graph,
          selection.entityIds,
        ),
      ]);

    /*
     * An evidence record's relationships are its provenance, which
     * Evidence Mode renders in full. Nothing to add structurally.
     */
    case 'evidence':
      return [];

    /*
     * Education carries no join of any kind in the schema — no evidence
     * relation, no skill relation — so there is genuinely nothing to
     * relate it to. An empty result is the honest answer, and the UI is
     * expected to say so rather than render an empty section.
     */
    case 'education':
    case 'person':
      return [];
  }
}

/*
 * ----------------------------------------------------------------------
 * PER-TYPE GROUPS
 * ----------------------------------------------------------------------
 */

/** Work records that reference any of these Skill.ids. */
function usedIn(
  graph: CareerGraph | null,
  skillIds: string[],
): RelationGroup {
  const items: RelationItem[] = [];

  toArray(graph?.experiences).forEach(
    (experience) => {
      if (
        !referencesSkill(experience, skillIds)
      ) {
        return;
      }

      pushItem(items, {
        entityType: 'experience',
        entityId:
          getStringField(experience, 'id') ??
          '',
        label:
          getExperienceTitle(experience),
      });
    },
  );

  toArray(graph?.projects).forEach(
    (project) => {
      if (
        !referencesSkill(project, skillIds)
      ) {
        return;
      }

      pushItem(items, {
        entityType: 'project',
        entityId:
          getStringField(project, 'id') ?? '',
        label: getProjectName(project),
      });
    },
  );

  return { kind: 'used-in', title: GROUP_TITLES['used-in'], items };
}

function experienceGroups(
  graph: CareerGraph | null,
  entityIds: string[],
): RelationGroup[] {
  const experience = findById(
    graph?.experiences,
    entityIds[0] ?? '',
  );

  return [
    skillsUsedBy(experience),
    /*
     * ExperienceProject and ExperienceAchievement are declared in the
     * schema and hydrated by the API, but resume ingestion never writes
     * them — the extraction payload has no field linking a project or an
     * achievement to a specific role. They are read here so the sheet is
     * correct the moment such data exists, and produce no group until
     * then. Nothing is inferred to fill the gap.
     */
    linkedRecords(
      experience,
      'projects',
      'project',
      'projectId',
      'project',
      getProjectName,
      'related-projects',
    ),
    linkedRecords(
      experience,
      'achievements',
      'achievement',
      'achievementId',
      'achievement',
      getAchievementTitle,
      'achievements',
    ),
  ];
}

function projectGroups(
  graph: CareerGraph | null,
  entityIds: string[],
): RelationGroup[] {
  const projectId = entityIds[0] ?? '';

  const project = findById(
    graph?.projects,
    projectId,
  );

  return [
    skillsUsedBy(project),
    linkedRecords(
      project,
      'achievements',
      'achievement',
      'achievementId',
      'achievement',
      getAchievementTitle,
      'achievements',
    ),
    /*
     * The API hydrates experience -> project but not the reverse, so the
     * owning roles are found by scanning experiences for a join row
     * carrying this project's id. Empty today for the reason above.
     */
    partOfForProject(graph, projectId),
  ];
}

/** Skills a record's own join rows reference. */
function skillsUsedBy(
  record: unknown,
): RelationGroup {
  const items: RelationItem[] = [];

  toArray(
    getObjectField(record, 'skills'),
  ).forEach((row) => {
    const skill = getObjectField(
      row,
      'skill',
    );

    const entityId =
      getStringField(row, 'skillId') ??
      getStringField(skill, 'id');

    if (entityId === null) {
      return;
    }

    pushItem(items, {
      entityType: 'skill',
      entityId,
      label: getSkillName(row),
    });
  });

  return {
    kind: 'uses-skills',
    title: GROUP_TITLES['uses-skills'],
    items,
  };
}

/*
 * Generic reader for a hydrated join array on a record: takes the id from
 * the join row's own foreign key, and the display name from the hydrated
 * relation. A row without an id is skipped rather than guessed at.
 */
function linkedRecords(
  record: unknown,
  arrayKey: string,
  relationKey: string,
  idKey: string,
  entityType: DetailEntityType,
  readLabel: (item: unknown) => string,
  kind: RelationGroupKind,
): RelationGroup {
  const items: RelationItem[] = [];

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

    if (entityId === null) {
      return;
    }

    pushItem(items, {
      entityType,
      entityId,
      label: readLabel(relation ?? row),
    });
  });

  return {
    kind,
    title: GROUP_TITLES[kind],
    items,
  };
}

/** Roles that list this project, found by scanning their join rows. */
function partOfForProject(
  graph: CareerGraph | null,
  projectId: string,
): RelationGroup {
  const items: RelationItem[] = [];

  if (projectId !== '') {
    toArray(graph?.experiences).forEach(
      (experience) => {
        const owns = toArray(
          getObjectField(
            experience,
            'projects',
          ),
        ).some(
          (row) =>
            getStringField(
              row,
              'projectId',
            ) === projectId,
        );

        if (!owns) {
          return;
        }

        pushItem(items, {
          entityType: 'experience',
          entityId:
            getStringField(
              experience,
              'id',
            ) ?? '',
          label:
            getExperienceTitle(experience),
        });
      },
    );
  }

  return {
    kind: 'part-of',
    title: GROUP_TITLES['part-of'],
    items,
  };
}

/*
 * Roles and projects that list this achievement. Both directions are
 * scanned by id. Empty today because neither join is ever written, and an
 * achievement is deliberately left standing alone rather than attached to
 * a record whose text happens to look related.
 */
function partOfForAchievement(
  graph: CareerGraph | null,
  achievementIds: string[],
): RelationGroup {
  const items: RelationItem[] = [];

  const owns = (record: unknown) =>
    toArray(
      getObjectField(record, 'achievements'),
    ).some((row) => {
      const id = getStringField(
        row,
        'achievementId',
      );

      return (
        id !== null &&
        achievementIds.includes(id)
      );
    });

  toArray(graph?.experiences).forEach(
    (experience) => {
      if (!owns(experience)) {
        return;
      }

      pushItem(items, {
        entityType: 'experience',
        entityId:
          getStringField(experience, 'id') ??
          '',
        label:
          getExperienceTitle(experience),
      });
    },
  );

  toArray(graph?.projects).forEach(
    (project) => {
      if (!owns(project)) {
        return;
      }

      pushItem(items, {
        entityType: 'project',
        entityId:
          getStringField(project, 'id') ?? '',
        label: getProjectName(project),
      });
    },
  );

  return {
    kind: 'part-of',
    title: GROUP_TITLES['part-of'],
    items,
  };
}

/*
 * ----------------------------------------------------------------------
 * HELPERS
 * ----------------------------------------------------------------------
 */

function referencesSkill(
  record: unknown,
  skillIds: string[],
) {
  return toArray(
    getObjectField(record, 'skills'),
  ).some((row) => {
    const id =
      getStringField(row, 'skillId') ??
      getStringField(
        getObjectField(row, 'skill'),
        'id',
      );

    return id !== null && skillIds.includes(id);
  });
}

function findById(
  items: unknown,
  entityId: string,
): unknown {
  if (entityId === '') {
    return null;
  }

  return (
    toArray(items).find(
      (item) =>
        getStringField(item, 'id') ===
        entityId,
    ) ?? null
  );
}

/** Adds an item unless its id is already in the group. */
function pushItem(
  items: RelationItem[],
  item: RelationItem,
) {
  if (item.entityId === '') {
    return;
  }

  if (
    items.some(
      (existing) =>
        existing.entityId === item.entityId,
    )
  ) {
    return;
  }

  items.push(item);
}

/*
 * Drops empty groups and sorts each surviving group by label then id, so
 * the sheet never renders a heading with nothing under it and never
 * reorders between requests.
 */
function buildGroups(
  groups: RelationGroup[],
): RelationGroup[] {
  return groups
    .filter((group) => group.items.length > 0)
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        if (a.label !== b.label) {
          return a.label < b.label ? -1 : 1;
        }

        return a.entityId < b.entityId
          ? -1
          : a.entityId > b.entityId
            ? 1
            : 0;
      }),
    }));
}
