import { ScrollView, StyleSheet, View } from 'react-native';

import {
  AppText,
  Card,
  EmptyState,
  Screen,
  colors,
  spacing,
} from '../../ui';

export function OpportunitiesScreen() {
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="title">Opportunities</AppText>
          <AppText variant="body" muted style={styles.subtitle}>
            Discover opportunities aligned with your career.
          </AppText>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Recommended for you</AppText>

          <Card>
            <EmptyState
      title="No recommendations yet"
      message="Career OS needs more information about your experience, skills, and goals before it can recommend relevant opportunities."
      />
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Explore</AppText>

          <Card>
            <AppText variant="bodyMedium">
              Personalized discovery is coming soon.
            </AppText>

            <AppText variant="body" muted style={styles.cardText}>
              Future opportunities will be ranked based on how well they fit
              your career profile and direction.
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Why these opportunities?</AppText>

          <Card>
            <AppText variant="body" muted>
              Career OS will explain why each opportunity is relevant to you,
              including the skills, experience, and career direction that
              contributed to the match.
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Your opportunity profile</AppText>

          <Card>
            <AppText variant="bodyMedium">
              Your opportunity preferences will appear here.
            </AppText>

            <AppText variant="body" muted style={styles.cardText}>
              This will eventually help Career OS understand the kinds of
              roles and opportunities you want to pursue.
            </AppText>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },
  subtitle: {
    marginTop: spacing.xs,
  },
  section: {
    gap: spacing.sm,
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyIconText: {
    color: colors.primary,
  },
  cardTitle: {
    marginBottom: spacing.sm,
  },
  cardText: {
    marginTop: spacing.sm,
  },
});
