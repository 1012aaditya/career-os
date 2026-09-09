import type { ReactNode } from 'react';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import { colors, typography } from './theme';

type Variant = keyof typeof typography;

type AppTextProps = {
  children: ReactNode;
  variant?: Variant;
  muted?: boolean;
  style?: TextStyle;
  /**
   * Truncates instead of wrapping.
   *
   * Added for the resume list, where the filename is arbitrary length and
   * chosen by the user: a long one wrapping to three lines pushes the
   * Delete control around and gives every row a different height. Passed
   * straight through to Text, and undefined by default, so every existing
   * caller behaves exactly as it did.
   */
  numberOfLines?: number;
};

export function AppText({
  children,
  variant = 'body',
  muted = false,
  style,
  numberOfLines,
}: AppTextProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
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
