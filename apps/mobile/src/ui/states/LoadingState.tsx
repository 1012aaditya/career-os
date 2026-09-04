import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppText } from '../AppText';
import { colors, spacing } from '../theme';

type LoadingStateProps = {
  message?: string;
};

export function LoadingState({
  message = 'Loading...',
}: LoadingStateProps) {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="small" color={colors.primary} />
      <AppText variant="body" muted style={styles.message}>
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  message: {
    marginTop: spacing.sm,
  },
});
