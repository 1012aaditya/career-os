import {
  describe,
  expect,
  it,
} from 'vitest';

import { buildCareerTimeline } from './timeline';
import { buildCareerStory } from './story';
import { getEntityRelations } from './relations';
import { buildDataQualityReport } from './data-quality';
import { buildEvidenceIndex } from './evidence';
import { buildGraphModel } from './graph-model';
import {
  getStringField,
  getTimeField,
  toArray,
} from './graph-fields';
import {
  emptyGraph,
  iso,
  makeAchievement,
  makeExperience,
  makeGraph,
  makeProject,
  makeSkill,
  makeUserSkill,
  richGraph,
} from './test-fixtures';

describe('timeline', () => {
  const timeline = buildCareerTimeline(
    richGraph(),
  );

  it('orders dated items most recent first', () => {
    const times = timeline.items.map(
      (item) =>
        item.start?.time ??
        item.end?.time ??
        0,
    );

    expect([...times]).toEqual(
      [...times].sort((a, b) => b - a),
    );
  });

  it('groups by year, most recent year first', () => {
    const years = timeline.groups.map(
      (group) => group.year,
    );

    expect(years).toEqual(
      [...years].sort((a, b) => b - a),
    );
  });

  it('keeps evidence off the axis and says so', () => {
    /*
     * Evidence records when something was captured, not when it happened,
     * so placing it on a career timeline would date the career by the
     * import. Excluded, and the count is surfaced rather than dropped.
     */
    expect(
      timeline.items.some(
        (item) => item.type === 'evidence',
      ),
    ).toBe(false);

    expect(
      timeline.excludedEvidenceCount,
    ).toBe(1);
  });

  it('puts undated records in their own bucket rather than guessing a date', () => {
    const withUndated = buildCareerTimeline(
      makeGraph({
        experiences: [
          makeExperience({
            id: 'x-undated',
            title: 'Mystery Role',
          }),
        ],
      }),
    );

    expect(withUndated.items).toHaveLength(0);
    expect(
      withUndated.undated,
    ).toHaveLength(1);
    expect(withUndated.hasUndated).toBe(true);
  });

  it('reports an empty graph as empty', () => {
    const empty = buildCareerTimeline(
      emptyGraph(),
    );

    expect(empty.isEmpty).toBe(true);
    expect(empty.items).toEqual([]);
    expect(empty.counts.total).toBe(0);
  });

  it('does not throw on a null graph', () => {
    expect(() =>
      buildCareerTimeline(null),
    ).not.toThrow();
  });
});

describe('career story', () => {
  it('says the graph is empty rather than inventing a narrative', () => {
    const story = buildCareerStory(
      emptyGraph(),
    );

    expect(story.isEmpty).toBe(true);
    expect(story.headline).toBe(
      'Your career graph is empty.',
    );
  });

  it('produces stable line ids for a populated graph', () => {
    const story = buildCareerStory(
      richGraph(),
    );

    expect(story.isEmpty).toBe(false);
    expect(story.headline).not.toBe('');

    const ids = story.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(
      ids.length,
    );
  });

  it('refuses to name top skills when nothing recurred', () => {
    /*
     * With every skill appearing once, which ones a ranking would name is
     * decided by the tie-break, not by the data. The story declines rather
     * than presenting insertion order as significance.
     */
    const flat = makeGraph({
      userSkills: [
        makeUserSkill(
          makeSkill('s-1', 'Alpha'),
          iso(2020, 1),
        ),
        makeUserSkill(
          makeSkill('s-2', 'Beta'),
          iso(2020, 2),
        ),
      ],
    });

    const story = buildCareerStory(flat);

    expect(story.headline).not.toContain(
      'Alpha',
    );
  });

  it('does not throw on a null graph', () => {
    expect(() =>
      buildCareerStory(null),
    ).not.toThrow();
  });
});

describe('relations', () => {
  const graph = richGraph();

  it('resolves related records by id, never by name', () => {
    const groups = getEntityRelations(
      {
        type: 'experience',
        entityIds: ['x-current'],
        label: 'Staff Engineer',
      },
      graph,
    );

    const skills = groups.find(
      (g) => g.kind === 'uses-skills',
    );

    expect(
      skills?.items.map((i) => i.entityId),
    ).toEqual(['s-react', 's-ts']);
  });

  it('reports the skill used by a role from the skill side too', () => {
    const groups = getEntityRelations(
      {
        type: 'skill',
        entityIds: ['s-ts'],
        label: 'TypeScript',
      },
      graph,
    );

    const usedIn = groups.find(
      (g) => g.kind === 'used-in',
    );

    expect(
      usedIn?.items.map((i) => i.entityId),
    ).toEqual(
      expect.arrayContaining([
        'x-current',
        'p-1',
      ]),
    );
  });

  it('returns nothing for an entity with no relationships', () => {
    expect(
      getEntityRelations(
        {
          type: 'skill',
          entityIds: ['s-orphan'],
          label: 'Fortran',
        },
        graph,
      ),
    ).toEqual([]);
  });

  it('does not invent relationships for a null graph', () => {
    expect(
      getEntityRelations(
        {
          type: 'skill',
          entityIds: ['s-ts'],
          label: 'TypeScript',
        },
        null,
      ),
    ).toEqual([]);
  });
});

describe('data quality detection', () => {
  const kindsFor = (
    graph: Parameters<
      typeof buildDataQualityReport
    >[0],
  ) =>
    buildDataQualityReport(graph).issues.map(
      (issue) => issue.kind,
    );

  it('reports a role that is current and also ended', () => {
    expect(
      kindsFor(
        makeGraph({
          experiences: [
            makeExperience({
              id: 'x',
              title: 'Engineer',
              startDate: iso(2019, 1),
              endDate: iso(2021, 1),
              isCurrent: true,
            }),
          ],
        }),
      ),
    ).toContain('current-with-end-date');
  });

  it('reports a record that ends before it starts', () => {
    expect(
      kindsFor(
        makeGraph({
          experiences: [
            makeExperience({
              id: 'x',
              title: 'Engineer',
              startDate: iso(2021, 1),
              endDate: iso(2019, 1),
            }),
          ],
        }),
      ),
    ).toContain('date-range-reversed');
  });

  it('reports a role whose state is not stated either way', () => {
    expect(
      kindsFor(
        makeGraph({
          experiences: [
            makeExperience({
              id: 'x',
              title: 'Engineer',
              startDate: iso(2020, 1),
            }),
          ],
        }),
      ),
    ).toContain('role-state-unknown');
  });

  it('reports a skill connected to no work', () => {
    expect(
      kindsFor(richGraph()),
    ).toContain('skill-not-connected');
  });

  it('names the affected record by id, so the finding can be acted on', () => {
    const issue = buildDataQualityReport(
      richGraph(),
    ).issues.find(
      (i) => i.kind === 'skill-not-connected',
    );

    expect(
      issue?.entities.map((e) => e.entityId),
    ).toEqual(['s-orphan']);
  });

  it('reports records that look alike without merging them', () => {
    const duplicated = makeGraph({
      projects: [
        makeProject({
          id: 'p-1',
          name: 'Career OS',
          startDate: iso(2024, 1),
        }),
        makeProject({
          id: 'p-2',
          name: 'Career OS',
          startDate: iso(2024, 1),
        }),
      ],
    });

    const report =
      buildDataQualityReport(duplicated);

    expect(
      report.issues.map((i) => i.kind),
    ).toContain('similar-records');

    /* Both keep their own identity — nothing is silently merged. */
    const lookalike = report.issues.find(
      (i) => i.kind === 'similar-records',
    );

    expect(
      lookalike?.entities.map(
        (e) => e.entityId,
      ),
    ).toEqual(['p-1', 'p-2']);
  });

  it('calls a clean graph clean', () => {
    const report = buildDataQualityReport(
      emptyGraph(),
    );

    expect(report.isClean).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('does not throw on a null graph', () => {
    expect(() =>
      buildDataQualityReport(null),
    ).not.toThrow();
  });
});

/*
 * The payload readers every projection funnels through. They are the
 * reason a malformed row degrades to an honest gap instead of a crash.
 */
describe('graph-fields readers', () => {
  it('treats a non-array as empty rather than throwing', () => {
    for (const value of [
      null,
      undefined,
      'text',
      42,
      {},
    ]) {
      expect(toArray(value)).toEqual([]);
    }
  });

  it('returns null for a missing, blank or non-string field', () => {
    expect(
      getStringField({ a: '  ' }, 'a'),
    ).toBeNull();
    expect(
      getStringField({ a: 5 }, 'a'),
    ).toBeNull();
    expect(
      getStringField(null, 'a'),
    ).toBeNull();
    expect(
      getStringField({ a: ' x ' }, 'a'),
    ).toBe('x');
  });

  it('accepts the unambiguous ISO shapes, including the one the API emits', () => {
    /*
     * Prisma serialises DateTime with toISOString, which always produces
     * the first form. The others are accepted because they are equally
     * unambiguous, not because anything currently sends them.
     */
    for (const value of [
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00+05:30',
      '2026-01-01',
    ]) {
      expect(
        getTimeField({ d: value }, 'd'),
      ).not.toBeNull();
    }
  });

  it('rejects a timestamp with no zone, because it means two different instants', () => {
    /*
     * ECMAScript reads a date-only string as UTC and a zoneless date-TIME
     * string as LOCAL, so this would land on a different instant per
     * device. Rejected rather than silently resolved.
     */
    for (const value of [
      '2026-01-01T00:00:00',
      '2026-01-01 00:00:00',
    ]) {
      expect(
        getTimeField({ d: value }, 'd'),
      ).toBeNull();
    }
  });

  it('never turns an unreadable date into a value', () => {
    expect(
      getTimeField(
        { d: 'Summer 2023' },
        'd',
      ),
    ).toBeNull();
    expect(
      getTimeField({ d: null }, 'd'),
    ).toBeNull();
    expect(
      getTimeField(
        { d: iso(2024, 3) },
        'd',
      ),
    ).toBe(Date.UTC(2024, 2, 1));
  });
});

/*
 * The whole surface against a brand-new user's payload. Every projection
 * has to produce an honest empty state rather than throwing, because this
 * is the first thing a real user sees.
 */
describe('empty graph across every projection', () => {
  const graph = emptyGraph();

  it('does not throw anywhere', () => {
    expect(() => {
      buildGraphModel(graph);
      buildCareerTimeline(graph);
      buildCareerStory(graph);
      buildEvidenceIndex(graph);
      buildDataQualityReport(graph);
    }).not.toThrow();
  });

  it('reports nothing rather than something', () => {
    expect(
      buildEvidenceIndex(graph).records,
    ).toEqual([]);
    expect(
      buildCareerTimeline(graph).isEmpty,
    ).toBe(true);
    expect(
      buildCareerStory(graph).isEmpty,
    ).toBe(true);
    expect(
      buildDataQualityReport(graph).isClean,
    ).toBe(true);
    expect(
      buildGraphModel(graph).counts
        .totalRecords,
    ).toBe(0);
  });

  it('does not throw on a null graph anywhere', () => {
    expect(() => {
      buildGraphModel(null);
      buildCareerTimeline(null);
      buildCareerStory(null);
      buildEvidenceIndex(null);
      buildDataQualityReport(null);
    }).not.toThrow();
  });
});

/*
 * An achievement with no evidence is a real finding the report should
 * make; it is also the shape most likely to be mis-projected, since
 * achievements are point events with an optional date.
 */
describe('achievements', () => {
  it('places a dated achievement as a point event', () => {
    const item = buildCareerTimeline(
      makeGraph({
        achievements: [
          makeAchievement({
            id: 'a-1',
            title: 'Award',
            occurredAt: iso(2022, 9),
          }),
        ],
      }),
    ).items[0];

    expect(item.isPointEvent).toBe(true);
    expect(item.rangeLabel).toBe('Sep 2022');
  });

  it('reports an achievement with no evidence', () => {
    expect(
      buildDataQualityReport(
        makeGraph({
          achievements: [
            makeAchievement({
              id: 'a-1',
              title: 'Award',
              occurredAt: iso(2022, 9),
            }),
          ],
        }),
      ).issues.map((i) => i.kind),
    ).toContain(
      'achievement-without-evidence',
    );
  });
});
