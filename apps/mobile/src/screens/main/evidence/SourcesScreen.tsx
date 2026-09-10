import { useNavigation } from '@react-navigation/native';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useGithubConnection } from '../../../github/GithubConnectionProvider';
import {
  AVAILABILITY_LABELS,
  buildCatalogue,
  groupByAvailability,
  type SourceAvailability,
  type SourceEntry,
} from '../../../evidence/sources-catalogue';
import { useEvidence } from '../../../evidence/useEvidence';
import {
  AppText,
  Screen,
  colors,
  radius,
  spacing,
  typography,
} from '../../../ui';

/*
 * Where a person's work actually lives.
 *
 * A connector list is where career products quietly lie: a grid of logos
 * implies a grid of integrations, and a user who taps Figma and finds
 * nothing has learned that the rest of the screen might be decoration too.
 *
 * So there are three states, they look different, and only the
 * implemented ones can be opened.
 */
export function SourcesScreen() {
  const navigation = useNavigation<{
    navigate: (screen: string, params?: object) => void;
  }>();
  const github = useGithubConnection();
  const { data } = useEvidence();

  const hasResumeEvidence = data.evidence.some(
    (item) => item.sourceType === 'RESUME',
  );

  const catalogue = buildCatalogue({
    /*
     * Read from the connection's own state, not from the presence of
     * evidence: a connection that exists but has been revoked is not
     * "connected", and evidence from an earlier sync would still be here.
     */
    github: github.state === 'connected',
    resume: hasResumeEvidence,
  });

  const groups = groupByAvailability(catalogue);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title">Evidence sources</AppText>
          <AppText style={styles.subtitle}>
            Connect the places where your work actually exists.
          </AppText>
        </View>

        {groups.connected.length > 0 ? (
          <Group title="Connected" entries={groups.connected} navigation={navigation} />
        ) : null}

        {groups.available.length > 0 ? (
          <Group title="Available" entries={groups.available} navigation={navigation} />
        ) : null}

        <Group
          title="Coming soon"
          entries={groups.planned}
          navigation={navigation}
          note="These are not built yet. They are listed so you can see where Career OS is going — not as options you can use."
        />
      </ScrollView>
    </Screen>
  );
}

function Group({
  title,
  entries,
  navigation,
  note,
}: {
  title: string;
  entries: SourceEntry[];
  navigation: { navigate: (screen: string, params?: object) => void };
  note?: string;
}) {
  return (
    <View style={styles.group}>
      <AppText style={styles.groupTitle}>{title}</AppText>

      {note !== undefined ? (
        <AppText style={styles.groupNote}>{note}</AppText>
      ) : null}

      <View style={styles.list}>
        {entries.map((entry) => (
          <SourceRow
            key={entry.id}
            entry={entry}
            onPress={
              entry.openable
                ? () =>
                    navigation.navigate('EvidenceSourceDetail', {
                      sourceId: entry.id,
                    })
                : undefined
            }
          />
        ))}
      </View>
    </View>
  );
}

const PILL: Record<SourceAvailability, { bg: string; fg: string }> = {
  connected: { bg: '#ECFDF5', fg: '#047857' },
  available: { bg: colors.muted, fg: colors.textSecondary },
  planned: { bg: colors.muted, fg: colors.textSecondary },
};

function SourceRow({
  entry,
  onPress,
}: {
  entry: SourceEntry;
  onPress?: () => void;
}) {
  const pill = PILL[entry.availability];

  const body = (
    <View
      style={[
        styles.row,
        /*
          Unimplemented sources are visibly inert - dimmed, and with no
          affordance. Making them look identical to a working connector is
          the lie this screen is designed to avoid.
        */
        entry.availability === 'planned' && styles.rowPlanned,
      ]}
    >
      <View style={styles.rowText}>
        <AppText style={styles.rowName}>{entry.name}</AppText>
        <AppText style={styles.rowDetail}>{entry.description}</AppText>
      </View>

      <View style={[styles.pill, { backgroundColor: pill.bg }]}>
        <AppText style={[styles.pillText, { color: pill.fg }]}>
          {AVAILABILITY_LABELS[entry.availability]}
        </AppText>
      </View>
    </View>
  );

  if (onPress === undefined) {
    return body;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => pressed && styles.pressed}
    >
      {body}
    </Pressable>
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
    ...typography.caption,
    color: colors.textSecondary,
  },
  group: {
    gap: spacing.sm,
  },
  groupTitle: {
    ...typography.heading,
    fontSize: 17,
    color: colors.text,
  },
  groupNote: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  list: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rowPlanned: {
    opacity: 0.55,
    backgroundColor: colors.background,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  rowDetail: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
});
