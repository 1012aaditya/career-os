/*
 * The sources Career OS can hold evidence from, and - just as important -
 * the ones it cannot yet.
 *
 * A connector list is where career products quietly lie. A grid of logos
 * implies a grid of integrations, and a user who taps Figma and finds
 * nothing has learned that the rest of the screen might be decoration too.
 * So availability is a field on every entry, there are exactly three
 * values, and the UI is required to render them differently.
 */

export type SourceAvailability =
  /** Implemented, and the user has connected it. */
  | 'connected'
  /** Implemented, and the user has not connected it. */
  | 'available'
  /** Not implemented. No amount of tapping will connect it. */
  | 'planned';

export type SourceEntry = {
  id: string;
  name: string;
  /** What the source would contribute, in the user's terms. */
  description: string;
  availability: SourceAvailability;
  /** The EvidenceSourceType its evidence carries, when it has one. */
  sourceType: string | null;
  /** Whether tapping opens a detail screen. Only true when implemented. */
  openable: boolean;
};

/**
 * Sources that actually exist in the product today.
 *
 * `connected` is decided at render time from real state - the GitHub
 * connection status and whether any evidence of that type came back - not
 * stored here.
 */
export const IMPLEMENTED_SOURCES: readonly Omit<
  SourceEntry,
  'availability'
>[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Public repositories you have contributed to.',
    sourceType: 'GITHUB',
    openable: true,
  },
  {
    id: 'resume',
    name: 'Resume',
    description: 'A resume you uploaded and confirmed.',
    sourceType: 'RESUME',
    openable: true,
  },
];

/**
 * Sources that do not exist.
 *
 * Listed because the roadmap is genuinely useful to a user deciding
 * whether this product will ever fit their work - a designer should be
 * able to see that Figma is intended. They are `planned`, never
 * `available`, and they are not openable.
 */
export const PLANNED_SOURCES: readonly Omit<
  SourceEntry,
  'availability'
>[] = [
  {
    id: 'portfolio',
    name: 'Portfolio',
    description: 'A personal site or portfolio you own.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Design files and prototypes you authored.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'drive',
    name: 'Google Drive',
    description: 'Documents and decks you produced.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages and specs you wrote.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Models and datasets you published.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'behance',
    name: 'Behance',
    description: 'Design work you published.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'dribbble',
    name: 'Dribbble',
    description: 'Shots and case studies you posted.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'kaggle',
    name: 'Kaggle',
    description: 'Competitions and notebooks you entered.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'leetcode',
    name: 'LeetCode',
    description: 'Practice history you completed.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    description: 'Roles and endorsements on your profile.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Issues and epics you delivered.',
    sourceType: null,
    openable: false,
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues and projects you shipped.',
    sourceType: null,
    openable: false,
  },
];

export const AVAILABILITY_LABELS: Record<SourceAvailability, string> = {
  connected: 'Connected',
  available: 'Available',
  planned: 'Coming soon',
};

/**
 * The full catalogue, with availability resolved from real state.
 *
 * `connectedIds` is what the app has actually verified - the GitHub
 * connection's own status, and the presence of evidence of a type. An
 * implemented source that is not connected is `available`; nothing that is
 * unimplemented can ever become either.
 */
export function buildCatalogue(connectedIds: {
  readonly [id: string]: boolean;
}): SourceEntry[] {
  return [
    ...IMPLEMENTED_SOURCES.map((entry) => ({
      ...entry,
      availability: (connectedIds[entry.id] === true
        ? 'connected'
        : 'available') as SourceAvailability,
    })),
    ...PLANNED_SOURCES.map((entry) => ({
      ...entry,
      availability: 'planned' as SourceAvailability,
    })),
  ];
}

export function groupByAvailability(entries: readonly SourceEntry[]): {
  connected: SourceEntry[];
  available: SourceEntry[];
  planned: SourceEntry[];
} {
  return {
    connected: entries.filter((e) => e.availability === 'connected'),
    available: entries.filter((e) => e.availability === 'available'),
    planned: entries.filter((e) => e.availability === 'planned'),
  };
}
