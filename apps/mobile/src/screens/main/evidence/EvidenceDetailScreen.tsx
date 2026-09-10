import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { StrengthBadge } from '../../../evidence/EvidenceCard';
import {
  STRENGTH_SCOPE_NOTE,
  doesNotEstablishStatements,
  provenanceLabel,
  provenanceOf,
  relativeTime,
  reliabilityRows,
  sourceLabel,
  strengthLabel,
  supportedStatement,
  timelineOf,
  type Tone,
} from '../../../evidence/evidence-view';
import { useEvidence } from '../../../evidence/useEvidence';
import {
  AppText,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  colors,
  radius,
  spacing,
  typography,
} from '../../../ui';

/*
 * One piece of evidence, in full.
 *
 * The most important screen in the product, because it is where a claim
 * becomes checkable. Every section answers a question a sceptical reader
 * would ask, in the order they would ask it - and the last section answers
 * the one nobody asks and everybody should.
 */

type DetailRoute = RouteProp<
  { EvidenceDetail: { evidenceId: string } },
  'EvidenceDetail'
>;

const TONE_COLOR: Record<Tone, string> = {
  strong: '#047857',
  moderate: '#B45309',
  weak: '#1D4ED8',
  neutral: colors.textSecondary,
};

export function EvidenceDetailScreen() {
  const { evidenceId } = useRoute<DetailRoute>().params;
  const navigation = useNavigation();
  const { data, loading, loaded, error, reload } = useEvidence();

  if (loading && !loaded) {
    return (
      <Screen>
        <LoadingState message="Loading evidence..." />
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

  const item = data.evidence.find((candidate) => candidate.id === evidenceId);

  if (item === undefined) {
    return (
      <Screen>
        <EmptyState
          title="Evidence not found"
          message="This evidence is no longer in your list."
        />
      </Screen>
    );
  }

  const provenance = provenanceOf(item.reliability);
  const strength = strengthLabel(item.reliability.trustClass);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title">{item.title}</AppText>

          <View style={styles.headerRow}>
            <StrengthBadge trustClass={item.reliability.trustClass} />
            <AppText style={styles.sourceText}>
              {sourceLabel(item.sourceType)}
            </AppText>
          </View>

          <AppText style={styles.meaning}>{strength.meaning}</AppText>
        </View>

        {item.description !== null && item.description !== '' ? (
          <Section title="What we observed">
            <AppText style={styles.body}>{item.description}</AppText>
          </Section>
        ) : null}

        {/*
          The six dimensions, shown as themselves. A single number would
          be easier to render and impossible to argue with - which is the
          objection: "87" hides which part is weak.
        */}
        <Section title="Why we trust this">
          <View style={styles.rows}>
            {reliabilityRows(item.reliability, data.independentSources).map(
              (row) => (
                <View key={row.dimension} style={styles.reliabilityRow}>
                  <View style={styles.reliabilityHeader}>
                    <AppText style={styles.dimension}>{row.dimension}</AppText>
                    <AppText
                      style={[styles.value, { color: TONE_COLOR[row.tone] }]}
                    >
                      {row.value}
                    </AppText>
                  </View>
                  <AppText style={styles.detail}>{row.detail}</AppText>
                </View>
              ),
            )}
          </View>
        </Section>

        <Section title="Source">
          <View style={styles.sourceCard}>
            <AppText style={styles.sourceName}>
              {sourceLabel(item.sourceType)}
            </AppText>
            <AppText style={styles.detail}>
              {provenanceLabel(provenance)}
            </AppText>

            {item.sourceUrl !== null ? (
              <Pressable
                onPress={() => void Linking.openURL(item.sourceUrl!)}
                accessibilityRole="link"
                style={({ pressed }) => pressed && styles.pressed}
              >
                <AppText style={styles.link}>{item.sourceUrl}</AppText>
              </Pressable>
            ) : (
              <AppText style={styles.detail}>
                No link to check this against.
              </AppText>
            )}
          </View>
        </Section>

        {/*
          Three different questions that are constantly confused: when the
          work happened, when we recorded it, and when we last confirmed
          it. A missing one is omitted rather than filled in.
        */}
        <Section title="Timeline">
          <View style={styles.rows}>
            {timelineOf(item).map((entry) => (
              <View key={entry.label} style={styles.timelineRow}>
                <AppText style={styles.dimension}>{entry.label}</AppText>
                <AppText style={styles.detail}>
                  {relativeTime(entry.iso) ?? entry.iso}
                </AppText>
              </View>
            ))}
          </View>
        </Section>

        <Section title="What this supports">
          <AppText style={styles.body}>{supportedStatement(item)}</AppText>
        </Section>

        {/*
          Shown on every item regardless of strength. Putting the caveat
          only on weak evidence would imply that strong evidence does
          establish these - which is the exact inference the whole layer
          exists to prevent.
        */}
        <Section title="What this does not establish">
          <View style={styles.limits}>
            {doesNotEstablishStatements(item).map((limit) => (
              <View key={limit} style={styles.limitRow}>
                <AppText style={styles.limitBullet}>—</AppText>
                <AppText style={styles.limitText}>{limit}</AppText>
              </View>
            ))}
          </View>

          <AppText style={styles.scopeNote}>{STRENGTH_SCOPE_NOTE}</AppText>
        </Section>

        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <AppText style={styles.backText}>Back</AppText>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <AppText style={styles.sectionTitle}>{title}</AppText>
      {children}
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
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sourceText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  meaning: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.heading,
    fontSize: 17,
    color: colors.text,
  },
  body: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  rows: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  reliabilityRow: {
    padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 4,
  },
  reliabilityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  dimension: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  value: {
    ...typography.caption,
    fontWeight: '600',
    textAlign: 'right',
    flexShrink: 1,
  },
  detail: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sourceCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
  },
  sourceName: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  link: {
    fontSize: 13,
    color: colors.text,
    textDecorationLine: 'underline',
  },
  limits: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  limitRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  limitBullet: {
    color: colors.textSecondary,
  },
  limitText: {
    ...typography.caption,
    color: colors.text,
    flex: 1,
  },
  scopeNote: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  back: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
  },
  backText: {
    ...typography.caption,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.6,
  },
});
