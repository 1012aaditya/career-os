import { StyleSheet, View } from 'react-native';

import { AppText } from '../AppText';
import { colors, spacing } from '../theme';

type EmptyStateProps = {
  title: string;
  message: string;
};

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.icon}>
        <AppText variant="heading" style={styles.iconText}>
          —
        </AppText>
      </View>

      <AppText variant="heading" style={styles.title}>
        {title}
      </AppText>

      <AppText variant="body" muted style={styles.message}>
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: spacing.xl,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.muted,
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    marginBottom: spacing.md,
    width: 48,
  },
  iconText: {
    color: colors.textSecondary,
  },
  title: {
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  message: {
    maxWidth: 320,
    textAlign: 'center',
  },
});
