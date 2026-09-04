import { Platform } from 'react-native';

export const colors = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  text: '#111827',
  textSecondary: '#6B7280',
  border: '#E5E7EB',
  primary: '#111827',
  primaryText: '#FFFFFF',
  muted: '#F3F4F6',
  danger: '#DC2626',
  success: '#16A34A',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

export const typography = {
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    lineHeight: 34,
  },
  heading: {
    fontSize: 22,
    fontWeight: '700' as const,
    lineHeight: 28,
  },
  body: {
    fontSize: 16,
    fontWeight: '400' as const,
    lineHeight: 24,
  },
  bodyMedium: {
    fontSize: 16,
    fontWeight: '500' as const,
    lineHeight: 24,
  },
  caption: {
    fontSize: 14,
    fontWeight: '400' as const,
    lineHeight: 20,
  },
};

export const shadows = Platform.select({
  ios: {
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  android: {
    elevation: 2,
  },
  default: {},
});
