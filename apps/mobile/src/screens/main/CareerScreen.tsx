import { ScrollView, StyleSheet, View } from 'react-native';

import {
  AppText,
  Card,
  Screen,
  colors,
  radius,
  spacing,
} from '../../ui';

export function CareerScreen() {
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="title">Career</AppText>
          <AppText variant="body" muted style={styles.subtitle}>
            Your career, represented as a living graph.
          </AppText>
        </View>

        <Card>
          <AppText variant="caption" muted>
            CAREER GRAPH
          </AppText>

          <View style={styles.graphPlaceholder}>
            <View style={styles.graphNode}>
              <AppText variant="bodyMedium" style={styles.nodeText}>
                Your career
              </AppText>
              <AppText variant="caption" style={styles.nodeSubtext}>
                graph
              </AppText>
            </View>

            <AppText variant="body" muted style={styles.graphText}>
              Your career graph will appear here as Career OS learns about
              your experience, skills, projects, and goals.
            </AppText>
          </View>
        </Card>

        <View style={styles.section}>
          <AppText variant="heading">Current role</AppText>

          <Card>
            <AppText variant="bodyMedium">No current role yet</AppText>
            <AppText variant="body" muted style={styles.cardText}>
              Your current position will appear here once your career profile
              is available.
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Skills</AppText>

          <Card>
            <AppText variant="bodyMedium">No skills added yet</AppText>
            <AppText variant="body" muted style={styles.cardText}>
              Skills extracted from your career information will appear here.
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Experience</AppText>

          <Card>
            <AppText variant="bodyMedium">No experience added yet</AppText>
            <AppText variant="body" muted style={styles.cardText}>
              Your professional experience will appear here.
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Career direction</AppText>

          <Card>
            <AppText variant="bodyMedium">
              Define your next career direction
            </AppText>
            <AppText variant="body" muted style={styles.cardText}>
              Career OS will use your goals and career evidence to understand
              where you could go next.
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
  graphPlaceholder: {
    marginTop: spacing.md,
    minHeight: 220,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  graphNode: {
    width: 120,
    minHeight: 72,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeText: {
    color: colors.primaryText,
  },
  nodeSubtext: {
    color: colors.primaryText,
    opacity: 0.7,
  },
  graphText: {
    textAlign: 'center',
  },
  cardText: {
    marginTop: spacing.sm,
  },
});
