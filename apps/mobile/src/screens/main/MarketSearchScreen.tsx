import { useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  searchMarket,
  type MarketSearchPage,
  type MarketSearchResult,
} from '../../market/market-search-api';
import {
  expansionNote,
  freshnessLabel,
  groupingNote,
  publishedLabel,
  resultCountLabel,
  resultSubtitle,
} from '../../market/market-search-view';
import {
  AppText,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  colors,
  radius,
  spacing,
} from '../../ui';

/*
 * Search Shipaton.
 *
 * One box for what, one for where, one list of results. The five
 * publishers underneath are not a concept the reader has to hold: they
 * appear as a small attribution on a card and nowhere else. That is the
 * whole point of the Market Graph - the source complexity stays under the
 * product.
 *
 * This screen makes NO judgements. It renders what the API returned,
 * including the API's own explanation of its ordering, and computes
 * nothing about relevance itself. Everything it says about a result comes
 * from market-search-view.ts, which is pure and tested - so "what is this
 * screen allowed to claim" is a question with a test attached rather than
 * a matter of reading JSX.
 *
 * Nothing here is personalised, and nothing can be: the request carries
 * no user field, and there is nowhere in the response for one.
 */

const PAGE_SIZE = 20;

/*
 * Navigation through the hook, for the same reason the detail screen
 * reads its params through one: a required prop makes the
 * <Tab.Screen> that mounts this component fail to typecheck.
 */
type Navigate = { navigate: (screen: string, params: { id: string }) => void };

export function MarketSearchScreen() {
  const navigation = useNavigation() as unknown as Navigate;
  const [term, setTerm] = useState('');
  const [where, setWhere] = useState('');
  const [page, setPage] = useState<MarketSearchPage | null>(null);
  const [results, setResults] = useState<MarketSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Which request is current. A slow response for an old query must not
   * overwrite a fast one for a new query - the classic search race, where
   * the list settles on results for something the reader has already
   * finished typing over.
   */
  const requestId = useRef(0);

  const run = useCallback(async (q: string, location: string) => {
    const id = requestId.current + 1;

    requestId.current = id;

    setLoading(true);
    setError(null);

    try {
      const result = await searchMarket({
        q: q.trim() === '' ? undefined : q.trim(),
        location: location.trim() === '' ? undefined : location.trim(),
        limit: PAGE_SIZE,
      });

      if (requestId.current !== id) {
        return;
      }

      setPage(result);
      setResults(result.results);
    } catch (caught) {
      if (requestId.current !== id) {
        return;
      }

      /*
       * A 400 is the reader's problem to fix and its message is ours, so
       * it is shown. Anything else is not: a network error's message can
       * carry the request that produced it, and this screen has no way to
       * know what is in it.
       */
      const status = (caught as { status?: number }).status;

      setError(
        status === 400
          ? 'That search could not be run. Try different words.'
          : 'Could not reach the market right now.',
      );
      setPage(null);
      setResults([]);
    } finally {
      if (requestId.current === id) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void run('', '');
  }, [run]);

  const loadMore = useCallback(async () => {
    if (page === null || !page.page.hasMore || loadingMore) {
      return;
    }

    const cursor = page.page.nextCursor;

    if (cursor === null) {
      return;
    }

    setLoadingMore(true);

    try {
      const next = await searchMarket({
        q: term.trim() === '' ? undefined : term.trim(),
        location: where.trim() === '' ? undefined : where.trim(),
        limit: PAGE_SIZE,
        cursor,
      });

      setPage(next);
      setResults((current) => [...current, ...next.results]);
    } catch {
      /*
       * A failed page 2 leaves page 1 alone. Clearing the list because
       * the continuation failed would lose results the reader already
       * has, to report a problem with results they have not seen.
       */
      setPage((current) =>
        current === null
          ? null
          : { ...current, page: { ...current.page, hasMore: false } },
      );
    } finally {
      setLoadingMore(false);
    }
  }, [page, term, where, loadingMore]);

  const note = page === null ? null : expansionNote(page.query);
  const now = new Date();

  return (
    <View style={styles.screen}>
      <View style={styles.search}>
        <AppText variant="title" style={styles.heading}>
          Market
        </AppText>

        <TextInput
          style={styles.input}
          value={term}
          onChangeText={setTerm}
          placeholder="What are you looking for?"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => void run(term, where)}
        />

        <TextInput
          style={styles.input}
          value={where}
          onChangeText={setWhere}
          placeholder="Where?"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => void run(term, where)}
        />

        <Pressable
          style={styles.button}
          onPress={() => void run(term, where)}
          accessibilityRole="button"
        >
          <AppText variant="bodyMedium" style={styles.buttonText}>
            Search
          </AppText>
        </Pressable>
      </View>

      {loading ? (
        <LoadingState message="Searching the market..." />
      ) : error !== null ? (
        <ErrorState message={error} onRetry={() => void run(term, where)} />
      ) : results.length === 0 ? (
        <EmptyState
          title="No jobs found"
          message={
            term.trim() === '' && where.trim() === ''
              ? 'The market has nothing to show yet.'
              : 'Nothing matched. Try a broader job title, or a different place.'
          }
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onEndReachedThreshold={0.4}
          onEndReached={() => void loadMore()}
          ListHeaderComponent={
            <View style={styles.summary}>
              <AppText variant="bodyMedium">
                {page === null ? '' : resultCountLabel(page.page)}
              </AppText>

              {note === null ? null : (
                <AppText variant="caption" muted style={styles.note}>
                  {note}
                </AppText>
              )}
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.footer} color={colors.primary} />
            ) : null
          }
          renderItem={({ item }) => (
            <ResultCard
              result={item}
              now={now}
              onPress={() =>
                navigation.navigate('MarketPosting', { id: item.id })
              }
            />
          )}
        />
      )}
    </View>
  );
}

function ResultCard({
  result,
  now,
  onPress,
}: {
  result: MarketSearchResult;
  now: Date;
  onPress: () => void;
}) {
  const subtitle = resultSubtitle(result);
  const posted = publishedLabel(result.sourcePublishedAt, now);
  const freshness = freshnessLabel(result.freshness.verdict);
  const grouping = groupingNote(result);

  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <View style={styles.card}>
        <Card>
          <AppText variant="bodyMedium">{result.title}</AppText>

          {subtitle === '' ? null : (
            <AppText variant="caption" muted style={styles.line}>
              {subtitle}
            </AppText>
          )}

          {result.skills.length === 0 ? null : (
            <AppText variant="caption" muted style={styles.line}>
              {result.skills.slice(0, 4).join(' · ')}
            </AppText>
          )}

          {grouping === null ? null : (
            <AppText variant="caption" muted style={styles.line}>
              {grouping}
            </AppText>
          )}

          <View style={styles.meta}>
            <View style={[styles.pill, toneStyle(freshness.tone)]}>
              <AppText variant="caption" style={styles.pillText}>
                {freshness.text}
              </AppText>
            </View>

            {posted === null ? null : (
              <AppText variant="caption" muted>
                {posted}
              </AppText>
            )}

            {/* Attribution, small and present. Never the headline. */}
            <AppText variant="caption" muted>
              {result.source.slug}
            </AppText>
          </View>
        </Card>
      </View>
    </Pressable>
  );
}

function toneStyle(tone: ReturnType<typeof freshnessLabel>['tone']) {
  switch (tone) {
    case 'positive':
      return { backgroundColor: '#DCFCE7' };
    case 'caution':
      return { backgroundColor: '#FEE2E2' };
    case 'unknown':
      return { backgroundColor: '#FEF3C7' };
    default:
      return { backgroundColor: colors.muted };
  }
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  search: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    padding: spacing.md,
    paddingTop: spacing.lg,
  },
  heading: {
    marginBottom: spacing.md,
  },
  input: {
    backgroundColor: colors.muted,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 16,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
  },
  buttonText: {
    color: colors.primaryText,
  },
  list: {
    padding: spacing.md,
  },
  summary: {
    marginBottom: spacing.sm,
  },
  note: {
    marginTop: spacing.xs,
  },
  card: {
    marginBottom: spacing.sm,
  },
  line: {
    marginTop: spacing.xs,
  },
  meta: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: {
    color: colors.text,
  },
  footer: {
    paddingVertical: spacing.md,
  },
});
