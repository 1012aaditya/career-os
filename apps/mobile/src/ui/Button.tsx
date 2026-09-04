import { Pressable, StyleSheet } from 'react-native';
import { AppText } from './AppText';
import { colors, radius, spacing } from './theme';

type ButtonProps = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
};

export function Button({ title, onPress, disabled = false }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <AppText variant="bodyMedium" style={styles.label}>
        {title}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    color: colors.primaryText,
  },
});
