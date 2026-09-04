import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  AppText,
  Button,
  Screen,
  colors,
  radius,
  spacing,
} from '../../ui';
import { supabase } from '../../lib/supabase';

export function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }

    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setError(error.message);
    }

    setLoading(false);
  }

  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.logo}>
            <AppText variant="heading" style={styles.logoText}>
              C
            </AppText>
          </View>

          <AppText variant="title" style={styles.title}>
            Career OS
          </AppText>

          <AppText variant="body" muted style={styles.subtitle}>
            Turn your career into career capital.
          </AppText>
        </View>

        <View style={styles.form}>
          <View style={styles.field}>
            <AppText variant="bodyMedium">Email</AppText>

            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.textSecondary}
              style={styles.input}
              value={email}
            />
          </View>

          <View style={styles.field}>
            <AppText variant="bodyMedium">Password</AppText>

            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
              onChangeText={setPassword}
              placeholder="Your password"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
              style={styles.input}
              value={password}
            />
          </View>

          {error ? (
            <AppText variant="caption" style={styles.error}>
              {error}
            </AppText>
          ) : null}

          <Button
            disabled={loading}
            title={loading ? 'Signing in...' : 'Sign in'}
            onPress={handleSignIn}
          />

          {loading ? (
            <ActivityIndicator
              color={colors.primary}
              style={styles.activity}
            />
          ) : null}

          <AppText
            variant="caption"
            muted
            style={styles.forgotPassword}
          >
            Forgot your password?
          </AppText>
        </View>

        <AppText variant="caption" muted style={styles.footer}>
          Don't have an account? Create one
        </AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  logoText: {
    color: colors.primaryText,
  },
  title: {
    textTransform: 'capitalize',
    marginBottom: spacing.xs,
  },
  subtitle: {
    textAlign: 'center',
  },
  form: {
    gap: spacing.md,
  },
  field: {
    gap: spacing.sm,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 16,
  },
  error: {
    color: colors.danger,
  },
  activity: {
    marginTop: -spacing.sm,
  },
  forgotPassword: {
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  footer: {
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});
