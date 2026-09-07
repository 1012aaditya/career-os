import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  buildEvidenceIndex,
  getEvidenceForEducation,
  getEvidenceForEntity,
  getEvidenceForSkill,
  getSupportState,
} from './evidence';
import { buildCareerTimeline } from './timeline';
import {
  iso,
  makeEducation,
  makeEvidence,
  makeEvidenceRecord,
  makeGraph,
  makeProject,
  richGraph,
} from './test-fixtures';

/*
 * Evidence is where the product makes its strongest claims, so these tests
 * are as much about what it must NOT say as what it must.
 */

describe('evidence projection', () => {
  const index = buildEvidenceIndex(
    richGraph(),
  );

  it('indexes the resume evidence row', () => {
    expect(index.records).toHaveLength(1);
    expect(index.records[0].id).toBe('ev-1');
  });

  it('resolves every entity type by id, including education', () => {
    expect(
      getEvidenceForSkill(index, 's-react'),
    ).toHaveLength(1);

    expect(
      getEvidenceForEducation(
        index,
        'edu-1',
      ),
    ).toHaveLength(1);

    for (const [type, id] of [
      ['experience', 'x-current'],
      ['project', 'p-1'],
      ['achievement', 'a-1'],
      ['education', 'edu-1'],
      ['skill', 's-react'],
    ] as const) {
      expect(
        getEvidenceForEntity(
          index,
          type,
          id,
        ),
      ).toHaveLength(1);
    }
  });

  it('reports an entity with no evidence as unsupported, not as absent', () => {
    expect(
      getSupportState(
        index,
        'skill',
        's-orphan',
      ),
    ).toBe('unsupported');

    expect(
      getSupportState(
        index,
        'skill',
        's-react',
      ),
    ).toBe('supported');
  });

  it('claims confirmation only for a resume the user actually confirmed', () => {
    const confirmed =
      buildEvidenceIndex(richGraph())
        .records[0];

    expect(confirmed.source.statement).toBe(
      'Confirmed from a resume you reviewed',
    );

    const pending = buildEvidenceIndex(
      makeGraph({
        evidence: [
          makeEvidence({
            id: 'ev-1',
            resumeImport: {
              id: 'import-1',
              fileName: 'cv.pdf',
              status: 'NEEDS_REVIEW',
              createdAt: iso(2026, 1),
            },
          }),
        ],
      }),
    ).records[0];

    expect(
      pending.source.statement,
    ).toBeNull();
  });

  it('groups links by type, then orders by name, so a capped slice is reproducible', () => {
    /*
     * The card renders the first six links and a "+N more" line, so this
     * order decides which six a person sees.
     *
     * readLinks sorts within one entity type and readEvidence concatenates
     * the types in a fixed order, so the result is type-grouped and then
     * alphabetical — not alphabetical overall. Both halves have to be
     * fixed for the slice to be reproducible, so both are asserted.
     */
    expect(
      buildEvidenceIndex(richGraph())
        .records[0].links.map((l) => l.name),
    ).toEqual([
      'Go',
      'React',
      'TypeScript',
      'Staff Engineer',
      'Career OS',
      'Patent granted',
      'MIT',
    ]);
  });
});

/*
 * Education was the last entity unable to say where it came from. 6.8 gave
 * it the join; 6.9 made the timeline read it. Both halves are pinned here,
 * because the failure mode was one screen contradicting another about the
 * same record.
 */
describe('education provenance', () => {
  const graph = richGraph();

  it('reports the source on the timeline', () => {
    const education = buildCareerTimeline(
      graph,
    ).items.find(
      (item) => item.type === 'education',
    );

    expect(education?.provenance).toEqual({
      known: true,
      sources: ['RESUME'],
      evidenceIds: ['ev-1'],
      label: 'From Resume',
    });
  });

  it('agrees with the detail sheet about the same record', () => {
    const timeline = buildCareerTimeline(
      graph,
    ).items.find(
      (item) => item.type === 'education',
    );

    const sheet = getEvidenceForEducation(
      buildEvidenceIndex(graph),
      'edu-1',
    );

    expect(timeline?.provenance.known).toBe(
      true,
    );
    expect(sheet).toHaveLength(1);
    expect(
      timeline?.provenance.evidenceIds,
    ).toEqual(sheet.map((r) => r.id));
  });

  it('still reports unknown when education genuinely has no evidence', () => {
    const education = buildCareerTimeline(
      makeGraph({
        educations: [
          makeEducation({
            id: 'edu-2',
            institution: 'Open University',
            startDate: iso(2010, 1),
          }),
        ],
      }),
    ).items.find(
      (item) => item.type === 'education',
    );

    expect(education?.provenance).toEqual({
      known: false,
      sources: [],
      evidenceIds: [],
      label: 'Source not recorded',
    });
  });
});

/*
 * Phase 7 adds GitHub. Nothing here builds GitHub ingestion — these only
 * check that a second source flows through the existing projection without
 * being mistaken for a resume or dropped.
 */
describe('multi-source readiness', () => {
  const graph = makeGraph({
    projects: [
      makeProject({
        id: 'p-1',
        name: 'career-os',
        startDate: iso(2024, 5),
        evidence: [
          {
            evidenceId: 'ev-gh',
            projectId: 'p-1',
            evidence: makeEvidenceRecord({
              id: 'ev-gh',
              sourceType: 'GITHUB',
              resumeImportId: null,
              title: 'Repository: career-os',
              sourceUrl:
                'https://github.com/x/career-os',
              externalId: 'R_1',
            }),
          },
        ],
      }),
    ],
    evidence: [
      makeEvidence({
        id: 'ev-gh',
        sourceType: 'GITHUB',
        resumeImportId: null,
        resumeImport: null,
        title: 'Repository: career-os',
        sourceUrl:
          'https://github.com/x/career-os',
        externalId: 'R_1',
        projects: [
          {
            evidenceId: 'ev-gh',
            projectId: 'p-1',
            project: {
              id: 'p-1',
              name: 'career-os',
            },
          },
        ],
      }),
    ],
  });

  it('projects GitHub evidence without a resume import', () => {
    const record = buildEvidenceIndex(graph)
      .records[0];

    expect(record.source.label).toBe(
      'GitHub',
    );
    expect(
      record.source.isConfirmedResume,
    ).toBe(false);
  });

  it('does not claim a GitHub record was a confirmed resume', () => {
    expect(
      buildEvidenceIndex(graph).records[0]
        .source.statement,
    ).toBeNull();
  });

  it('keeps the artifact URL and external id on the projection', () => {
    /*
     * For a resume both are null, so nothing is lost today. For a GitHub
     * record the URL is the evidence, and Phase 7 needs it to survive the
     * projection in order to render it.
     */
    const record = buildEvidenceIndex(graph)
      .records[0];

    expect(record.sourceUrl).toBe(
      'https://github.com/x/career-os',
    );
    expect(record.externalId).toBe('R_1');
  });

  it('supports an entity from a non-resume source', () => {
    expect(
      getSupportState(
        buildEvidenceIndex(graph),
        'project',
        'p-1',
      ),
    ).toBe('supported');
  });

  it('labels the source on the timeline', () => {
    const project = buildCareerTimeline(
      graph,
    ).items.find(
      (item) => item.type === 'project',
    );

    expect(project?.provenance.label).toBe(
      'From GitHub',
    );
  });

  it('distinguishes two sources backing the same record', () => {
    const both = makeGraph({
      ...graph,
      projects: [
        makeProject({
          id: 'p-1',
          name: 'career-os',
          startDate: iso(2024, 5),
          evidence: [
            {
              evidenceId: 'ev-gh',
              projectId: 'p-1',
              evidence: makeEvidenceRecord({
                id: 'ev-gh',
                sourceType: 'GITHUB',
                resumeImportId: null,
              }),
            },
            {
              evidenceId: 'ev-cv',
              projectId: 'p-1',
              evidence: makeEvidenceRecord({
                id: 'ev-cv',
                sourceType: 'RESUME',
              }),
            },
          ],
        }),
      ],
    });

    const project = buildCareerTimeline(
      both,
    ).items.find(
      (item) => item.type === 'project',
    );

    expect(project?.provenance.sources).toEqual(
      ['GITHUB', 'RESUME'],
    );
    expect(project?.provenance.label).toBe(
      'From GitHub, Resume',
    );
  });
});
