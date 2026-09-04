import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radius, shadows, spacing } from './theme';

type CardProps = {
  children: ReactNode;
};

export function Card({ children }: CardProps) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadows,
  },
});
