import { useNavigation } from '@react-navigation/native';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { EvidenceCard, StrengthBadge } from '../../../evidence/EvidenceCard';
import {
  overviewOf,
  overviewSummary,
  strongestEvidence,
} from '../../../evidence/evidence-summary';
import { STRENGTH_SCOPE_NOTE } from '../../../evidence/evidence-view';
import { useEvidence } from '../../../evidence/useEvidence';
import {
  AppText,
  ErrorState,
  LoadingState,
  Screen,
  colors,
  radius,
  spacing,
  typography,
} from '../../../ui';

/*
 * Evidence home.
 *
 * The job of this screen is to answer "how well is my work actually
 * evidenced" in about four seconds, without ever implying a target. There
 * is no completeness meter and no percentage: nobody defined what 100%
 * would be, and inventing one would turn a proof layer into a game.
 */
export function EvidenceHomeScreen() {
  const navigation = useNavigation<{ navigate: (screen: string, params?: object) => void }>();
  const { data, loading, loaded, error, refreshError, reload } = useEvidence();

  const overview = overviewOf(data);
  const strongest = strongestEvidence(data.evidence, 3);

  if (loading && !loaded) {
    return (
      <Screen>
        <LoadingState message="Loading your evidence..." />
      </Screen>
    );
  }

  if (error !== null) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => void reload()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title">Evidence</AppText>
          <AppText style={styles.subtitle}>Your work. Your proof.</AppText>
        </View>

        {refreshError !== null ? (
          <Pressable onPress={() => void reload()} style={styles.refreshNotice}>
            <AppText style={styles.refreshNoticeText}>
              Could not refresh. Showing what was last loaded. Tap to retry.
            </AppText>
          </Pressable>
        ) : null}

        {overview.evidenceCount === 0 ? (
          <EmptyEvidence navigation={navigation} />
        ) : (
          <>
            <View style={styles.overviewCard}>
              <View style={styles.overviewRow}>
                <Metric
                  value={String(overview.evidenceCount)}
                  label={
                    overview.evidenceCount === 1 ? 'item' : 'items'
                  }
                />
                <Metric
                  value={String(overview.sourceCount)}
                  label={
                    overview.sourceCount === 1
                      ? 'independent source'
                      : 'independent sources'
                  }
                />
              </View>

              <AppText style={styles.overviewSummary}>
                {overviewSummary(overview)}
              </AppText>

              {overview.strongest !== null ? (
                <View style={styles.strengthRow}>
                  <AppText style={styles.strengthLabel}>
                    Strongest evidence
                  </AppText>
                  <StrengthBadge trustClass={overview.strongest} />
                </View>
              ) : null}

              {/*
                Stated here, once, under the only place a strength appears
                as a summary. Without it "Strong" beside a person's name
                reads as a verdict on the person.
              */}
              <AppText style={styles.scopeNote}>
                {STRENGTH_SCOPE_NOTE}
              </AppText>

              {overview.corroborated ? (
                <AppText style={styles.corroborated}>
                  More than one independent source describes your work.
                </AppText>
              ) : (
                <AppText style={styles.scopeNote}>
                  Everything so far comes from one source. A second
                  independent source is what makes evidence corroborated.
                </AppText>
              )}
            </View>

            <Section
              title="Strongest evidence"
              action="See all"
              onAction={() => navigation.navigate('AllEvidence')}
            >
              <View style={styles.list}>
                {strongest.map((item) => (
                  <EvidenceCard
                    key={item.id}
                    item={item}
                    onPress={() =>
                      navigation.navigate('EvidenceDetail', {
                        evidenceId: item.id,
                      })
                    }
                  />
                ))}
              </View>

              {overview.truncated ? (
                <AppText style={styles.truncated}>
                  More evidence exists than is shown here.
                </AppText>
              ) : null}
            </Section>
          </>
        )}

        <Section title="Strengthen your evidence">
          <View style={styles.list}>
            <ActionRow
              title="Connect another source"
              detail="Evidence a source confirms is stronger than evidence you describe."
              onPress={() => navigation.navigate('EvidenceSources')}
            />
            <ActionRow
              title="Add work manually"
              detail="For work that does not live behind an API."
              onPress={() => navigation.navigate('AddEvidence')}
            />
          </View>
        </Section>
      </ScrollView>
    </Screen>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.metric}>
      <AppText style={styles.metricValue}>{value}</AppText>
      <AppText style={styles.metricLabel}>{label}</AppText>
    </View>
  );
}

function Section({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <AppText style={styles.sectionTitle}>{title}</AppText>
        {action !== undefined && onAction !== undefined ? (
          <Pressable onPress={onAction} accessibilityRole="button">
            <AppText style={styles.sectionAction}>{action}</AppText>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function ActionRow({
  title,
  detail,
  onPress,
}: {
  title: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
    >
      <AppText style={styles.actionTitle}>{title}</AppText>
      <AppText style={styles.actionDetail}>{detail}</AppText>
    </Pressable>
  );
}

/*
 * The empty state, written for a fresher.
 *
 * A person with no GitHub and no confirmed resume is not a failure case -
 * they are most of the market. So this offers the two things they can
 * actually do and says nothing about what is missing.
 */
function EmptyEvidence({
  navigation,
}: {
  navigation: { navigate: (screen: string, params?: object) => void };
}) {
  return (
    <View style={styles.overviewCard}>
      <AppText style={styles.emptyTitle}>
        Your career evidence starts here.
      </AppText>
      <AppText style={styles.emptyBody}>
        Evidence is proof of work you have actually done — a repository, a
        project, a certificate, a case study. Career OS keeps it, and keeps
        track of how well each piece is known.
      </AppText>

      <View style={styles.list}>
        <ActionRow
          title="Add a project"
          detail="Describe something you built or delivered."
          onPress={() => navigation.navigate('AddEvidence')}
        />
        <ActionRow
          title="Connect a source"
          detail="Let a source confirm your work for you."
          onPress={() => navigation.navigate('EvidenceSources')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  header: {
    gap: spacing.xs,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  refreshNotice: {
    backgroundColor: colors.muted,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  refreshNoticeText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  overviewCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  overviewRow: {
    flexDirection: 'row',
    gap: spacing.xl,
  },
  metric: {
    gap: 2,
  },
  metricValue: {
    ...typography.title,
    color: colors.text,
  },
  metricLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  overviewSummary: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  strengthLabel: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  scopeNote: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  corroborated: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.success,
  },
  section: {
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    ...typography.heading,
    fontSize: 18,
    color: colors.text,
  },
  sectionAction: {
    ...typography.caption,
    color: colors.text,
    fontWeight: '600',
  },
  list: {
    gap: spacing.sm,
  },
  truncated: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingTop: spacing.xs,
  },
  actionRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 2,
  },
  pressed: {
    backgroundColor: colors.muted,
  },
  actionTitle: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  actionDetail: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  emptyTitle: {
    ...typography.heading,
    fontSize: 20,
    color: colors.text,
  },
  emptyBody: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
