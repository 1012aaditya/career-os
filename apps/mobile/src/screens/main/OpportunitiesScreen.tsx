import { ScrollView, StyleSheet, View } from 'react-native';

import {
  AppText,
  Card,
  EmptyState,
  Screen,
  spacing,
} from '../../ui';

/*
 * Opportunities, before there is an Opportunity Engine.
 *
 * WHAT THIS SCREEN USED TO SAY, and why it had to change. It carried a
 * section headed "Recommended for you" whose empty state read "Career OS
 * needs more information about your experience, skills, and goals before
 * it can recommend relevant opportunities" - which tells a user that a
 * recommendation engine exists and is waiting on them. It does not exist.
 * A user who then imported a resume, connected GitHub and completed their
 * profile would return to exactly the same empty state, having been told
 * the fault was theirs.
 *
 * That is the kind of copy that costs trust in a product whose whole claim
 * is to be evidence-first and explainable.
 *
 * So the screen now says the true thing: this is not built yet. It shows
 * no recommendations, invents no opportunity data, and does NOT quietly
 * call Market Search and present the results as though they had been
 * matched to the user - which would be the same claim with more steps.
 *
 * The matching itself is Phase 12. When it lands this screen gains the
 * sections it needs; until then it is honest and structurally sound.
 */
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
            Matching your career profile to the market.
          </AppText>
        </View>

        <Card>
          <EmptyState
            title="Not available yet"
            message="Career OS does not match opportunities to your profile yet. When it does, every match will show the experience, skills and evidence it was based on."
          />
        </Card>

        <View style={styles.section}>
          <AppText variant="heading">In the meantime</AppText>

          <Card>
            <AppText variant="body" muted>
              You can search the market directly from the Market tab, and
              keep building your profile from the Career tab. Both feed the
              matching when it arrives.
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
});
