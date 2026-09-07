/*
 * Fixtures for the Career Graph projection tests.
 *
 * Typed against the real `CareerGraph` contract rather than `any`, which
 * makes every fixture an assertion in its own right: if the API shape and
 * the client's declared shape drift apart, these stop compiling before any
 * test runs.
 *
 * Not itself a test file — vitest.config.mts only collects `*.test.ts`.
 */

import type {
  Achievement,
  CareerGraph,
  Education,
  Evidence,
  EvidenceRecord,
  Experience,
  IsoDateString,
  Project,
  Skill,
  UserSkill,
} from '../api/career-graph';

const T0 = '2026-01-01T00:00:00.000Z';

export function iso(
  year: number,
  month = 1,
  day = 1,
): IsoDateString {
  return new Date(
    Date.UTC(year, month - 1, day),
  ).toISOString();
}

export function makeSkill(
  id: string,
  name: string,
): Skill {
  return {
    id,
    name,
    normalizedName: name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' '),
    createdAt: T0,
    updatedAt: T0,
  };
}

export function makeUserSkill(
  skill: Skill,
  createdAt: IsoDateString = T0,
): UserSkill {
  return {
    id: `us-${skill.id}`,
    userId: 'user-1',
    skillId: skill.id,
    createdAt,
    skill,
  };
}

export function makeEvidenceRecord(
  overrides: Partial<EvidenceRecord> & {
    id: string;
  },
): EvidenceRecord {
  return {
    userId: 'user-1',
    resumeImportId: 'import-1',
    sourceType: 'RESUME',
    title: 'Resume: cv.pdf',
    description: null,
    sourceUrl: null,
    externalId: null,
    occurredAt: null,
    capturedAt: T0,
    metadata: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeEvidence(
  overrides: Partial<Evidence> & {
    id: string;
  },
): Evidence {
  return {
    ...makeEvidenceRecord({
      id: overrides.id,
    }),
    resumeImport: {
      id: 'import-1',
      fileName: 'cv.pdf',
      status: 'CONFIRMED',
      createdAt: T0,
    },
    experiences: [],
    projects: [],
    skills: [],
    achievements: [],
    educations: [],
    ...overrides,
  };
}

export function makeExperience(
  overrides: Partial<Experience> & {
    id: string;
    title: string;
  },
): Experience {
  return {
    userId: 'user-1',
    companyId: null,
    type: 'EMPLOYMENT',
    description: null,
    location: null,
    startDate: null,
    endDate: null,
    endDateText: null,
    isCurrent: false,
    createdAt: T0,
    updatedAt: T0,
    company: null,
    skills: [],
    projects: [],
    achievements: [],
    evidence: [],
    ...overrides,
  };
}

export function makeProject(
  overrides: Partial<Project> & {
    id: string;
    name: string;
  },
): Project {
  return {
    userId: 'user-1',
    description: null,
    url: null,
    startDate: null,
    endDate: null,
    createdAt: T0,
    updatedAt: T0,
    skills: [],
    achievements: [],
    evidence: [],
    ...overrides,
  };
}

export function makeAchievement(
  overrides: Partial<Achievement> & {
    id: string;
    title: string;
  },
): Achievement {
  return {
    userId: 'user-1',
    description: null,
    occurredAt: null,
    createdAt: T0,
    updatedAt: T0,
    evidence: [],
    ...overrides,
  };
}

export function makeEducation(
  overrides: Partial<Education> & {
    id: string;
    institution: string;
  },
): Education {
  return {
    userId: 'user-1',
    location: null,
    degree: null,
    fieldOfStudy: null,
    startDate: null,
    endDate: null,
    grade: null,
    createdAt: T0,
    updatedAt: T0,
    evidence: [],
    ...overrides,
  };
}

export function makeGraph(
  overrides: Partial<CareerGraph> = {},
): CareerGraph {
  return {
    id: 'user-1',
    createdAt: T0,
    updatedAt: T0,
    profile: null,
    educations: [],
    experiences: [],
    projects: [],
    userSkills: [],
    achievements: [],
    evidence: [],
    goals: [],
    ...overrides,
  };
}

/** The empty graph a brand-new user gets back from GET /career-graph. */
export function emptyGraph(): CareerGraph {
  return makeGraph();
}

/*
 * Reverses every array in the payload, at every depth, without mutating
 * the original.
 *
 * This is the determinism harness. The API's ordering contract is a
 * promise about the transport, and these projections must not depend on
 * it — a payload whose collections arrive in the opposite order has to
 * produce a byte-identical projection. Reversal is used rather than a
 * random shuffle so a failure reproduces exactly.
 */
export function deepReverse<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value]
      .reverse()
      .map((item) =>
        deepReverse(item),
      ) as unknown as T;
  }

  if (
    typeof value === 'object' &&
    value !== null
  ) {
    const out: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = deepReverse(item);
    }

    return out as unknown as T;
  }

  return value;
}

/*
 * A graph with something of every kind in it, wired the way ingestion
 * actually wires one: skills attached to work, evidence attached to every
 * entity type including education, and roles in each of the three career
 * states.
 */
export function richGraph(): CareerGraph {
  const react = makeSkill('s-react', 'React');
  const ts = makeSkill('s-ts', 'TypeScript');
  const go = makeSkill('s-go', 'Go');
  const orphan = makeSkill(
    's-orphan',
    'Fortran',
  );

  const evidence = makeEvidence({
    id: 'ev-1',
    title: 'Resume: cv.pdf',
    skills: [
      {
        evidenceId: 'ev-1',
        skillId: react.id,
        skill: {
          id: react.id,
          name: react.name,
        },
      },
      {
        evidenceId: 'ev-1',
        skillId: ts.id,
        skill: { id: ts.id, name: ts.name },
      },
      {
        evidenceId: 'ev-1',
        skillId: go.id,
        skill: { id: go.id, name: go.name },
      },
    ],
    experiences: [
      {
        evidenceId: 'ev-1',
        experienceId: 'x-current',
        experience: {
          id: 'x-current',
          title: 'Staff Engineer',
        },
      },
    ],
    projects: [
      {
        evidenceId: 'ev-1',
        projectId: 'p-1',
        project: {
          id: 'p-1',
          name: 'Career OS',
        },
      },
    ],
    achievements: [
      {
        evidenceId: 'ev-1',
        achievementId: 'a-1',
        achievement: {
          id: 'a-1',
          title: 'Patent granted',
        },
      },
    ],
    educations: [
      {
        evidenceId: 'ev-1',
        educationId: 'edu-1',
        education: {
          id: 'edu-1',
          institution: 'MIT',
        },
      },
    ],
  });

  const evidenceLink = {
    evidenceId: 'ev-1',
    evidence: makeEvidenceRecord({
      id: 'ev-1',
    }),
  };

  return makeGraph({
    profile: {
      id: 'prof-1',
      userId: 'user-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      headline: null,
      bio: null,
      location: null,
      avatarUrl: null,
      createdAt: T0,
      updatedAt: T0,
    },
    userSkills: [
      makeUserSkill(react, iso(2020, 1)),
      makeUserSkill(ts, iso(2020, 2)),
      makeUserSkill(go, iso(2020, 3)),
      makeUserSkill(orphan, iso(2020, 4)),
    ],
    experiences: [
      /* Stated ongoing: the source wrote "Present". */
      makeExperience({
        id: 'x-current',
        title: 'Staff Engineer',
        companyId: 'c-1',
        company: {
          id: 'c-1',
          name: 'Acme',
          normalizedName: 'acme',
          websiteUrl: null,
          createdAt: T0,
          updatedAt: T0,
        },
        startDate: iso(2023, 3),
        endDateText: 'Present',
        isCurrent: true,
        skills: [
          {
            experienceId: 'x-current',
            skillId: react.id,
            skill: react,
          },
          {
            experienceId: 'x-current',
            skillId: ts.id,
            skill: ts,
          },
        ],
        evidence: [
          {
            ...evidenceLink,
            experienceId: 'x-current',
          },
        ],
      }),
      /* Current only because no end date was supplied: an inference. */
      makeExperience({
        id: 'x-assumed',
        title: 'Contractor',
        startDate: iso(2021, 6),
        endDateText: null,
        isCurrent: true,
        skills: [
          {
            experienceId: 'x-assumed',
            skillId: go.id,
            skill: go,
          },
        ],
      }),
      /* Ended: carries a real end date. */
      makeExperience({
        id: 'x-ended',
        title: 'Junior Developer',
        startDate: iso(2019, 1),
        endDate: iso(2021, 1),
        endDateText: 'Jan 2021',
      }),
    ],
    projects: [
      makeProject({
        id: 'p-1',
        name: 'Career OS',
        startDate: iso(2024, 5),
        skills: [
          {
            projectId: 'p-1',
            skillId: ts.id,
            skill: ts,
          },
        ],
        evidence: [
          { ...evidenceLink, projectId: 'p-1' },
        ],
      }),
    ],
    achievements: [
      makeAchievement({
        id: 'a-1',
        title: 'Patent granted',
        occurredAt: iso(2022, 9),
        evidence: [
          {
            ...evidenceLink,
            achievementId: 'a-1',
          },
        ],
      }),
    ],
    educations: [
      makeEducation({
        id: 'edu-1',
        institution: 'MIT',
        degree: 'BSc',
        startDate: iso(2015, 9),
        endDate: iso(2019, 6),
        evidence: [
          {
            ...evidenceLink,
            educationId: 'edu-1',
          },
        ],
      }),
    ],
    evidence: [evidence],
  });
}
