import type { ReactNode } from 'react';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import { colors, typography } from './theme';

type Variant = keyof typeof typography;

type AppTextProps = {
  children: ReactNode;
  variant?: Variant;
  muted?: boolean;
  style?: TextStyle;
};

export function AppText({
  children,
  variant = 'body',
  muted = false,
  style,
}: AppTextProps) {
  return (
    <Text
      style={[
        styles.base,
        typography[variant],
        muted && styles.muted,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    color: colors.text,
  },
  muted: {
    color: colors.textSecondary,
  },
});
