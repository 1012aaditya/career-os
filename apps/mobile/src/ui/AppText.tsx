import type { ReactNode } from 'react';
import {
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { colors, typography } from './theme';

type Variant = keyof typeof typography;

type AppTextProps = {
  children: ReactNode;
  variant?: Variant;
  muted?: boolean;
  /*
   * StyleProp rather than a bare TextStyle, so a caller can compose - a
   * base style plus a conditional one - which is how every other React
   * Native component behaves. The value is already spread into an array
   * below, so this widens the type to what the implementation always
   * accepted and changes nothing for existing callers.
   */
  style?: StyleProp<TextStyle>;
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
