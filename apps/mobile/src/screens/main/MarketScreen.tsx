import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  fetchRoleSkills,
  fetchRoleVolumes,
  sampleCaveat,
  sharePercent,
  type MarketRoleSkill,
  type MarketRoleVolume,
  type MarketWindow,
} from '../../market/market-api';
import {
  AppText,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  colors,
  spacing,
} from '../../ui';

/*
 * Minimal verification that the Market Graph reaches a device.
 *
 * This is deliberately NOT an opportunity screen and not a job board. It
 * shows what the market side of the product knows and, just as
 * importantly, what it does not: every number arrives with the sample it
 * came from, the window it covers and the employers behind it, and a
 * figure drawn from one employer says so in a sentence rather than leaving
 * the reader to infer it from a small number.
 *
 * Nothing here is personalised. No request carries anything about the user
 * beyond the bearer token the API requires, and the screen would render
 * identically for every account - which is what makes it the market rather
 * than a recommendation.
 */

type Selection = { slug: string; label: string } | null;

export function MarketScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<MarketWindow | null>(null);
  const [volumes, setVolumes] = useState<MarketRoleVolume[]>([]);
  const [selected, setSelected] = useState<Selection>(null);
  const [skills, setSkills] = useState<MarketRoleSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchRoleVolumes();

      setWindow(result.window);
      setVolumes(result.signals);
    } catch {
      /*
       * The caught error is not rendered. A network error's message can
       * carry the request that produced it, and this screen has no way to
       * know what is in it.
       */
      setError('Could not load the market graph.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectRole = useCallback(
    async (role: { slug: string; label: string }) => {
      setSelected(role);
      setSkillsLoading(true);

      try {
        const result = await fetchRoleSkills(role.slug);

        setSkills(result.signals);
      } catch {
        setSkills([]);
      } finally {
        setSkillsLoading(false);
      }
    },
    [],
  );

  if (loading) {
    return (
      <Screen>
        <LoadingState message="Loading the market graph..." />
      </Screen>
    );
  }

  if (error !== null) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => void load()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="title">Market</AppText>
          <AppText variant="body" muted style={styles.subtitle}>
            What employers are advertising. Not advice, and not about you.
          </AppText>
        </View>

        {window === null ? (
          <Card>
            <EmptyState
              title="No market snapshot yet"
              message="Nothing has been ingested. Run the market graph pipeline to produce a snapshot."
            />
          </Card>
        ) : (
          <Card>
            {/*
             * The source, first and unabbreviated.
             *
             * Without it this card said "127 employer boards" and left the
             * reader to assume that meant the job market. It means one
             * source's view of it - and which source was, until the API
             * started returning this, decided by whichever ingestion run
             * happened to finish last.
             */}
            <AppText variant="caption">{window.source.displayName}</AppText>
            <AppText variant="caption" muted>
              {`${window.scopes.length} employer boards · ${new Date(
                window.start,
              ).toLocaleDateString()} to ${new Date(
                window.end,
              ).toLocaleDateString()}`}
            </AppText>
            {/*
             * The provenance line. A count from a window in which a board
             * could not be read is a lower bound, and saying so is the
             * whole completeness contract as a reader experiences it.
             */}
            <AppText variant="caption" muted style={styles.caveat}>
              {window.coverageComplete
                ? 'Every board in scope was read completely.'
                : 'Some boards could not be read. Counts are lower bounds.'}
            </AppText>
          </Card>
        )}

        <View style={styles.section}>
          <AppText variant="heading">Roles by posting volume</AppText>
          <AppText variant="caption" muted style={styles.subtitle}>
            Postings, not openings — one requisition can be advertised
            several times.
          </AppText>

          {volumes.length === 0 ? (
            <Card>
              <EmptyState
                title="No signals"
                message="No role resolved to enough postings to report."
              />
            </Card>
          ) : (
            volumes.map((signal) => (
              <Pressable
                key={signal.id}
                onPress={() => void selectRole(signal.role)}
                style={styles.row}
              >
                <Card>
                  <View style={styles.rowHeader}>
                    <AppText variant="bodyMedium">{signal.role.label}</AppText>
                    <AppText variant="bodyMedium">
                      {signal.numeratorCount}
                    </AppText>
                  </View>
                  {/*
                   * The denominator is always shown next to the count. It
                   * is what turns "340" into a statement somebody can
                   * check.
                   */}
                  <AppText variant="caption" muted>
                    {`${signal.numeratorCount} of ${signal.denominatorCount} postings · ${signal.distinctCompanyCount} employers`}
                  </AppText>
                </Card>
              </Pressable>
            ))
          )}
        </View>

        {selected !== null && (
          <View style={styles.section}>
            <AppText variant="heading">{`Skills in ${selected.label} postings`}</AppText>

            {skillsLoading ? (
              <LoadingState message="Loading skills..." />
            ) : skills.length === 0 ? (
              <Card>
                <EmptyState
                  title="Nothing published for this role"
                  message="Too few postings, or too few employers, to report a share that would mean anything."
                />
              </Card>
            ) : (
              skills.map((signal) => {
                const caveat = sampleCaveat(signal);

                return (
                  <View key={signal.id} style={styles.row}>
                    <Card>
                      <View style={styles.rowHeader}>
                        <AppText variant="bodyMedium">
                          {signal.skill.label}
                        </AppText>
                        <AppText variant="bodyMedium">
                          {sharePercent(
                            signal.numeratorCount,
                            signal.denominatorCount,
                          )}
                        </AppText>
                      </View>
                      <AppText variant="caption" muted>
                        {`${signal.numeratorCount} of ${signal.denominatorCount} postings · ${signal.distinctCompanyCount} employers`}
                      </AppText>
                      {caveat !== null && (
                        <AppText variant="caption" style={styles.caveat}>
                          {caveat}
                        </AppText>
                      )}
                    </Card>
                  </View>
                );
              })
            )}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
    gap: spacing.lg,
  },
  subtitle: {
    marginTop: spacing.xs,
  },
  section: {
    gap: spacing.sm,
  },
  row: {
    marginTop: spacing.xs,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  caveat: {
    marginTop: spacing.xs,
    color: colors.textSecondary,
  },
});
