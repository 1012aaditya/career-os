import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  buildGraphModel,
  describeTruncation,
  getEdgeEmphasis,
  getNodeEmphasis,
} from './graph-model';
import { buildCareerTimeline } from './timeline';
import { buildCareerStory } from './story';
import { buildEvidenceIndex } from './evidence';
import { buildDataQualityReport } from './data-quality';
import { getEntityRelations } from './relations';
import {
  deepReverse,
  iso,
  makeExperience,
  makeGraph,
  makeSkill,
  makeUserSkill,
  richGraph,
} from './test-fixtures';

/*
 * The freeze contract's determinism clause, tested as a property rather
 * than case by case: the same logical graph, delivered with every
 * collection in the opposite order, must project to a byte-identical
 * result.
 *
 * Reversal reaches the nested join collections too — an experience's
 * skills, an evidence row's links — which is where the ordering was
 * actually missing. The API now orders them, but a projection that only
 * works because the server sorted for it is one query change away from
 * showing the user something different between refreshes.
 */

const graph = richGraph();
const reversed = deepReverse(graph);

/* The reversal must actually be doing something, or every test below is vacuous. */
describe('the determinism harness itself', () => {
  it('really does reorder the payload', () => {
    expect(reversed).not.toEqual(graph);

    expect(
      reversed.experiences.map((x) => x.id),
    ).toEqual(
      [...graph.experiences]
        .map((x) => x.id)
        .reverse(),
    );

    expect(
      reversed.evidence[0].skills.map(
        (s) => s.skillId,
      ),
    ).toEqual(
      [...graph.evidence[0].skills]
        .map((s) => s.skillId)
        .reverse(),
    );
  });

  it('does not mutate the original', () => {
    expect(richGraph()).toEqual(graph);
  });
});

describe('projection determinism under reordered input', () => {
  it('graph model: nodes, edges and counts are identical', () => {
    const a = buildGraphModel(graph);
    const b = buildGraphModel(reversed);

    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges).toEqual(a.edges);
    expect(b.counts).toEqual(a.counts);
  });

  it('graph model: node and edge emphasis is identical under every lens', () => {
    /*
     * The model itself carries no lens — a lens is applied at render, as
     * emphasis. So determinism has to be checked on what the lens
     * produces, not on the model alone.
     */
    const a = buildGraphModel(graph);
    const b = buildGraphModel(reversed);

    for (const lens of [
      'all',
      'skills',
      'experiences',
      'projects',
    ] as const) {
      expect(
        b.nodes.map((node) =>
          getNodeEmphasis(node, lens),
        ),
      ).toEqual(
        a.nodes.map((node) =>
          getNodeEmphasis(node, lens),
        ),
      );

      expect(
        b.edges.map((edge) =>
          getEdgeEmphasis(edge, lens),
        ),
      ).toEqual(
        a.edges.map((edge) =>
          getEdgeEmphasis(edge, lens),
        ),
      );
    }
  });

  it('timeline: order, groups and undated bucket are identical', () => {
    const a = buildCareerTimeline(graph);
    const b = buildCareerTimeline(reversed);

    expect(b.items.map((i) => i.id)).toEqual(
      a.items.map((i) => i.id),
    );
    expect(b.groups).toEqual(a.groups);
    expect(b.undated).toEqual(a.undated);
    expect(b.counts).toEqual(a.counts);
  });

  it('story: headline and lines are identical', () => {
    expect(
      buildCareerStory(reversed),
    ).toEqual(buildCareerStory(graph));
  });

  it('evidence: records and their link order are identical', () => {
    const a = buildEvidenceIndex(graph);
    const b = buildEvidenceIndex(reversed);

    expect(
      b.records.map((r) => r.id),
    ).toEqual(a.records.map((r) => r.id));

    expect(b.records[0].links).toEqual(
      a.records[0].links,
    );
  });

  it('data quality: findings are identical', () => {
    expect(
      buildDataQualityReport(reversed),
    ).toEqual(
      buildDataQualityReport(graph),
    );
  });

  it('relations: groups are identical', () => {
    const selection = {
      type: 'experience' as const,
      entityIds: ['x-current'],
      label: 'Staff Engineer',
    };

    expect(
      getEntityRelations(
        selection,
        reversed,
      ),
    ).toEqual(
      getEntityRelations(selection, graph),
    );
  });
});

/*
 * Determinism matters most exactly where the map truncates, because there
 * the payload order decides not just the arrangement but WHICH records the
 * user is shown at all. No fixture above exceeds a cap, so that half of the
 * claim would otherwise go untested.
 */
describe('determinism when the graph is truncated', () => {
  const skills = Array.from(
    { length: 20 },
    (_, i) =>
      makeSkill(
        `s-${i}`,
        `Skill ${String(i).padStart(2, '0')}`,
      ),
  );

  const big = makeGraph({
    userSkills: skills.map((skill, i) =>
      makeUserSkill(skill, iso(2020, 1, i + 1)),
    ),
    experiences: Array.from(
      { length: 9 },
      (_, i) =>
        makeExperience({
          id: `x-${i}`,
          title: `Role ${i}`,
          startDate: iso(2015 + i, 1),
          skills: [
            {
              experienceId: `x-${i}`,
              skillId: skills[i].id,
              skill: skills[i],
            },
          ],
        }),
    ),
  });

  it('really is truncated, or the test proves nothing', () => {
    expect(
      buildGraphModel(big).counts.isTruncated,
    ).toBe(true);
  });

  it('draws the same records regardless of payload order', () => {
    const a = buildGraphModel(big);
    const b = buildGraphModel(
      deepReverse(big),
    );

    expect(
      b.nodes.map((n) => n.entityId),
    ).toEqual(a.nodes.map((n) => n.entityId));
    expect(b.edges).toEqual(a.edges);
    expect(b.counts).toEqual(a.counts);
  });

  it('reports the same truncation disclosure either way', () => {
    expect(
      describeTruncation(
        buildGraphModel(deepReverse(big))
          .counts,
      ),
    ).toEqual(
      describeTruncation(
        buildGraphModel(big).counts,
      ),
    );
  });
});

/*
 * Determinism also has to hold across repeated calls on one payload —
 * nothing may depend on call order, a cache, or a mutation of the input.
 */
describe('repeat-call stability', () => {
  it('produces the same projection twice, and leaves the graph untouched', () => {
    const before = structuredClone(graph);

    const first = {
      model: buildGraphModel(graph),
      timeline: buildCareerTimeline(graph),
      story: buildCareerStory(graph),
      evidence: buildEvidenceIndex(graph),
      quality:
        buildDataQualityReport(graph),
    };

    const second = {
      model: buildGraphModel(graph),
      timeline: buildCareerTimeline(graph),
      story: buildCareerStory(graph),
      evidence: buildEvidenceIndex(graph),
      quality:
        buildDataQualityReport(graph),
    };

    expect(second).toEqual(first);
    expect(graph).toEqual(before);
  });
});
