import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  describe,
  expect,
  it,
} from 'vitest';

import { getCareerState } from './data-quality';
import { buildCareerTimeline } from './timeline';
import {
  makeExperience,
  makeGraph,
  iso,
} from './test-fixtures';

/*
 * Career state is the place the product is most able to lie: `isCurrent`
 * is a single boolean standing for two different facts, and rendering both
 * the same way asserts a job the user may not hold.
 *
 * These tests pin the distinction at both levels — the state machine, and
 * the string a person actually reads.
 */

describe('getCareerState', () => {
  it('reports a stated ongoing marker as fact', () => {
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2024, 3),
          endDateText: 'Present',
          isCurrent: true,
        }),
      ),
    ).toEqual({
      state: 'current',
      basis: 'stated-current',
    });
  });

  it.each([
    'present',
    'Current',
    'CURRENTLY',
    'now',
    'ongoing',
    'to date',
    'till date',
    'to present',
    'till present',
  ])(
    'treats %j as a stated ongoing marker',
    (marker) => {
      expect(
        getCareerState(
          makeExperience({
            id: 'x',
            title: 'Engineer',
            endDateText: marker,
            isCurrent: true,
          }),
        ).basis,
      ).toBe('stated-current');
    },
  );

  it('reports a missing end date as an inference, not a fact', () => {
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2022, 1),
          endDateText: null,
          isCurrent: true,
        }),
      ),
    ).toEqual({
      state: 'current',
      basis: 'assumed-current',
    });
  });

  it('does not accept unparseable end-date text as an ongoing marker', () => {
    /*
     * "2021 - 2022" is the shape ingestion cannot parse. It is evidence of
     * nothing, and must not be read as ongoing.
     */
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          endDateText: '2021 - 2022',
          isCurrent: true,
        }),
      ).basis,
    ).toBe('assumed-current');
  });

  it('lets a real end date win over the isCurrent flag', () => {
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2019, 1),
          endDate: iso(2021, 1),
          isCurrent: true,
        }),
      ),
    ).toEqual({
      state: 'ended',
      basis: 'conflicting',
    });
  });

  it('reports ended for a plain end date', () => {
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          endDate: iso(2021, 1),
        }),
      ),
    ).toEqual({
      state: 'ended',
      basis: 'has-end-date',
    });
  });

  it('reports unknown when the record says nothing either way', () => {
    expect(
      getCareerState(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2020, 1),
        }),
      ),
    ).toEqual({
      state: 'unknown',
      basis: 'no-signal',
    });
  });

  it('does not crash on null or malformed records', () => {
    for (const value of [
      null,
      undefined,
      42,
      'nonsense',
      {},
    ]) {
      expect(
        getCareerState(value).state,
      ).toBe('unknown');
    }
  });
});

/*
 * The rendered strings. getCareerState can be perfectly correct while the
 * UI still prints "Present" off an absent field, which is exactly what it
 * did before 6.9 — so the label is asserted, not just the state.
 */
describe('career state as rendered on the timeline', () => {
  const rowFor = (
    experience: ReturnType<
      typeof makeExperience
    >,
  ) => {
    const timeline = buildCareerTimeline(
      makeGraph({
        experiences: [experience],
      }),
    );

    const item = [
      ...timeline.items,
      ...timeline.undated,
    ][0];

    /* Mirrors TimelineRow's composition in CareerScreen. */
    const marker = item.isCurrent
      ? item.stateBasis === 'stated-current'
        ? 'Current'
        : 'Current (assumed)'
      : null;

    return [item.rangeLabel, marker]
      .filter(
        (part): part is string =>
          part !== null,
      )
      .join(' · ');
  };

  it('prints "Present" only when the source stated it', () => {
    expect(
      rowFor(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2024, 3),
          endDateText: 'Present',
          isCurrent: true,
        }),
      ),
    ).toBe('Mar 2024 — Present · Current');
  });

  it('never prints "Present" for an inferred current role', () => {
    const row = rowFor(
      makeExperience({
        id: 'x',
        title: 'Engineer',
        startDate: iso(2022, 1),
        endDateText: null,
        isCurrent: true,
      }),
    );

    expect(row).toBe(
      'From Jan 2022 · Current (assumed)',
    );
    expect(row).not.toContain('Present');
  });

  it('keeps the marker on a current role carrying no dates at all', () => {
    /*
     * The range is null here, so the marker is the only thing that can
     * report the state. It used to be dropped with the range, and before
     * that rendered as "Current · Current".
     */
    expect(
      rowFor(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          isCurrent: true,
        }),
      ),
    ).toBe('Current (assumed)');
  });

  it('does not mark an ended role as current', () => {
    expect(
      rowFor(
        makeExperience({
          id: 'x',
          title: 'Engineer',
          startDate: iso(2019, 1),
          endDate: iso(2021, 1),
        }),
      ),
    ).toBe('Jan 2019 — Jan 2021');
  });
});

/*
 * The one invariant that spans both apps.
 *
 * Ingestion decides `isCurrent` from its ONGOING_MARKERS list; the mobile
 * projection re-reads the persisted endDateText against its own copy to
 * decide whether that was STATED or merely assumed. The two files share no
 * package, so the list is duplicated by necessity, and both sides carry a
 * comment saying they must change together.
 *
 * A comment cannot enforce that. A value added on one side only silently
 * downgrades a stated fact to an inference — or upgrades an inference to a
 * fact — and every other test here would still pass. So the warning is
 * made executable: the API source is read and the two are compared.
 */
describe('ONGOING_MARKERS parity with ingestion', () => {
  it('reads every marker the API writes isCurrent from as a stated fact', () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../../api/src/career-graph/career-graph-ingestion.service.ts',
      ),
      'utf8',
    );

    const block = source.match(
      /ONGOING_MARKERS\s*=\s*\n?\s*new Set\(\[([\s\S]*?)\]\)/,
    );

    expect(block).not.toBeNull();

    const apiMarkers = [
      ...block![1].matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);

    expect(apiMarkers.length).toBe(9);

    /*
     * Asserted through getCareerState rather than against a copied array,
     * so this exercises the behaviour the two lists exist to produce
     * rather than just comparing two pieces of text.
     */
    for (const marker of apiMarkers) {
      expect(
        getCareerState(
          makeExperience({
            id: 'x',
            title: 'Engineer',
            endDateText: marker,
            isCurrent: true,
          }),
        ).basis,
      ).toBe('stated-current');
    }
  });
});
