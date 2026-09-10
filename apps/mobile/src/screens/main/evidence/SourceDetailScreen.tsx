import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useGithubConnection } from '../../../github/GithubConnectionProvider';
import { relativeTime, sourceLabel } from '../../../evidence/evidence-view';
import { useEvidence } from '../../../evidence/useEvidence';
import {
  AppText,
  EmptyState,
  Screen,
  colors,
  radius,
  spacing,
  typography,
} from '../../../ui';

/*
 * One source, and what it has actually contributed.
 *
 * All sync behaviour is the existing GitHub provider's - this screen calls
 * it and renders what it reports. Nothing about connecting, syncing or
 * disconnecting is reimplemented here, so there is no second version of
 * that logic to drift.
 */

type SourceRoute = RouteProp<
  { EvidenceSourceDetail: { sourceId: string } },
  'EvidenceSourceDetail'
>;

export function SourceDetailScreen() {
  const { sourceId } = useRoute<SourceRoute>().params;
  const navigation = useNavigation();

  if (sourceId === 'github') {
    return <GithubSourceDetail onBack={() => navigation.goBack()} />;
  }

  if (sourceId === 'resume') {
    return <ResumeSourceDetail onBack={() => navigation.goBack()} />;
  }

  return (
    <Screen>
      <EmptyState
        title="Not available"
        message="This source is not part of Career OS yet."
      />
    </Screen>
  );
}

function GithubSourceDetail({ onBack }: { onBack: () => void }) {
  const github = useGithubConnection();
  const { data } = useEvidence();

  const items = data.evidence.filter((item) => item.sourceType === 'GITHUB');

  const connected = github.state === 'connected';
  const lastSynced = relativeTime(github.status?.lastSyncedAt ?? null);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title">GitHub</AppText>
          <AppText style={styles.state}>
            {connected ? 'Connected' : 'Not connected'}
          </AppText>
          {github.status?.login != null ? (
            <AppText style={styles.detail}>@{github.status.login}</AppText>
          ) : null}
        </View>

        {github.message !== null ? (
          <View style={styles.notice}>
            <AppText style={styles.noticeText}>{github.message}</AppText>
          </View>
        ) : null}

        <View style={styles.card}>
          <Row
            label="Evidence items"
            value={String(items.length)}
          />
          <Row
            label="Last sync"
            value={lastSynced ?? 'Not synced yet'}
          />
          <Row
            label="Connection status"
            value={github.status?.status ?? 'Unknown'}
          />
        </View>

        {/*
          Repository coverage is deliberately absent.

          The status endpoint does not report it - reposScanned and
          reposTotal come back from a SYNC, not from status - so showing
          "14 / 14" here would mean either caching a number from an
          earlier session or inventing one. Both would state a coverage
          nobody just measured, on a screen whose entire subject is what
          is actually known.
        */}
        <AppText style={styles.coverageNote}>
          Repository coverage is reported by a sync, not by this screen.
          Run a sync to see how much of your account was covered.
        </AppText>

        <View style={styles.actions}>
          {connected ? (
            <>
              <Action
                label={github.state === 'syncing' ? 'Syncing...' : 'Sync now'}
                onPress={() => void github.sync()}
                disabled={github.state === 'syncing'}
              />
              <Action
                label="Disconnect"
                tone="danger"
                onPress={() => void github.disconnect()}
              />
            </>
          ) : (
            <Action
              label={
                github.state === 'connecting'
                  ? 'Connecting...'
                  : 'Connect GitHub'
              }
              onPress={() => void github.connect()}
              disabled={github.state === 'connecting'}
            />
          )}
        </View>

        <Pressable onPress={onBack} accessibilityRole="button">
          <AppText style={styles.back}>Back</AppText>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function ResumeSourceDetail({ onBack }: { onBack: () => void }) {
  const { data } = useEvidence();

  const items = data.evidence.filter((item) => item.sourceType === 'RESUME');
  const latest = items[0];

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title">{sourceLabel('RESUME')}</AppText>
          <AppText style={styles.state}>
            {items.length > 0 ? 'Provided by you' : 'None yet'}
          </AppText>
        </View>

        <View style={styles.card}>
          <Row label="Evidence items" value={String(items.length)} />
          <Row
            label="Most recent"
            value={
              latest !== undefined
                ? relativeTime(latest.capturedAt) ?? latest.capturedAt
                : 'None'
            }
          />
        </View>

        {/*
          The honesty that matters for this source. A resume is the user's
          own account of their work, and the app must not let it sit beside
          GitHub looking equally confirmed.
        */}
        <AppText style={styles.coverageNote}>
          A resume is your own account of your work. It is real evidence,
          and it is not independently confirmed by anyone else — which is
          why it is shown as weaker than evidence a source verified.
        </AppText>

        <Pressable onPress={onBack} accessibilityRole="button">
          <AppText style={styles.back}>Back</AppText>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <AppText style={styles.rowLabel}>{label}</AppText>
      <AppText style={styles.rowValue}>{value}</AppText>
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled = false,
  tone = 'default',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.action,
        tone === 'danger' && styles.actionDanger,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <AppText
        style={[
          styles.actionText,
          tone === 'danger' && styles.actionTextDanger,
        ]}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  header: { gap: spacing.xs },
  state: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  detail: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  notice: {
    backgroundColor: colors.muted,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noticeText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  rowValue: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  coverageNote: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  actions: { gap: spacing.sm },
  action: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  actionDanger: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  actionDisabled: { opacity: 0.5 },
  actionText: {
    ...typography.bodyMedium,
    color: colors.primaryText,
  },
  actionTextDanger: { color: colors.danger },
  pressed: { opacity: 0.8 },
  back: {
    ...typography.caption,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },
});
