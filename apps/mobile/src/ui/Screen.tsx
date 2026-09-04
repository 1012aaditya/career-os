import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from './theme';

type ScreenProps = {
  children: ReactNode;
};

export function Screen({ children }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.container}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    padding: spacing.md,
  },
});
