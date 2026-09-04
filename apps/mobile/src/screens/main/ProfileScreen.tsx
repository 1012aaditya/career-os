import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import {
  AppText,
  Button,
  Card,
  Screen,
  colors,
  radius,
  spacing,
} from '../../ui';
import { useAuth } from '../../auth/AuthProvider';
import { supabase } from '../../lib/supabase';

export function ProfileScreen() {
  const { session } = useAuth();

  const email = session?.user.email ?? 'No email available';

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut();

    if (error) {
      Alert.alert('Unable to sign out', error.message);
    }
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="title">Profile</AppText>
          <AppText variant="body" muted style={styles.subtitle}>
            Manage your Career OS account.
          </AppText>
        </View>

        <Card>
          <View style={styles.profileHeader}>
            <View style={styles.avatar}>
              <AppText variant="heading" style={styles.avatarText}>
                {email.charAt(0).toUpperCase()}
              </AppText>
            </View>

            <View style={styles.identity}>
              <AppText variant="heading">Your account</AppText>
              <AppText variant="body" muted>
                {email}
              </AppText>
            </View>
          </View>
        </Card>

        <View style={styles.section}>
          <AppText variant="heading">Account</AppText>

          <Card>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <AppText variant="bodyMedium">
                  Account information
                </AppText>
                <AppText variant="caption" muted>
                  Manage your account details.
                </AppText>
              </View>

              <AppText variant="body" muted>
                ›
              </AppText>
            </View>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Preferences</AppText>

          <Card>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <AppText variant="bodyMedium">
                  Notifications
                </AppText>
                <AppText variant="caption" muted>
                  Notification preferences will appear here.
                </AppText>
              </View>

              <AppText variant="body" muted>
                ›
              </AppText>
            </View>
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">About</AppText>

          <Card>
            <View style={styles.aboutRow}>
              <AppText variant="bodyMedium">Career OS</AppText>
              <AppText variant="caption" muted>
                Version 1.0
              </AppText>
            </View>
          </Card>
        </View>

        <View style={styles.signOut}>
          <Button title="Sign out" onPress={handleSignOut} />
        </View>

        <AppText variant="caption" muted style={styles.footer}>
          Your career data belongs to you.
        </AppText>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },
  subtitle: {
    marginTop: spacing.xs,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.primaryText,
  },
  identity: {
    flex: 1,
    gap: spacing.xs,
  },
  section: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowContent: {
    flex: 1,
    gap: spacing.xs,
  },
  aboutRow: {
    gap: spacing.xs,
  },
  signOut: {
    marginTop: spacing.sm,
  },
  footer: {
    textAlign: 'center',
  },
});
