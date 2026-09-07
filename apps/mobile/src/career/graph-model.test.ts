import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  GRAPH_CAPS,
  buildGraphModel,
  describeTruncation,
  getEdgeEmphasis,
  getNodeEmphasis,
  isEdgeRendered,
  isTypeInLens,
  selectionFromNode,
} from './graph-model';
import {
  emptyGraph,
  iso,
  makeExperience,
  makeGraph,
  makeSkill,
  makeUserSkill,
  richGraph,
} from './test-fixtures';

describe('graph model', () => {
  const model = buildGraphModel(richGraph());

  it('always anchors on the person node', () => {
    expect(model.nodes[0].type).toBe(
      'person',
    );
  });

  it('identifies every node by its database id, never by name', () => {
    for (const node of model.nodes) {
      if (node.type === 'person') {
        continue;
      }

      /*
       * getSkillId and friends fall back to `index-N` when the payload
       * carries no id. A synthesised id in a real projection means the
       * model is keying on array position, which is not stable.
       */
      expect(node.entityId).not.toMatch(
        /^index-\d+$/,
      );
    }

    expect(
      model.nodes
        .filter((n) => n.type === 'skill')
        .map((n) => n.entityId),
    ).toEqual([
      's-react',
      's-ts',
      's-go',
      's-orphan',
    ]);
  });

  it('draws no edge to an entity that is not in the graph', () => {
    const nodeIds = new Set(
      model.nodes.map((n) => n.id),
    );

    for (const edge of model.edges) {
      expect(nodeIds.has(edge.from)).toBe(
        true,
      );
      expect(nodeIds.has(edge.to)).toBe(
        true,
      );
    }
  });

  it('draws no edge to a skill that was truncated out of the map', () => {
    /*
     * The case the assertion above cannot reach: richGraph has four skills
     * against a cap of eight, so no skill is ever left undrawn and a
     * phantom edge is impossible by construction. Here a role lists a
     * skill that the cap excludes, which is the only way the projection
     * can be tempted to point an edge at a node it never created.
     */
    const skills = Array.from(
      { length: 12 },
      (_, i) =>
        makeSkill(
          `s-${i}`,
          `Skill ${String(i).padStart(2, '0')}`,
        ),
    );

    const beyondCap = skills[11];

    const truncated = buildGraphModel(
      makeGraph({
        userSkills: skills.map((skill, i) =>
          makeUserSkill(
            skill,
            iso(2020, 1, i + 1),
          ),
        ),
        experiences: [
          makeExperience({
            id: 'x-1',
            title: 'Engineer',
            startDate: iso(2023, 1),
            skills: [
              {
                experienceId: 'x-1',
                skillId: beyondCap.id,
                skill: beyondCap,
              },
            ],
          }),
        ],
      }),
    );

    expect(
      truncated.nodes.some(
        (n) => n.entityId === beyondCap.id,
      ),
    ).toBe(false);

    const nodeIds = new Set(
      truncated.nodes.map((n) => n.id),
    );

    for (const edge of truncated.edges) {
      expect(nodeIds.has(edge.to)).toBe(true);
    }

    expect(
      truncated.edges.some((e) =>
        e.to.includes(beyondCap.id),
      ),
    ).toBe(false);
  });

  it('connects skills to the work that actually lists them', () => {
    const skillEdges = model.edges
      .filter(
        (e) => e.kind === 'experience-skill',
      )
      .map((e) => `${e.from}->${e.to}`);

    expect(skillEdges).toContain(
      'experience-x-current->skill-us-s-react',
    );
    expect(skillEdges).toContain(
      'experience-x-current->skill-us-s-ts',
    );

    /*
     * Fortran is one of the user's skills but is listed by no role and no
     * project. It keeps its person spoke — it IS their skill — and gains
     * no work edge, which is precisely the state data-quality reports as
     * "not connected to any work". Inventing an edge here would be the
     * graph claiming experience the resume never described.
     */
    const orphanEdgeKinds = model.edges
      .filter((e) =>
        e.to.includes('s-orphan'),
      )
      .map((e) => e.kind);

    expect(orphanEdgeKinds).toEqual([
      'person-skill',
    ]);
  });

  it('never duplicates an edge', () => {
    const ids = model.edges.map((e) => e.id);

    expect(new Set(ids).size).toBe(
      ids.length,
    );
  });
});

describe('graph caps and truncation disclosure', () => {
  /*
   * Deliberately delivered in REVERSE attachment order. Built in order,
   * the "deterministic subset" assertion below could not fail: it would
   * pass just as well against a projection that did no sorting at all and
   * simply took the payload's first eight.
   */
  const many = makeGraph({
    userSkills: Array.from(
      { length: 12 },
      (_, i) =>
        makeUserSkill(
          makeSkill(
            `s-${i}`,
            `Skill ${String(i).padStart(2, '0')}`,
          ),
          iso(2020, 1, i + 1),
        ),
    ).reverse(),
  });

  const model = buildGraphModel(many);

  it('draws only up to the cap', () => {
    expect(
      model.nodes.filter(
        (n) => n.type === 'skill',
      ),
    ).toHaveLength(GRAPH_CAPS.skill);
  });

  it('counts everything, not just what it drew', () => {
    expect(model.counts.byType.skill).toEqual(
      {
        type: 'skill',
        total: 12,
        displayed: GRAPH_CAPS.skill,
        hidden: 12 - GRAPH_CAPS.skill,
        isTruncated: true,
      },
    );
  });

  it('discloses the truncation rather than hiding it', () => {
    const note = describeTruncation(
      model.counts,
    );

    /* States what it drew against what exists — no vague "some hidden". */
    expect(note).toBe(
      'Showing 8 of 12 skills',
    );
  });

  it('says nothing when nothing was truncated', () => {
    expect(
      describeTruncation(
        buildGraphModel(richGraph())
          .counts,
      ),
    ).toBeNull();
  });

  it('draws a deterministic subset when it truncates', () => {
    /* The first eight by attachment date, not an arbitrary eight. */
    expect(
      model.nodes
        .filter((n) => n.type === 'skill')
        .map((n) => n.entityId),
    ).toEqual([
      's-0',
      's-1',
      's-2',
      's-3',
      's-4',
      's-5',
      's-6',
      's-7',
    ]);
  });
});

describe('graph lenses', () => {
  const graph = richGraph();

  it('keeps the person in every lens', () => {
    for (const lens of [
      'all',
      'skills',
      'experiences',
      'projects',
    ] as const) {
      expect(
        isTypeInLens('person', lens),
      ).toBe(true);
    }
  });

  it('focuses each lens on its own type', () => {
    expect(
      isTypeInLens('skill', 'skills'),
    ).toBe(true);
    expect(
      isTypeInLens('experience', 'skills'),
    ).toBe(false);
    expect(
      isTypeInLens('experience', 'all'),
    ).toBe(true);
  });

  it('dims rather than removes what a lens is not focused on', () => {
    const model = buildGraphModel(graph);

    const experience = model.nodes.find(
      (n) => n.type === 'experience',
    );
    const skill = model.nodes.find(
      (n) => n.type === 'skill',
    );

    expect(experience).toBeDefined();
    expect(
      getNodeEmphasis(experience!, 'skills'),
    ).toBe('dimmed');
    expect(
      getNodeEmphasis(skill!, 'skills'),
    ).toBe('full');
    expect(
      getNodeEmphasis(skill!, 'all'),
    ).toBe('full');
  });

  it('applies the same emphasis rule to edges', () => {
    const model = buildGraphModel(graph);

    const emphasisByKind = new Map(
      model.edges.map((edge) => [
        edge.kind,
        getEdgeEmphasis(edge, 'skills'),
      ]),
    );

    /* Under the Skills lens, edges touching a skill stay bright. */
    expect(
      emphasisByKind.get(
        'experience-skill',
      ),
    ).toBe('full');
    expect(
      emphasisByKind.get('person-skill'),
    ).toBe('full');

    /* Edges between two unfocused types recede. */
    expect(
      emphasisByKind.get(
        'person-experience',
      ),
    ).toBe('dimmed');

    /* Under All, nothing is dimmed. */
    for (const edge of model.edges) {
      expect(
        getEdgeEmphasis(edge, 'all'),
      ).toBe('full');
    }
  });

  it('keeps person spokes to evidence and achievements in the model but off the canvas', () => {
    /*
     * The relationship is real, so it stays in `edges`; it is suppressed
     * at render because the spoke crossed the whole canvas. A projection
     * that dropped it would be claiming the relationship does not exist.
     */
    const model = buildGraphModel(graph);

    for (const edge of model.edges) {
      const expected =
        edge.kind !== 'person-evidence' &&
        edge.kind !== 'person-achievement';

      expect(isEdgeRendered(edge)).toBe(
        expected,
      );
    }
  });

  it('is a property of rendering, not of the model', () => {
    /*
     * buildGraphModel takes no lens: switching lens re-emphasises the
     * same nodes rather than rebuilding a different graph, so a lens can
     * never suggest a record stopped existing.
     */
    const model = buildGraphModel(graph);

    const dimmedUnderSkills = model.nodes.filter(
      (node) =>
        getNodeEmphasis(node, 'skills') ===
        'dimmed',
    );

    expect(
      dimmedUnderSkills.length,
    ).toBeGreaterThan(0);

    expect(
      model.nodes.every(
        (node) =>
          getNodeEmphasis(node, 'all') ===
          'full',
      ),
    ).toBe(true);
  });
});

describe('selection', () => {
  it('carries the stable id, not the label', () => {
    const model = buildGraphModel(richGraph());

    const skill = model.nodes.find(
      (n) => n.type === 'skill',
    )!;

    const selection =
      selectionFromNode(skill);

    expect(selection?.entityIds).toEqual([
      skill.entityId,
    ]);
  });
});

describe('empty and malformed graphs', () => {
  it('still returns a person node for an empty graph', () => {
    const model = buildGraphModel(emptyGraph());

    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0].type).toBe(
      'person',
    );
    expect(model.edges).toEqual([]);
    expect(model.counts.totalRecords).toBe(0);
    expect(model.counts.isTruncated).toBe(
      false,
    );
  });

  it('does not throw on a null graph', () => {
    expect(() =>
      buildGraphModel(null),
    ).not.toThrow();

    expect(
      buildGraphModel(null).counts
        .totalRecords,
    ).toBe(0);
  });

  it('skips records missing the fields it needs, without inventing them', () => {
    const model = buildGraphModel(
      makeGraph({
        experiences: [
          makeExperience({
            id: 'x-1',
            title: 'Real Role',
            startDate: iso(2020, 1),
          }),
        ],
      }),
    );

    expect(
      model.nodes.filter(
        (n) => n.type === 'experience',
      ),
    ).toHaveLength(1);
  });
});
