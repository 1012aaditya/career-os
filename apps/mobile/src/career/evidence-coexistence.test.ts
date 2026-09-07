/*
 * Evidence source coexistence on the Career Map.
 *
 * The map draws only GRAPH_CAPS.evidence records. Which ones it draws was
 * decided purely by recency: sort newest-first by capturedAt, take the
 * first five. That is fine while evidence trickles in one row at a time,
 * and wrong the moment a connector back-fills.
 *
 * A GitHub sync writes ~40 rows in one transaction, so every one of them
 * carries the same capturedAt — the sync's clock, not a career date. Those
 * 40 rows sweep the whole cap, and the resume the user actually uploaded
 * disappears from the drawn map while the disclosure line still says
 * "Showing 5 of 41 evidence records". Nothing is lost from the payload,
 * but the picture tells the user their resume is not in their graph.
 *
 * The fix is to interleave the selection by sourceType BEFORE the cap, so
 * a source that is present in the payload cannot be starved out of the
 * drawing by a bulkier neighbour.
 *
 * These tests are written against the FIXED behaviour and are asserted
 * through buildGraphModel and the drawn nodes only — never through the
 * selection helper itself, which is an implementation detail the model is
 * free to rename.
 *
 * A note on how source is read back: GraphNode carries id, entityId,
 * label, type and position — there is no sourceType on it, because the
 * node is a drawing primitive rather than a record. So each test builds a
 * record-id -> sourceType map from its own fixture and keys off
 * node.entityId, which is the stable Evidence.id.
 */

import {
  describe,
  expect,
  it,
} from 'vitest';

import type {
  CareerGraph,
  Evidence,
  EvidenceSourceType,
  IsoDateString,
} from '../api/career-graph';

import type {
  GraphModel,
  GraphNode,
} from './graph-model';
import {
  GRAPH_CAPS,
  buildGraphModel,
} from './graph-model';
import {
  deepReverse,
  iso,
  makeEvidence,
  makeGraph,
} from './test-fixtures';

/*
 * ----------------------------------------------------------------------
 * FIXTURE HELPERS
 * ----------------------------------------------------------------------
 */

/*
 * One evidence row of a stated source. Only RESUME rows keep the resume
 * import relation: a GitHub or LinkedIn row has no uploaded file behind
 * it, and leaving the default import attached would quietly make every
 * fixture look resume-derived to anything that reads provenance.
 */
function makeSourcedEvidence(
  id: string,
  source: EvidenceSourceType,
  capturedAt: IsoDateString,
): Evidence {
  const record = makeEvidence({
    id,
    sourceType: source,
    title: `${source}: ${id}`,
    capturedAt,
  });

  if (source === 'RESUME') {
    return record;
  }

  return {
    ...record,
    resumeImportId: null,
    resumeImport: null,
  };
}

/*
 * A run of rows from one source. `capturedAt` is a function of the index
 * so a caller can choose between the two shapes that matter: distinct
 * timestamps (rows that arrived one at a time) and a single shared
 * timestamp (a connector that wrote the whole batch at once — the shape
 * that broke the map).
 */
function sourceRun(
  source: EvidenceSourceType,
  count: number,
  capturedAt: (index: number) => IsoDateString,
): Evidence[] {
  const prefix = source.toLowerCase();

  return Array.from(
    { length: count },
    (_, index) =>
      makeSourcedEvidence(
        `ev-${prefix}-${String(index).padStart(2, '0')}`,
        source,
        capturedAt(index),
      ),
  );
}

/** Every row of a batch sync shares the sync's clock. */
function sameStamp(
  stamp: IsoDateString,
): () => IsoDateString {
  return () => stamp;
}

/*
 * ----------------------------------------------------------------------
 * READING THE DRAWN MAP
 * ----------------------------------------------------------------------
 */

function drawnEvidence(
  model: GraphModel,
): GraphNode[] {
  return model.nodes.filter(
    (node) => node.type === 'evidence',
  );
}

function drawnIds(
  model: GraphModel,
): string[] {
  return drawnEvidence(model).map(
    (node) => node.entityId,
  );
}

/*
 * The drawn sources, in drawn order. Throws rather than returning a hole
 * if a node's entityId is not a record in the payload: a drawn node with
 * no record behind it would be the map inventing evidence, which is a
 * worse failure than any ordering bug this file is about.
 */
function drawnSources(
  graph: CareerGraph,
  model: GraphModel,
): EvidenceSourceType[] {
  const sourceById = new Map(
    graph.evidence.map((record) => [
      record.id,
      record.sourceType,
    ]),
  );

  return drawnIds(model).map((id) => {
    const source = sourceById.get(id);

    if (!source) {
      throw new Error(
        `drawn evidence ${id} is not in the payload`,
      );
    }

    return source;
  });
}

/*
 * Stable serialization of the drawn slice. Position is included on
 * purpose: which records are drawn and the angle each sits at are both
 * index-derived, so a selection that changed order without changing
 * membership still redraws the map under the user.
 */
function drawnSignature(
  model: GraphModel,
): string {
  return JSON.stringify(drawnEvidence(model));
}

/*
 * ----------------------------------------------------------------------
 * SINGLE-SOURCE GRAPHS ARE UNTOUCHED
 * ----------------------------------------------------------------------
 */

describe('evidence from a single source', () => {
  /*
   * Interleaving across sources must be a no-op when there is only one
   * source to interleave. If these two moved, the fix would have changed
   * the map for every user who has never connected anything.
   */
  const dated = (index: number) =>
    iso(2026, 2, index + 1);

  it('draws the newest slice of a resume-only graph, newest first', () => {
    const graph = makeGraph({
      evidence: sourceRun(
        'RESUME',
        8,
        dated,
      ),
    });

    expect(
      drawnIds(buildGraphModel(graph)),
    ).toEqual([
      'ev-resume-07',
      'ev-resume-06',
      'ev-resume-05',
      'ev-resume-04',
      'ev-resume-03',
    ]);
  });

  it('draws the newest slice of a github-only graph, newest first', () => {
    const graph = makeGraph({
      evidence: sourceRun(
        'GITHUB',
        8,
        dated,
      ),
    });

    expect(
      drawnIds(buildGraphModel(graph)),
    ).toEqual([
      'ev-github-07',
      'ev-github-06',
      'ev-github-05',
      'ev-github-04',
      'ev-github-03',
    ]);
  });
});

/*
 * ----------------------------------------------------------------------
 * SOURCES COEXIST UNDER THE CAP
 * ----------------------------------------------------------------------
 */

describe('evidence sources coexist on the drawn map', () => {
  it('draws every record when both sources fit under the cap', () => {
    /*
     * Four records against a cap of five. Nothing has to be chosen, so
     * both sources are on the map whatever the selection rule is; what is
     * asserted is that interleaving did not silently drop one.
     *
     * Membership is asserted rather than order: with room to spare, the
     * order the two sources are woven in is a layout decision, not a
     * correctness one.
     */
    const graph = makeGraph({
      evidence: [
        ...sourceRun(
          'RESUME',
          2,
          (i) => iso(2026, 2, i * 2 + 1),
        ),
        ...sourceRun(
          'GITHUB',
          2,
          (i) => iso(2026, 2, i * 2 + 2),
        ),
      ],
    });

    const model = buildGraphModel(graph);

    expect(
      [...drawnIds(model)].sort(),
    ).toEqual([
      'ev-github-00',
      'ev-github-01',
      'ev-resume-00',
      'ev-resume-01',
    ]);

    expect(
      new Set(drawnSources(graph, model)),
    ).toEqual(
      new Set(['RESUME', 'GITHUB']),
    );
  });

  it('keeps the resume on the map after a github back-fill', () => {
    /*
     * D7, exactly as reported. Forty GitHub rows land in one sync and all
     * share its capturedAt, so all forty sort ahead of a resume captured
     * the month before. Under pure recency the cap is spent before the
     * resume is ever considered and the user's own uploaded resume
     * vanishes from the drawing.
     *
     * FAILS UNTIL THE INTERLEAVE LANDS.
     */
    const resume = makeSourcedEvidence(
      'ev-resume-00',
      'RESUME',
      iso(2026, 2, 1),
    );

    const graph = makeGraph({
      evidence: [
        ...sourceRun(
          'GITHUB',
          40,
          sameStamp(iso(2026, 3, 1)),
        ),
        resume,
      ],
    });

    const model = buildGraphModel(graph);

    expect(drawnIds(model)).toContain(
      'ev-resume-00',
    );

    /*
     * And the bulky source still gets the rest of the map: coexistence
     * means sharing the cap, not splitting it evenly between a source
     * with forty rows and a source with one.
     */
    expect(drawnIds(model)).toHaveLength(
      GRAPH_CAPS.evidence,
    );

    expect(
      drawnSources(graph, model).filter(
        (source) => source === 'GITHUB',
      ),
    ).toHaveLength(
      GRAPH_CAPS.evidence - 1,
    );
  });

  it('keeps the github row on the map when the resume import is the bulky side', () => {
    /*
     * The mirror. A resume import writes one row per parsed section, so
     * the resume side is just as capable of sweeping the cap. Nothing in
     * the fix may privilege RESUME as a source — it has to be about
     * source diversity, not about which source we happen to like.
     *
     * FAILS UNTIL THE INTERLEAVE LANDS.
     */
    const github = makeSourcedEvidence(
      'ev-github-00',
      'GITHUB',
      iso(2026, 2, 1),
    );

    const graph = makeGraph({
      evidence: [
        ...sourceRun(
          'RESUME',
          40,
          sameStamp(iso(2026, 3, 1)),
        ),
        github,
      ],
    });

    const model = buildGraphModel(graph);

    expect(drawnIds(model)).toContain(
      'ev-github-00',
    );

    expect(
      drawnSources(graph, model).filter(
        (source) => source === 'RESUME',
      ),
    ).toHaveLength(
      GRAPH_CAPS.evidence - 1,
    );
  });

  it('starves no source when three are present', () => {
    /*
     * Generalisation check. The rule cannot be "resume plus whatever
     * else": once LinkedIn is connected there are three sources for five
     * slots, and every one of them must appear. Written against
     * GRAPH_CAPS.evidence rather than the literal 5 so that lowering the
     * cap to 2 turns this into a real, visible failure instead of
     * silently passing on a stale assumption.
     *
     * FAILS UNTIL THE INTERLEAVE LANDS.
     */
    const sources: EvidenceSourceType[] = [
      'GITHUB',
      'RESUME',
      'LINKEDIN',
    ];

    const graph = makeGraph({
      evidence: [
        /* GitHub is newest wholesale, so it sweeps under recency. */
        ...sourceRun(
          'GITHUB',
          20,
          sameStamp(iso(2026, 4, 1)),
        ),
        ...sourceRun(
          'RESUME',
          20,
          (i) => iso(2026, 3, i + 1),
        ),
        ...sourceRun(
          'LINKEDIN',
          20,
          (i) => iso(2026, 2, i + 1),
        ),
      ],
    });

    const model = buildGraphModel(graph);

    expect(
      sources.length,
    ).toBeLessThanOrEqual(
      GRAPH_CAPS.evidence,
    );

    expect(
      new Set(drawnSources(graph, model)),
    ).toEqual(new Set(sources));
  });

  it('preserves chronological order within each source it draws', () => {
    /*
     * Interleaving reorders the drawn list across sources; it must not
     * reorder within one. If GitHub contributes three rows they have to
     * be that source's three newest, in its own newest-first order —
     * otherwise the map would be showing an arbitrary sample of a
     * connector rather than its most recent activity.
     */
    const graph = makeGraph({
      evidence: [
        ...sourceRun(
          'GITHUB',
          20,
          (i) => iso(2026, 4, i + 1),
        ),
        ...sourceRun(
          'RESUME',
          20,
          (i) => iso(2026, 3, i + 1),
        ),
        ...sourceRun(
          'LINKEDIN',
          20,
          (i) => iso(2026, 2, i + 1),
        ),
      ],
    });

    const model = buildGraphModel(graph);
    const drawn = drawnIds(model);
    const sources = drawnSources(
      graph,
      model,
    );

    for (const source of new Set(sources)) {
      const drawnFromSource = drawn.filter(
        (_, index) =>
          sources[index] === source,
      );

      /*
       * The source's own records, newest first, exactly as the model
       * would order them if this source were the only one in the graph.
       */
      const expected = drawnIds(
        buildGraphModel(
          makeGraph({
            evidence: graph.evidence.filter(
              (record) =>
                record.sourceType === source,
            ),
          }),
        ),
      ).slice(0, drawnFromSource.length);

      expect(drawnFromSource).toEqual(
        expected,
      );
    }
  });
});

/*
 * ----------------------------------------------------------------------
 * THE SELECTION STAYS DETERMINISTIC
 * ----------------------------------------------------------------------
 */

describe('evidence selection determinism', () => {
  /*
   * Same shape as the D7 payload: one source arriving as a batch, the
   * others spread out. Interleaving adds a grouping step to a path that
   * was a single sort, and a grouping keyed on iteration order is the
   * easy way to make the map flicker between refreshes.
   */
  function mixedGraph(): CareerGraph {
    return makeGraph({
      evidence: [
        ...sourceRun(
          'GITHUB',
          12,
          sameStamp(iso(2026, 4, 1)),
        ),
        ...sourceRun(
          'RESUME',
          6,
          (i) => iso(2026, 3, i + 1),
        ),
        ...sourceRun(
          'LINKEDIN',
          3,
          (i) => iso(2026, 2, i + 1),
        ),
      ],
    });
  }

  it('draws the same slice for two identical payloads', () => {
    expect(
      drawnSignature(
        buildGraphModel(mixedGraph()),
      ),
    ).toBe(
      drawnSignature(
        buildGraphModel(mixedGraph()),
      ),
    );
  });

  it('draws the same slice when the payload arrives in the opposite order', () => {
    /*
     * Transport order is a promise about a query, not a property of the
     * data. deepReverse is the suite's standing harness for that: a
     * reversal reproduces exactly, where a random shuffle would not.
     */
    const graph = mixedGraph();

    expect(
      drawnSignature(
        buildGraphModel(deepReverse(graph)),
      ),
    ).toBe(
      drawnSignature(
        buildGraphModel(graph),
      ),
    );
  });
});

/*
 * ----------------------------------------------------------------------
 * INTERLEAVING IS A PERMUTATION, NOT A FILTER
 * ----------------------------------------------------------------------
 */

describe('evidence totals and payload integrity', () => {
  function bulkyGraph(): CareerGraph {
    return makeGraph({
      evidence: [
        ...sourceRun(
          'GITHUB',
          40,
          sameStamp(iso(2026, 3, 1)),
        ),
        ...sourceRun(
          'RESUME',
          3,
          (i) => iso(2026, 2, i + 1),
        ),
      ],
    });
  }

  it('counts every record in the payload, not the ones it chose', () => {
    /*
     * The disclosure line is the only thing standing between the drawn
     * five and the user believing five is all they have. Reordering
     * selection must not touch it.
     */
    const graph = bulkyGraph();
    const model = buildGraphModel(graph);

    expect(
      model.counts.byType.evidence,
    ).toEqual({
      type: 'evidence',
      total: 43,
      displayed: GRAPH_CAPS.evidence,
      hidden: 43 - GRAPH_CAPS.evidence,
      isTruncated: true,
    });
  });

  it('never draws more than the cap', () => {
    const model = buildGraphModel(
      bulkyGraph(),
    );

    expect(
      drawnIds(model).length,
    ).toBeLessThanOrEqual(
      GRAPH_CAPS.evidence,
    );

    /* Nor the same record twice, which round-robin makes possible. */
    expect(
      new Set(drawnIds(model)).size,
    ).toBe(drawnIds(model).length);
  });

  it('leaves the payload it was handed untouched', () => {
    /*
     * Grouping and interleaving are exactly the kind of change that
     * reaches for an in-place sort or splice. The graph belongs to the
     * caller — react-query hands the model the cached object, so a
     * mutation here would corrupt every other consumer of that cache.
     */
    const graph = bulkyGraph();
    const before = JSON.stringify(graph);

    buildGraphModel(graph);

    expect(JSON.stringify(graph)).toBe(
      before,
    );
    expect(graph.evidence).toHaveLength(43);
  });
});

/*
 * ----------------------------------------------------------------------
 * ROWS WITH NO SOURCE
 * ----------------------------------------------------------------------
 */

describe('evidence with no stated source', () => {
  /*
   * The API type promises a sourceType on every row, but the model reads
   * the payload defensively everywhere else for a reason: a
   * partially-migrated or hand-inserted row can arrive without one. The
   * key is dropped rather than cast through `any`, so this stays a
   * statement about the runtime shape and not about the type system.
   */
  function withoutSource(
    record: Evidence,
  ): Evidence {
    const {
      sourceType: _dropped,
      ...rest
    } = record;

    return rest as Evidence;
  }

  it('neither crashes nor loses the record', () => {
    const graph = makeGraph({
      evidence: [
        ...sourceRun(
          'GITHUB',
          2,
          (i) => iso(2026, 3, i + 1),
        ),
        withoutSource(
          makeSourcedEvidence(
            'ev-unsourced-00',
            'OTHER',
            iso(2026, 2, 1),
          ),
        ),
      ],
    });

    expect(() =>
      buildGraphModel(graph),
    ).not.toThrow();

    const model = buildGraphModel(graph);

    /* Three records against a cap of five: all of them are drawn. */
    expect(
      model.counts.byType.evidence.total,
    ).toBe(3);

    expect(drawnIds(model)).toContain(
      'ev-unsourced-00',
    );
  });
});
