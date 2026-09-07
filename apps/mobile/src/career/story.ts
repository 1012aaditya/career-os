/*
 * Career story.
 *
 * A deterministic description of the patterns visible in the career graph.
 * Every sentence is assembled from counts, dates and relationships the
 * payload actually carries — there is no language model here, and there
 * never should be one at this layer.
 *
 * The hard rule is that the story describes shape, never causation. It may
 * say what appears most often and over what span; it may not say that one
 * role led to another, that a skill was learned somewhere, or that a
 * career moved in a direction. No such relationship is represented in the
 * data, so no such claim can be made.
 *
 * Same graph in, same story out.
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
  getExperienceTitle,
  getLinkedSkillIds,
  getSkillName,
} from './graph-model';

export type CareerStoryLine = {
  /** Stable render key, and a stable handle for assertions. */
  id: string;
  text: string;
};

export type CareerStory = {
  headline: string;
  lines: CareerStoryLine[];
  isEmpty: boolean;
};

/** How many focus skills the headline may name. */
const FOCUS_SKILL_LIMIT = 3;

/*
 * A skill only counts if the payload gives it a real Skill.id. getSkillId
 * would synthesise `index-N` from array position, and getGraph applies no
 * ORDER BY to userSkills — so falling back to position would make the
 * story depend on row order. A row with no id is skipped instead.
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

export function buildCareerStory(
  graph: CareerGraph | null,
): CareerStory {
  const experiences = toArray(
    graph?.experiences,
  );

  const projects = toArray(graph?.projects);
  const achievements = toArray(
    graph?.achievements,
  );

  const educations = toArray(
    graph?.educations,
  );

  const userSkills = toArray(
    graph?.userSkills,
  );

  const recordCount =
    experiences.length +
    projects.length +
    achievements.length +
    educations.length +
    userSkills.length;

  if (recordCount === 0) {
    return {
      headline:
        'Your career graph is empty.',
      lines: [],
      isEmpty: true,
    };
  }

  const lines: CareerStoryLine[] = [];

  const focus = getFocusSkills(
    userSkills,
    experiences,
    projects,
  );

  /*
   * Counts only — never a judgement of ability, and never a ranking the
   * numbers do not actually support.
   */
  const headline = describeFocus(
    focus,
    focus.length,
  );

  const composition = describeComposition(
    experiences.length,
    projects.length,
    achievements.length,
  );

  if (composition) {
    lines.push({
      id: 'composition',
      text: composition,
    });
  }

  const span = describeSpan(
    experiences,
    projects,
  );

  if (span) {
    lines.push({ id: 'span', text: span });
  }

  const current = describeCurrentRole(
    experiences,
  );

  if (current) {
    lines.push({
      id: 'current',
      text: current,
    });
  }

  const connected = describeConnectedWork(
    experiences,
    projects,
  );

  if (connected) {
    lines.push({
      id: 'connected',
      text: connected,
    });
  }

  const unlinked = describeUnlinkedSkills(
    userSkills,
    experiences,
    projects,
  );

  if (unlinked) {
    lines.push({
      id: 'unlinked',
      text: unlinked,
    });
  }

  return {
    headline,
    lines,
    isEmpty: false,
  };
}

/*
 * ----------------------------------------------------------------------
 * DERIVATIONS
 * ----------------------------------------------------------------------
 */

type FocusSkill = {
  skillId: string;
  name: string;
  uses: number;
};

/*
 * Skills ranked by how many experience and project records reference
 * them. Identity is Skill.id; the name is carried for display only.
 *
 * The comparator deliberately never consults payload position: getGraph
 * applies no ORDER BY to userSkills and none at all to nested relations,
 * so row order is not stable between requests. Ties break on name then id,
 * making the ranking a total order that survives a refresh.
 */
function getFocusSkills(
  userSkills: unknown[],
  experiences: unknown[],
  projects: unknown[],
): FocusSkill[] {
  const entries = new Map<
    string,
    FocusSkill
  >();

  userSkills.forEach((item) => {
    const skillId = readSkillId(item);

    if (
      skillId === null ||
      entries.has(skillId)
    ) {
      return;
    }

    entries.set(skillId, {
      skillId,
      name: getSkillName(item),
      uses: 0,
    });
  });

  [...experiences, ...projects].forEach(
    (record) => {
      getLinkedSkillIds(record).forEach(
        (skillId) => {
          const entry = entries.get(skillId);

          if (entry) {
            entry.uses += 1;
          }
        },
      );
    },
  );

  return [...entries.values()]
    .filter((entry) => entry.uses > 0)
    .sort((a, b) => {
      if (a.uses !== b.uses) {
        return b.uses - a.uses;
      }

      if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }

      return a.skillId < b.skillId ? -1 : 1;
    });
}

/*
 * Turns the ranking into a sentence that never overstates it.
 *
 * Naming "the skills that recur most" is only honest when something
 * actually recurred and when the top of the ranking is unambiguous. On the
 * common single-import graph every skill is linked exactly once, so there
 * is no "most" to report — saying otherwise would present an alphabetical
 * tie-break as a finding about the person.
 */
function describeFocus(
  focus: FocusSkill[],
  linkedSkillCount: number,
): string {
  if (focus.length === 0) {
    return 'Your graph is built from the records it holds so far.';
  }

  const topUses = focus[0].uses;

  const leaders = focus.filter(
    (entry) => entry.uses === topUses,
  );

  /*
   * Nothing repeated: report the count, name nothing. Which skills would
   * be named here is decided by the tie-break, not by the data.
   */
  if (topUses < 2) {
    return `Your graph links ${linkedSkillCount} ${plural(linkedSkillCount, 'skill')} to your work, each to a single record.`;
  }

  /*
   * Too many skills tied at the top to name a meaningful few — report the
   * shape of the tie rather than picking three alphabetically.
   */
  if (leaders.length > FOCUS_SKILL_LIMIT) {
    return `${leaders.length} skills each appear in ${topUses} work records, the most in your graph.`;
  }

  return `Your graph centres on ${formatList(leaders.map((entry) => entry.name))} — ${leaders.length === 1 ? 'the skill that appears' : 'the skills that appear'} in the most work records (${topUses} each).`;
}

function describeComposition(
  experienceCount: number,
  projectCount: number,
  achievementCount: number,
): string | null {
  const parts = [
    experienceCount > 0
      ? `${experienceCount} ${plural(experienceCount, 'role')}`
      : null,
    projectCount > 0
      ? `${projectCount} ${plural(projectCount, 'project')}`
      : null,
    achievementCount > 0
      ? `${achievementCount} ${plural(achievementCount, 'achievement')}`
      : null,
  ].filter(
    (part): part is string => part !== null,
  );

  if (parts.length === 0) {
    return null;
  }

  return `It holds ${formatList(parts)}.`;
}

/*
 * The span of dated work records. Undated records are simply not counted
 * — the range never gets stretched to cover a record with no date.
 */
function describeSpan(
  experiences: unknown[],
  projects: unknown[],
): string | null {
  const years: number[] = [];

  [...experiences, ...projects].forEach(
    (record) => {
      ['startDate', 'endDate'].forEach(
        (key) => {
          const time = getTimeField(
            record,
            key,
          );

          if (time !== null) {
            years.push(
              new Date(time).getUTCFullYear(),
            );
          }
        },
      );
    },
  );

  if (years.length === 0) {
    return null;
  }

  const earliest = Math.min(...years);
  const latest = Math.max(...years);

  if (earliest === latest) {
    return `Dated work in your graph falls in ${earliest}.`;
  }

  return `Dated work in your graph runs from ${earliest} to ${latest}.`;
}

/*
 * Only ever describes a role the payload explicitly flags as current.
 * A missing end date is not treated as evidence of an ongoing role.
 */
function describeCurrentRole(
  experiences: unknown[],
): string | null {
  /*
   * More than one role can be flagged current, and payload order is not
   * stable, so pick deterministically: latest start date, then id.
   */
  const currentRoles = experiences.filter(
    (item) =>
      getBooleanField(item, 'isCurrent'),
  );

  const current = [...currentRoles]
    .sort((a, b) => {
      const aTime =
        getTimeField(a, 'startDate') ??
        Number.NEGATIVE_INFINITY;

      const bTime =
        getTimeField(b, 'startDate') ??
        Number.NEGATIVE_INFINITY;

      if (aTime !== bTime) {
        return bTime - aTime;
      }

      const aId =
        getStringField(a, 'id') ?? '';

      const bId =
        getStringField(b, 'id') ?? '';

      return aId < bId ? -1 : aId > bId ? 1 : 0;
    })[0];

  if (!current) {
    return null;
  }

  const title = getExperienceTitle(current);

  const company = getStringField(
    getObjectField(current, 'company'),
    'name',
  );

  const named = company
    ? `${title} at ${company}`
    : title;

  /*
   * More than one role can be flagged current. Naming only the most
   * recent would read as exclusive, so the count is stated too.
   */
  if (currentRoles.length > 1) {
    return `Your graph marks ${currentRoles.length} roles as current, most recently ${named}.`;
  }

  return `Your graph marks ${named} as current.`;
}

/*
 * How much of the work is actually connected to skills. This is a
 * structural observation about the graph, not a judgement about the work.
 */
function describeConnectedWork(
  experiences: unknown[],
  projects: unknown[],
): string | null {
  const records = [...experiences, ...projects];

  if (records.length === 0) {
    return null;
  }

  const connected = records.filter(
    (record) =>
      getLinkedSkillIds(record).length > 0,
  ).length;

  if (connected === 0) {
    return `None of your ${records.length} work ${plural(records.length, 'record')} lists the skills it used yet.`;
  }

  if (connected === records.length) {
    return `Every work record lists the skills it used.`;
  }

  return `${connected} of ${records.length} work records list the skills they used.`;
}

/*
 * Skills present on the profile that no work record references. Stated as
 * a gap in the graph, never as a gap in the person.
 */
function describeUnlinkedSkills(
  userSkills: unknown[],
  experiences: unknown[],
  projects: unknown[],
): string | null {
  if (userSkills.length === 0) {
    return null;
  }

  const used = new Set<string>();

  [...experiences, ...projects].forEach(
    (record) => {
      getLinkedSkillIds(record).forEach(
        (skillId) => used.add(skillId),
      );
    },
  );

  /* Counted by identity, matching how the focus ranking dedupes. */
  const unlinkedIds = new Set<string>();

  userSkills.forEach((item) => {
    const skillId = readSkillId(item);

    if (
      skillId !== null &&
      !used.has(skillId)
    ) {
      unlinkedIds.add(skillId);
    }
  });

  const unlinked = unlinkedIds.size;

  if (unlinked === 0) {
    return null;
  }

  return `${unlinked} ${plural(unlinked, 'skill')} ${unlinked === 1 ? 'is' : 'are'} not yet linked to any role or project.`;
}

/*
 * ----------------------------------------------------------------------
 * FORMATTING
 * ----------------------------------------------------------------------
 */

function formatList(parts: string[]): string {
  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1) {
    return parts[0];
  }

  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }

  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function plural(
  count: number,
  singular: string,
) {
  return count === 1
    ? singular
    : `${singular}s`;
}

/** The whole story as one string, for display or assertion. */
export function getStoryText(
  story: CareerStory,
): string {
  return [
    story.headline,
    ...story.lines.map((line) => line.text),
  ].join(' ');
}
