import { ScrollView, StyleSheet, View } from 'react-native';
import {
  AppText,
  Card,
  Screen,
  colors,
  spacing,
} from '../../ui';

export function HomeScreen() {
  return (
    <Screen>
       <ScrollView
       contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
        <View>
          <AppText variant="title">Good morning</AppText>
          <AppText variant="body" muted>
            Your career command center.
          </AppText>
        </View>

        <Card>
          <AppText variant="caption" muted>
            CAREER SNAPSHOT
          </AppText>

          <AppText variant="heading" style={styles.cardTitle}>
            Build your career profile
          </AppText>

          <AppText variant="body" muted>
            Your career insights will appear here as Career OS learns about
            your experience, skills, and goals.
          </AppText>
        </Card>

        <View style={styles.section}>
          <AppText variant="heading">Your next move</AppText>

          <Card>
            <AppText variant="bodyMedium">
              Recommendations are coming soon.
            </AppText>

            <AppText variant="body" muted style={styles.cardText}>
              Career OS will surface the most valuable action for your career
              here.
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Career overview</AppText>

          <View style={styles.grid}>
            <Card>
              <AppText variant="caption" muted>
                SKILLS
              </AppText>
              <AppText variant="heading" style={styles.metric}>
                —
              </AppText>
              <AppText variant="caption" muted>
                No data yet
              </AppText>
            </Card>

            <Card>
              <AppText variant="caption" muted>
                EXPERIENCE
              </AppText>
              <AppText variant="heading" style={styles.metric}>
                —
              </AppText>
              <AppText variant="caption" muted>
                No data yet
              </AppText>
            </Card>
          </View>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Recent activity</AppText>

          <Card>
            <AppText variant="body" muted>
              Your recent career activity will appear here.
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
  },
  cardTitle: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  cardText: {
    marginTop: spacing.sm,
  },
  section: {
    gap: spacing.sm,
  },
  grid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  metric: {
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
});
