/*
 * Career graph model.
 *
 * Pure construction of the Career Map: which records become nodes, where
 * they sit, which relationships become edges, how many records exist
 * versus how many are drawn, and how a lens emphasises them.
 *
 * Nothing here imports React or react-native, so the whole model is
 * node-testable. It is deterministic — identical input always yields an
 * identical model — and every relationship is resolved by stable database
 * id. Names and titles are display values and are never used for matching.
 *
 * The map deliberately draws only a slice of a large career (GRAPH_CAPS).
 * That is a rendering limit, not a statement about the data, so the model
 * reports real payload totals alongside what it drew and the UI is
 * expected to disclose the difference rather than let the drawn count pass
 * as the total.
 */

import type { CareerGraph } from '../api/career-graph';

import {
  getObjectField,
  getStringField,
  getTimeField,
  toArray,
} from './graph-fields';

export type GraphNodeType =
  | 'person'
  | 'skill'
  | 'experience'
  | 'project'
  | 'evidence'
  | 'achievement';

export type GraphNode = {
  /** Node key within the graph, e.g. "skill-<uuid>". */
  id: string;
  /*
   * Stable database id of the entity this node represents: Skill.id,
   * Experience.id, Project.id, Achievement.id or Evidence.id. Relationship
   * lookups use this — never the label, which is a display value.
   */
  entityId: string;
  label: string;
  type: GraphNodeType;
  x: number;
  y: number;
  subtitle?: string;
};

/*
 * Relationship kinds the map draws. The kind names both endpoint types,
 * which is what lens emphasis and render suppression are computed from —
 * no node lookup, and no matching on node-id string prefixes.
 */
export type GraphEdgeKind =
  | 'person-skill'
  | 'person-experience'
  | 'person-project'
  | 'person-evidence'
  | 'person-achievement'
  | 'experience-skill'
  | 'project-skill';

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
};

export type DetailEntityType =
  | GraphNodeType
  | 'education';

/*
 * What the detail sheet is currently showing. Identity is always a list of
 * stable database ids: normally one, but a capability row that merged two
 * same-named Skill records carries both so its evidence is the union.
 */
export type DetailSelection = {
  type: DetailEntityType;
  entityIds: string[];
  label: string;
  subtitle?: string;
};

export function selectionFromNode(
  node: GraphNode,
): DetailSelection {
  return {
    type: node.type,
    entityIds: [node.entityId],
    label: node.label,
    subtitle: node.subtitle,
  };
}

export const GRAPH_WIDTH = 390;
export const GRAPH_HEIGHT = 520;
export const CENTER_X = GRAPH_WIDTH / 2;
export const CENTER_Y = GRAPH_HEIGHT / 2;

// Breathing room kept between any painted pixel and the canvas edge.
const GRAPH_PADDING = 12;

// Labels are drawn centred on the node, so they can be wider than the
// circle itself. These keep that overflow inside the canvas.
export const NODE_LABEL_MAX_CHARS = 14;
export const PERSON_LABEL_MAX_CHARS = 12;
const LABEL_CHAR_WIDTH = 5.9;
export const NODE_GLOW_PADDING = 7;

// Radial layout is elliptical: the canvas is much taller than it is wide,
// so horizontal reach has to stay shorter than vertical reach.
const SKILL_RX = 100;
const SKILL_RY = 132;
const SPOKE_RX = 138;
const SPOKE_RY = 152;
const OUTER_RX = 150;
const OUTER_RY = 198;

/*
 * Node radii live with the model because placement maths depends on them.
 * Colours stay in the screen: pulling the theme in here would drag
 * react-native into a module that has to stay pure.
 */
export const NODE_RADIUS: Record<
  DetailEntityType,
  number
> = {
  person: 42,
  skill: 28,
  experience: 31,
  project: 30,
  evidence: 27,
  achievement: 29,
  education: 28,
};

/*
 * ----------------------------------------------------------------------
 * CAPS, COUNTS AND DISCLOSURE
 * ----------------------------------------------------------------------
 */

/*
 * How many records of each type the map draws. Display limits chosen for
 * legibility on a 390x520 canvas; a real career routinely holds more.
 * GraphCounts reports both numbers so the UI can say so out loud instead
 * of letting the drawn count pass for the total.
 */
export const GRAPH_CAPS = {
  skill: 8,
  experience: 4,
  project: 5,
  evidence: 5,
  achievement: 4,
} as const;

export type CountedEntityType =
  keyof typeof GRAPH_CAPS;

const COUNTED_TYPES: CountedEntityType[] = [
  'skill',
  'experience',
  'project',
  'evidence',
  'achievement',
];

/** Plural nouns for the disclosure line. Display only. */
const COUNT_LABELS: Record<
  CountedEntityType,
  { one: string; many: string }
> = {
  skill: { one: 'skill', many: 'skills' },
  experience: {
    one: 'experience',
    many: 'experiences',
  },
  project: {
    one: 'project',
    many: 'projects',
  },
  evidence: {
    one: 'evidence record',
    many: 'evidence records',
  },
  achievement: {
    one: 'achievement',
    many: 'achievements',
  },
};

export type GraphTypeCount = {
  type: CountedEntityType;
  /** Records of this type in the payload. */
  total: number;
  /** Records of this type actually drawn. */
  displayed: number;
  hidden: number;
  isTruncated: boolean;
};

export type GraphCounts = {
  byType: Record<
    CountedEntityType,
    GraphTypeCount
  >;
  totalRecords: number;
  displayedRecords: number;
  hiddenRecords: number;
  isTruncated: boolean;
};

export type GraphModel = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: GraphCounts;
};

/*
 * Follows the ordering contract getGraph promises: newest first by the
 * record's own date with undated rows LAST, then by creation, then by id.
 * (Evidence adds the createdAt step the API omits; both are total orders
 * and agree in practice, since capturedAt and createdAt share now().)
 *
 * Applied client-side as well so the model can never depend on transport
 * order. Which records the capped map draws, and the angle each one sits
 * at, are both index-derived — so an unstable payload order would silently
 * change what the user sees between refreshes.
 */
function sortDatedRecords(
  records: unknown[],
  dateKey: string,
): unknown[] {
  return [...records].sort((a, b) => {
    const aTime = getTimeField(a, dateKey);
    const bTime = getTimeField(b, dateKey);

    /* Undated rows sort last rather than leading the list. */
    if (aTime === null || bTime === null) {
      if (aTime !== bTime) {
        return aTime === null ? 1 : -1;
      }
    } else if (aTime !== bTime) {
      return bTime - aTime;
    }

    const aCreated =
      getTimeField(a, 'createdAt') ?? 0;

    const bCreated =
      getTimeField(b, 'createdAt') ?? 0;

    if (aCreated !== bCreated) {
      return bCreated - aCreated;
    }

    const aId = getStringField(a, 'id') ?? '';
    const bId = getStringField(b, 'id') ?? '';

    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

/*
 * Round-robins evidence across its sourceType groups so the capped map
 * draws a mix of sources rather than whichever one synced last.
 *
 * A connector back-fills in a single pass, so ~40 GitHub rows land on one
 * capturedAt - the sync's clock, not a career date. Under a pure recency
 * sort those 40 hold every one of the five drawn slots and the resume the
 * map was built around disappears from it. The disclosure line still
 * reads "5 of 41", and it cannot repair a sample that represents only one
 * source: the user reads a picture that says their resume is not in their
 * graph.
 *
 * This is a PERMUTATION, never a filter. The angle each node sits at is
 * derived from evidenceRecords.length, so dropping a row here would move
 * every remaining node as well as under-representing the payload. The
 * whole list is reordered and the existing slice still takes the first
 * five; interleaving only far enough to fill the cap would mean returning
 * a shorter list, which is the one thing this must not do.
 *
 * Order WITHIN a source is untouched - records are appended in the order
 * sortDatedRecords produced, so capturedAt desc, then createdAt desc,
 * then id asc all still hold inside every group.
 *
 * Group order is order of FIRST APPEARANCE, so the source holding the
 * newest record leads and ordered[0] is still records[0]: the head of the
 * map remains the newest evidence, which is what the recency sort
 * promised. Ranking group names alphabetically instead would let a GITHUB
 * group outrank a strictly newer RESUME one for a reason invisible on
 * screen, binding node placement to the spelling of an enum rather than
 * to the data.
 *
 * Round-robin rather than proportional allocation, because proportional
 * IS the bug: five slots shared 40:1 round to five GitHub and zero
 * resume. One slot per source per round is both the simpler rule and the
 * only one that guarantees every source present reaches the drawn set
 * before any source takes a second turn.
 *
 * A record with no sourceType forms its own group rather than being
 * demoted. "Source not recorded" is already a first-class origin on the
 * evidence sheet, and pushing those rows behind a bulk sync would
 * recreate exactly the disappearance this exists to prevent.
 */
function interleaveBySourceType(
  records: unknown[],
): unknown[] {
  /*
   * A Map, not a plain object: Map iteration is insertion order for every
   * key type, while an object reorders integer-like keys and cannot carry
   * a null key at all. Insertion order here comes from one left-to-right
   * pass over an already totally ordered list, so group order is derived
   * from the input rather than from how the runtime stores keys.
   */
  const groups = new Map<
    string | null,
    unknown[]
  >();

  records.forEach((record) => {
    const source = getStringField(
      record,
      'sourceType',
    );

    const bucket = groups.get(source) ?? [];

    bucket.push(record);
    groups.set(source, bucket);
  });

  /*
   * One source, or none, makes the round-robin the identity. Returning
   * the input untouched is what makes a single-source map provably the
   * exact list it drew before this function existed.
   */
  if (groups.size <= 1) {
    return records;
  }

  const buckets = [...groups.values()];

  const longest = buckets.reduce(
    (max, bucket) =>
      Math.max(max, bucket.length),
    0,
  );

  const ordered: unknown[] = [];

  for (
    let round = 0;
    round < longest;
    round += 1
  ) {
    buckets.forEach((bucket) => {
      if (round < bucket.length) {
        ordered.push(bucket[round]);
      }
    });
  }

  return ordered;
}

/*
 * Ordering by when the skill was attached, then by id. The map draws a
 * capped eight, and both WHICH eight and the angle each sits at are
 * index-derived, so an unstable order would silently redraw the map
 * between refreshes while the disclosure claimed a fixed subset.
 *
 * getGraph now orders userSkills the same way, but the sort is kept here
 * too: the model must be a pure function of the graph's content, not of
 * the query that happened to fetch it.
 */
function sortSkillRecords(
  records: unknown[],
): unknown[] {
  return [...records].sort((a, b) => {
    const aTime =
      getTimeField(a, 'createdAt') ??
      Number.POSITIVE_INFINITY;

    const bTime =
      getTimeField(b, 'createdAt') ??
      Number.POSITIVE_INFINITY;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    const aId =
      getStringField(a, 'skillId') ?? '';

    const bId =
      getStringField(b, 'skillId') ?? '';

    if (aId === bId) {
      return 0;
    }

    return aId < bId ? -1 : 1;
  });
}

function buildCounts(
  graph: CareerGraph | null,
  nodes: GraphNode[],
): GraphCounts {
  const totals: Record<
    CountedEntityType,
    number
  > = {
    skill: toArray(graph?.userSkills).length,
    experience: toArray(graph?.experiences)
      .length,
    project: toArray(graph?.projects).length,
    evidence: toArray(graph?.evidence).length,
    achievement: toArray(graph?.achievements)
      .length,
  };

  const byType = {} as Record<
    CountedEntityType,
    GraphTypeCount
  >;

  let totalRecords = 0;
  let displayedRecords = 0;

  COUNTED_TYPES.forEach((type) => {
    const total = totals[type];

    /*
     * Counted from the nodes actually built rather than assumed from the
     * cap: a malformed record that produced no node must not be reported
     * as drawn.
     */
    const displayed = nodes.filter(
      (node) => node.type === type,
    ).length;

    const hidden = Math.max(
      total - displayed,
      0,
    );

    byType[type] = {
      type,
      total,
      displayed,
      hidden,
      isTruncated: hidden > 0,
    };

    totalRecords += total;
    displayedRecords += displayed;
  });

  return {
    byType,
    totalRecords,
    displayedRecords,
    hiddenRecords: Math.max(
      totalRecords - displayedRecords,
      0,
    ),
    isTruncated:
      totalRecords > displayedRecords,
  };
}

/*
 * "Showing 8 of 23 skills · 4 of 7 experiences", or null when everything
 * fits. Only truncated types are listed, so a graph that is fully drawn
 * shows no warning at all. Every number comes from the payload.
 */
export function describeTruncation(
  counts: GraphCounts,
): string | null {
  const parts = COUNTED_TYPES.filter(
    (type) => counts.byType[type].isTruncated,
  ).map((type) => {
    const entry = counts.byType[type];

    const label =
      entry.total === 1
        ? COUNT_LABELS[type].one
        : COUNT_LABELS[type].many;

    return `${entry.displayed} of ${entry.total} ${label}`;
  });

  if (parts.length === 0) {
    return null;
  }

  return `Showing ${parts.join(' · ')}`;
}

/*
 * ----------------------------------------------------------------------
 * LENSES
 * ----------------------------------------------------------------------
 *
 * A lens is a focus, not a filter. It changes emphasis only: no node is
 * removed, no position moves, and the truncation disclosure keeps
 * reporting the same totals. Switching lenses can therefore never suggest
 * that a record stopped existing.
 */

export type GraphLens =
  | 'all'
  | 'skills'
  | 'experiences'
  | 'projects';

export type GraphEmphasis = 'full' | 'dimmed';

export const GRAPH_LENSES: {
  id: GraphLens;
  label: string;
}[] = [
  { id: 'all', label: 'All' },
  /*
   * "Skills", not "Capabilities": these nodes are Skill rows. There is no
   * capability taxonomy or normalisation layer in the data model, and the
   * label must not imply one.
   */
  { id: 'skills', label: 'Skills' },
  {
    id: 'experiences',
    label: 'Experiences',
  },
  { id: 'projects', label: 'Projects' },
];

/** The node type each lens focuses on; 'all' focuses on nothing specific. */
const LENS_FOCUS: Record<
  GraphLens,
  GraphNodeType | null
> = {
  all: null,
  skills: 'skill',
  experiences: 'experience',
  projects: 'project',
};

/*
 * The person node anchors the layout and is the subject of the graph, so
 * it belongs to every lens and can never be dimmed or deselected.
 */
export function isTypeInLens(
  type: GraphNodeType,
  lens: GraphLens,
): boolean {
  if (type === 'person') {
    return true;
  }

  const focus = LENS_FOCUS[lens];

  return focus === null || type === focus;
}

export function getNodeEmphasis(
  node: GraphNode,
  lens: GraphLens,
): GraphEmphasis {
  return isTypeInLens(node.type, lens)
    ? 'full'
    : 'dimmed';
}

/** Both endpoint types of an edge, read straight off its kind. */
const EDGE_ENDPOINTS: Record<
  GraphEdgeKind,
  [GraphNodeType, GraphNodeType]
> = {
  'person-skill': ['person', 'skill'],
  'person-experience': [
    'person',
    'experience',
  ],
  'person-project': ['person', 'project'],
  'person-evidence': ['person', 'evidence'],
  'person-achievement': [
    'person',
    'achievement',
  ],
  'experience-skill': [
    'experience',
    'skill',
  ],
  'project-skill': ['project', 'skill'],
};

/*
 * A spoke from the person node says only "this record is yours", so it
 * follows its leaf entity.
 *
 * An entity-to-entity edge is the thing a lens exists to explain — it says
 * why a skill is in the graph at all — so it stays emphasised when EITHER
 * end is in focus. Under Skills both project-skill and experience-skill
 * stay bright; under Projects only project-skill does.
 */
export function getEdgeEmphasis(
  edge: GraphEdge,
  lens: GraphLens,
): GraphEmphasis {
  const [from, to] =
    EDGE_ENDPOINTS[edge.kind];

  if (from === 'person' || to === 'person') {
    const leaf = from === 'person' ? to : from;

    return isTypeInLens(leaf, lens)
      ? 'full'
      : 'dimmed';
  }

  return isTypeInLens(from, lens) ||
    isTypeInLens(to, lens)
    ? 'full'
    : 'dimmed';
}

/*
 * Person spokes to evidence and achievements are built — the relationship
 * is real — but not drawn, because those nodes sit in outer rings and the
 * spokes crossed the whole canvas. Suppressed at render, kept in the model.
 */
export function isEdgeRendered(
  edge: GraphEdge,
): boolean {
  return (
    edge.kind !== 'person-evidence' &&
    edge.kind !== 'person-achievement'
  );
}

/*
 * ----------------------------------------------------------------------
 * PLACEMENT
 * ----------------------------------------------------------------------
 */

function getLabelHalfWidth(maxChars: number) {
  return (maxChars * LABEL_CHAR_WIDTH) / 2;
}

function getNodeExtent(type: GraphNodeType) {
  const nodeRadius = NODE_RADIUS[type];
  const outerRadius = nodeRadius + NODE_GLOW_PADDING;

  const labelHalfWidth = getLabelHalfWidth(
    type === 'person'
      ? PERSON_LABEL_MAX_CHARS
      : NODE_LABEL_MAX_CHARS,
  );

  return {
    x: Math.max(outerRadius, labelHalfWidth),
    // Non-person nodes also render a type caption below the label.
    y: outerRadius + (type === 'person' ? 0 : 4),
  };
}

function placeNode(
  type: GraphNodeType,
  angle: number,
  rx: number,
  ry: number,
) {
  const extent = getNodeExtent(type);

  const minX = GRAPH_PADDING + extent.x;
  const maxX = GRAPH_WIDTH - GRAPH_PADDING - extent.x;
  const minY = GRAPH_PADDING + extent.y;
  const maxY = GRAPH_HEIGHT - GRAPH_PADDING - extent.y;

  return {
    x: clamp(CENTER_X + Math.cos(angle) * rx, minX, maxX),
    y: clamp(CENTER_Y + Math.sin(angle) * ry, minY, maxY),
  };
}

function clamp(
  value: number,
  min: number,
  max: number,
) {
  if (min > max) {
    return (min + max) / 2;
  }

  return Math.min(Math.max(value, min), max);
}

/*
 * ----------------------------------------------------------------------
 * MODEL CONSTRUCTION
 * ----------------------------------------------------------------------
 */

export function buildGraphModel(
  graph: CareerGraph | null,
): GraphModel {
  const nodes: GraphNode[] = [
    {
      id: 'person',
      entityId: 'person',
      label: 'YOU',
      type: 'person',
      x: CENTER_X,
      y: CENTER_Y,
    },
  ];

  const edges: GraphEdge[] = [];

  /*
   * Adds a node unless its id is already present, and returns whichever
   * node now owns that id. Callers use the return value so they can never
   * hold a reference to a candidate that was dropped.
   */
  const addNode = (
    node: GraphNode,
  ): GraphNode => {
    const existing = nodes.find(
      (current) => current.id === node.id,
    );

    if (existing) {
      return existing;
    }

    nodes.push(node);

    return node;
  };

  /*
   * Undirected: an edge already present in either direction is not added
   * again, so duplicate relationships in the payload cannot duplicate a
   * line on the map.
   */
  const addEdge = (
    from: string,
    to: string,
    kind: GraphEdgeKind,
  ) => {
    const id = `${from}-${to}`;

    if (
      edges.some(
        (edge) =>
          edge.id === id ||
          edge.id === `${to}-${from}`,
      )
    ) {
      return;
    }

    edges.push({
      id,
      from,
      to,
      kind,
    });
  };

  const skillRecords = sortSkillRecords(
    toArray(graph?.userSkills),
  );

  const skills = skillRecords
    .slice(0, GRAPH_CAPS.skill)
    .map((item, index) => {
      const name = getSkillName(item);
      const count = Math.min(
        skillRecords.length,
        GRAPH_CAPS.skill,
      );
      const angle =
        -Math.PI / 2 +
        (index / Math.max(count, 1)) *
          Math.PI *
          2;

      const node: GraphNode = {
        id: `skill-${getNestedId(item, index)}`,
        entityId: getSkillId(item, index),
        label: name,
        type: 'skill',
        ...placeNode(
          'skill',
          angle,
          SKILL_RX,
          SKILL_RY,
        ),
      };

      /*
       * Use the node that survived de-duplication, never the candidate:
       * if addNode dropped this one as a duplicate id, edge matching must
       * not be able to see a phantom whose entityId differs from the node
       * actually on the canvas.
       */
      const added = addNode(node);

      addEdge(
        'person',
        added.id,
        'person-skill',
      );

      return added;
    });

  const projectRecords = sortDatedRecords(
    toArray(graph?.projects),
    'startDate',
  );

  const projects = projectRecords
    .slice(0, GRAPH_CAPS.project)
    .map((item, index) => {
      const count = Math.min(
        projectRecords.length,
        GRAPH_CAPS.project,
      );
      const sectorStart = -Math.PI / 3;
      const sectorEnd = Math.PI / 3;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `project-${getNestedId(item, index)}`,
        entityId: getNestedId(item, index),
        label: getProjectName(item),
        type: 'project',
        ...placeNode(
          'project',
          angle,
          SPOKE_RX,
          SPOKE_RY,
        ),
      };

      addNode(node);
      addEdge(
        'person',
        node.id,
        'person-project',
      );

      connectSkillEdges(
        item,
        node.id,
        skills,
        addEdge,
        'project-skill',
      );

      return node;
    });

  const experienceRecords = sortDatedRecords(
    toArray(graph?.experiences),
    'startDate',
  );

  const experiences = experienceRecords
    .slice(0, GRAPH_CAPS.experience)
    .map((item, index) => {
      const count = Math.min(
        experienceRecords.length,
        GRAPH_CAPS.experience,
      );
      const sectorStart = (2 * Math.PI) / 3;
      const sectorEnd = (4 * Math.PI) / 3;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `experience-${getNestedId(item, index)}`,
        entityId: getNestedId(item, index),
        label: getExperienceTitle(item),
        type: 'experience',
        ...placeNode(
          'experience',
          angle,
          SPOKE_RX,
          SPOKE_RY,
        ),
        subtitle: getCompanyName(item),
      };

      addNode(node);
      addEdge(
        'person',
        node.id,
        'person-experience',
      );

      /*
       * ExperienceSkill rows are real relationships in the payload and
       * were previously never drawn, which made skills look as though
       * they only ever came from side projects.
       */
      connectSkillEdges(
        item,
        node.id,
        skills,
        addEdge,
        'experience-skill',
      );

      return node;
    });

  /*
   * Balanced by source before the cap, so a bulk connector sync cannot
   * take every drawn slot from the sources already on the map.
   */
  const evidenceRecords =
    interleaveBySourceType(
      sortDatedRecords(
        toArray(graph?.evidence),
        'capturedAt',
      ),
    );

  const evidence = evidenceRecords
    .slice(0, GRAPH_CAPS.evidence)
    .map((item, index) => {
      const count = Math.min(
        evidenceRecords.length,
        GRAPH_CAPS.evidence,
      );
      const sectorStart = Math.PI / 4;
      const sectorEnd = (3 * Math.PI) / 4;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `evidence-${getNestedId(item, index)}`,
        entityId: getNestedId(item, index),
        label: getEvidenceTitle(item),
        type: 'evidence',
        ...placeNode(
          'evidence',
          angle,
          OUTER_RX,
          OUTER_RY,
        ),
      };

      addNode(node);
      addEdge(
        'person',
        node.id,
        'person-evidence',
      );

      return node;
    });

  const achievementRecords = sortDatedRecords(
    toArray(graph?.achievements),
    'occurredAt',
  );

  achievementRecords
    .slice(0, GRAPH_CAPS.achievement)
    .forEach((item, index) => {
      const count = Math.min(
        achievementRecords.length,
        GRAPH_CAPS.achievement,
      );
      const sectorStart = (5 * Math.PI) / 4;
      const sectorEnd = (7 * Math.PI) / 4;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `achievement-${getNestedId(item, index)}`,
        entityId: getNestedId(item, index),
        label: getAchievementTitle(item),
        type: 'achievement',
        ...placeNode(
          'achievement',
          angle,
          OUTER_RX,
          OUTER_RY,
        ),
      };

      addNode(node);
      addEdge(
        'person',
        node.id,
        'person-achievement',
      );
    });

  return {
    nodes,
    edges,
    counts: buildCounts(graph, nodes),
  };
}

/*
 * Draws an entity -> skill edge for every hydrated skill join row on the
 * record, matched on Skill.id. A skill that exists in the payload but was
 * not drawn (beyond GRAPH_CAPS.skill) simply has no node to connect to and
 * is skipped — no phantom edge is created.
 *
 * Iterated over the DRAWN skill nodes rather than over the record's join
 * rows. The set of edges is the same intersection either way, but the
 * ORDER is not: walking the join rows put the edges in whatever order the
 * payload carried them, and `skills` is a nested relation, so that order
 * is the database's. Two payloads describing the same graph produced
 * `edges` arrays that differed in position — the model was not
 * reproducible, and `edges` is compared, snapshotted and painted in array
 * order.
 *
 * The node array is already deterministic (sortSkillRecords, then a cap),
 * so ordering the edges by it makes the whole model a pure function of the
 * graph's content.
 */
function connectSkillEdges(
  item: unknown,
  sourceNodeId: string,
  skills: GraphNode[],
  addEdge: (
    from: string,
    to: string,
    kind: GraphEdgeKind,
  ) => void,
  kind: GraphEdgeKind,
) {
  const linkedSkillIds = new Set(
    toArray(getObjectField(item, 'skills'))
      .map((relationship) =>
        readLinkedSkillId(relationship),
      )
      .filter(
        (skillId): skillId is string =>
          skillId !== null,
      ),
  );

  if (linkedSkillIds.size === 0) {
    return;
  }

  skills.forEach((skill) => {
    if (
      linkedSkillIds.has(skill.entityId)
    ) {
      addEdge(
        sourceNodeId,
        skill.id,
        kind,
      );
    }
  });
}

/*
 * ----------------------------------------------------------------------
 * FIELD READERS — identity always by id, never by name
 * ----------------------------------------------------------------------
 */

export function getSkillId(
  item: unknown,
  fallback: number,
) {
  return (
    getStringField(item, 'skillId') ??
    getStringField(
      getObjectField(item, 'skill'),
      'id',
    ) ??
    `index-${fallback}`
  );
}

export function getNestedId(
  item: unknown,
  fallback: number,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    typeof item.id === 'string'
  ) {
    return item.id;
  }

  return String(fallback);
}

export function getSkillName(item: unknown) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'skill' in item &&
    typeof item.skill === 'object' &&
    item.skill !== null &&
    'name' in item.skill &&
    typeof item.skill.name === 'string'
  ) {
    return item.skill.name;
  }

  if (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    typeof item.name === 'string'
  ) {
    return item.name;
  }

  return 'Skill';
}

export function getExperienceTitle(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'title' in item &&
    typeof item.title === 'string'
  ) {
    return item.title;
  }

  return 'Experience';
}

export function getCompanyName(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'company' in item &&
    typeof item.company === 'object' &&
    item.company !== null &&
    'name' in item.company &&
    typeof item.company.name === 'string'
  ) {
    return item.company.name;
  }

  return 'Company not specified';
}

export function getProjectName(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    typeof item.name === 'string'
  ) {
    return item.name;
  }

  return 'Project';
}

export function getEvidenceTitle(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'title' in item &&
    typeof item.title === 'string'
  ) {
    return item.title;
  }

  return 'Evidence';
}

export function getAchievementTitle(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'title' in item &&
    typeof item.title === 'string'
  ) {
    return item.title;
  }

  return 'Achievement';
}

/*
 * Skill ids referenced by a record's hydrated skill join rows, de-duped.
 * Shared with the career story so both read the relationship the same way.
 */
export function getLinkedSkillIds(
  item: unknown,
): string[] {
  const ids: string[] = [];

  toArray(
    getObjectField(item, 'skills'),
  ).forEach((row) => {
    const id = readLinkedSkillId(row);

    if (id !== null && !ids.includes(id)) {
      ids.push(id);
    }
  });

  return ids;
}

function readLinkedSkillId(
  row: unknown,
): string | null {
  return (
    getStringField(row, 'skillId') ??
    getStringField(
      getObjectField(row, 'skill'),
      'id',
    )
  );
}

/*
 * ----------------------------------------------------------------------
 * RELATIONSHIP RESOLUTION FOR THE DETAIL SHEET
 * ----------------------------------------------------------------------
 */

export function getNodeTypeLabelForLink(
  entityType: string,
) {
  switch (entityType) {
    case 'skill':
      return 'Skill';

    case 'experience':
      return 'Experience';

    case 'project':
      return 'Project';

    case 'achievement':
      return 'Achievement';

    default:
      return 'Related';
  }
}
