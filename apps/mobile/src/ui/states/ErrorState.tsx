import { StyleSheet, View } from 'react-native';

import { AppText } from '../AppText';
import { Button } from '../Button';
import { colors, spacing } from '../theme';

type ErrorStateProps = {
  title?: string;
  message: string;
  onRetry?: () => void;
};

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: ErrorStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.icon}>
        <AppText variant="heading" style={styles.iconText}>
          !
        </AppText>
      </View>

      <AppText variant="heading" style={styles.title}>
        {title}
      </AppText>

      <AppText variant="body" muted style={styles.message}>
        {message}
      </AppText>

      {onRetry ? (
        <View style={styles.button}>
          <Button title="Try again" onPress={onRetry} />
        </View>
      ) : null}
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
    color: colors.danger,
  },
  title: {
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  message: {
    maxWidth: 320,
    textAlign: 'center',
  },
  button: {
    marginTop: spacing.lg,
    minWidth: 140,
  },
});
