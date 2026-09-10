import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, colors, radius, spacing, typography } from '../ui';

import type { EvidenceItem, TrustClass } from './evidence-api';
import {
  provenanceOf,
  relativeTime,
  sourceLabel,
  strengthLabel,
  type Tone,
} from './evidence-view';

/*
 * The shared pieces of the Evidence UI.
 *
 * Deliberately quiet. Strength is a small word on a tinted pill, not a
 * number in a ring, because the moment it becomes a figure people start
 * comparing figures - and there is nothing here that would survive being
 * compared.
 */

const TONE_COLORS: Record<Tone, { background: string; text: string }> = {
  strong: { background: '#ECFDF5', text: '#047857' },
  moderate: { background: '#FFFBEB', text: '#B45309' },
  weak: { background: '#EFF6FF', text: '#1D4ED8' },
  neutral: { background: colors.muted, text: colors.textSecondary },
};

export function StrengthBadge({
  trustClass,
  compact = false,
}: {
  trustClass: TrustClass;
  compact?: boolean;
}) {
  const { label, tone } = strengthLabel(trustClass);
  const palette = TONE_COLORS[tone];

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: palette.background },
        compact && styles.badgeCompact,
      ]}
    >
      <AppText style={[styles.badgeText, { color: palette.text }]}>
        {label}
      </AppText>
    </View>
  );
}

export function SourceBadge({ sourceType }: { sourceType: string }) {
  return (
    <View style={styles.sourceBadge}>
      <AppText style={styles.sourceBadgeText}>
        {sourceLabel(sourceType)}
      </AppText>
    </View>
  );
}

/**
 * One piece of evidence in a list.
 *
 * Shows, in order: what it is, how well it is known, where it came from,
 * and when it was last confirmed. A card that showed only the first two
 * would be an assertion; the last two are what make it checkable.
 */
export function EvidenceCard({
  item,
  onPress,
  now,
}: {
  item: EvidenceItem;
  onPress: () => void;
  now?: Date;
}) {
  const observed = relativeTime(item.lastObservedAt ?? item.capturedAt, now);
  const provenance = provenanceOf(item.reliability);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${
        strengthLabel(item.reliability.trustClass).label
      } evidence from ${sourceLabel(item.sourceType)}`}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardHeader}>
        <AppText style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </AppText>
        <StrengthBadge trustClass={item.reliability.trustClass} compact />
      </View>

      {item.description !== null && item.description !== '' ? (
        <AppText style={styles.cardBody} numberOfLines={2}>
          {item.description}
        </AppText>
      ) : null}

      <View style={styles.cardFooter}>
        <SourceBadge sourceType={item.sourceType} />

        {/*
          The provenance distinction, on every card rather than only in
          detail. It is the difference between "a source confirmed this"
          and "you told us", and a list that hides it invites the reader
          to assume the stronger one.
        */}
        <AppText style={styles.footerNote}>
          {provenance === 'observed' ? 'Observed' : 'Provided by you'}
        </AppText>

        {observed !== null ? (
          <AppText style={styles.footerNote}>· {observed}</AppText>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  badgeCompact: {
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  sourceBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
  },
  sourceBadgeText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardPressed: {
    backgroundColor: colors.muted,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitle: {
    ...typography.bodyMedium,
    flex: 1,
    color: colors.text,
  },
  cardBody: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  footerNote: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
