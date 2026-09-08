import { useRoute, type RouteProp } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  fetchPosting,
  type MarketPostingDetail,
} from '../../market/market-search-api';
import {
  freshnessCaveat,
  freshnessLabel,
  publishedLabel,
} from '../../market/market-search-view';
import {
  AppText,
  Card,
  ErrorState,
  LoadingState,
  colors,
  radius,
  spacing,
} from '../../ui';

/*
 * One job, in full.
 *
 * The important thing this screen does is END somewhere else. Apply goes
 * to the publisher's own page and there is no Shipaton application flow
 * behind it - we are not the employer, we did not post the job, and a
 * button that implied otherwise would be the single most misleading thing
 * in the product.
 *
 * The description shown here has been redacted server-side. That is worth
 * knowing when reading this file: a body may contain a recruiter's phone
 * number, the ingestion redactor misses entity-encoded ones, and the read
 * path removes them again on the way out. The device never sees the
 * unredacted text.
 */

/*
 * Params read through the hook rather than declared as a prop.
 *
 * The navigator's screen type expects a component taking no required
 * props, so annotating `route` as required makes the <Stack.Screen> that
 * mounts it fail to typecheck. The hook is the typed way in.
 */
type MarketPostingRoute = RouteProp<
  { MarketPosting: { id: string } },
  'MarketPosting'
>;

export function MarketPostingScreen() {
  const { id } = useRoute<MarketPostingRoute>().params;

  const [posting, setPosting] = useState<MarketPostingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setPosting(await fetchPosting(id));
    } catch (caught) {
      const status = (caught as { status?: number }).status;

      setError(
        status === 404
          ? 'This job is no longer available.'
          : 'Could not load this job right now.',
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <LoadingState message="Loading job..." />;
  }

  if (error !== null || posting === null) {
    return (
      <ErrorState
        message={error ?? 'Could not load this job right now.'}
        onRetry={() => void load()}
      />
    );
  }

  const freshness = freshnessLabel(posting.freshness.verdict);
  const caveat = freshnessCaveat(posting.freshness);
  const posted = publishedLabel(posting.sourcePublishedAt, new Date());

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <AppText variant="heading">{posting.title}</AppText>

      {posting.company === null ? null : (
        <AppText variant="body" style={styles.line}>
          {posting.company}
        </AppText>
      )}

      {posting.location === null ? null : (
        <AppText variant="body" muted style={styles.line}>
          {posting.location}
        </AppText>
      )}

      <View style={styles.meta}>
        <View style={styles.pill}>
          <AppText variant="caption">{freshness.text}</AppText>
        </View>

        {posted === null ? null : (
          <AppText variant="caption" muted>
            {posted}
          </AppText>
        )}
      </View>

      {caveat === null ? null : (
        <AppText variant="caption" muted style={styles.caveat}>
          {caveat}
        </AppText>
      )}

      {posting.role === null ? null : (
        <View style={styles.card}>
          <Card>
            <AppText variant="caption" muted>
              Canonical role
            </AppText>
            <AppText variant="bodyMedium">{posting.role.label}</AppText>
          </Card>
        </View>
      )}

      {posting.skills.length === 0 ? null : (
        <View style={styles.card}>
          <Card>
            <AppText variant="caption" muted>
              Skills mentioned
            </AppText>
            <AppText variant="body">
              {posting.skills.map((skill) => skill.label).join(' · ')}
            </AppText>
          </Card>
        </View>
      )}

      <View style={styles.card}>
        <Card>
          <AppText variant="caption" muted>
            Description
          </AppText>

          {/*
           * A posting with no body is common rather than exceptional: 63,804
           * of 76,968 in this corpus carry none, because most open job-bank
           * data publishes structured fields and no advert text. Saying so
           * is better than an empty panel that reads like a failure.
           */}
          <AppText variant="body" style={styles.line}>
            {posting.description ??
              'This publisher does not provide a description. Open the original posting to read the full advert.'}
          </AppText>
        </Card>
      </View>

      {/*
       * Provenance in a reader's vocabulary: who published it, and when we
       * last saw it. Not the run id, not the adapter version.
       */}
      <View style={styles.card}>
        <Card>
          <AppText variant="caption" muted>
            Source
          </AppText>
          <AppText variant="body">
            {posting.provenance.source?.displayName ?? 'Unknown source'}
          </AppText>
          <AppText variant="caption" muted style={styles.line}>
            Last observed{' '}
            {new Date(posting.provenance.lastObservedAt)
              .toISOString()
              .slice(0, 10)}
          </AppText>
        </Card>
      </View>

      {posting.applyUrl === null ? (
        <AppText variant="caption" muted style={styles.caveat}>
          This publisher did not provide an application link.
        </AppText>
      ) : (
        <Pressable
          style={styles.apply}
          accessibilityRole="link"
          onPress={() => {
            /*
             * Fire and forget, deliberately. A failed openURL means the
             * device has no handler for the link; there is nothing this
             * screen can do about it and nothing useful to say.
             */
            void Linking.openURL(posting.applyUrl!);
          }}
        >
          <AppText variant="bodyMedium" style={styles.applyText}>
            Apply on the original posting
          </AppText>
        </Pressable>
      )}

      <AppText variant="caption" muted style={styles.caveat}>
        Applications are handled by the publisher, not by Shipaton.
      </AppText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
  },
  line: {
    marginTop: spacing.xs,
  },
  meta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  pill: {
    backgroundColor: colors.muted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  caveat: {
    marginTop: spacing.sm,
  },
  card: {
    marginTop: spacing.md,
  },
  apply: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
  },
  applyText: {
    color: colors.primaryText,
  },
});
