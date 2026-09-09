import { useRef, useState } from 'react';
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
import { GithubConnectionCard } from '../../github/GithubConnectionCard';
import { supabase } from '../../lib/supabase';
import { deleteAccount } from '../../api/account';
import { canRetry, describeError } from '../../api/client';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  canStartDeletion,
  completeDeletion,
  deletionButtonLabel,
  failDeletion,
  isDeleting,
  INITIAL_ACCOUNT_DELETION_STATE,
  shouldClearSession,
  startDeletion,
  type AccountDeletionState,
} from '../../account/account-deletion';

export function ProfileScreen() {
  const { session } = useAuth();

  const email = session?.user.email ?? 'No email available';

  const [deletion, setDeletion] = useState<AccountDeletionState>(
    INITIAL_ACCOUNT_DELETION_STATE,
  );

  /*
   * A ref as well as the state, because state updates are asynchronous and
   * a fast double-tap can dispatch twice before the first render lands.
   * The ref is the one that actually prevents a second DELETE.
   */
  const deletingRef = useRef(false);

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut();

    if (error) {
      Alert.alert('Unable to sign out', error.message);
    }
  }

  /*
   * The deletion itself, run only after the user has confirmed.
   *
   * The ordering here is the whole correctness argument: the session is
   * cleared ONLY on a resolved success. The server deletes the auth
   * identity last and reports an error if that fails, so a failure can
   * mean the data is gone and the login is not - and signing out anyway
   * would show the user a sign-in screen while their account still exists.
   */
  async function runDeletion() {
    if (!canStartDeletion(deletion) || deletingRef.current) {
      return;
    }

    deletingRef.current = true;
    setDeletion(startDeletion());

    try {
      const result = await deleteAccount();
      const next = completeDeletion(result);

      setDeletion(next);

      if (shouldClearSession(next)) {
        if (next.githubWarning) {
          Alert.alert('Account deleted', next.githubWarning);
        }

        /*
         * Clearing the session is what returns the app to sign-in.
         * AuthProvider observes it through onAuthStateChange and
         * RootNavigator swaps declaratively - there is no navigate() call
         * here, which is what keeps this correct when several things
         * happen at once.
         */
        await supabase.auth.signOut();
      }
    } catch (error) {
      setDeletion(failDeletion(describeError(error), canRetry(error)));

      Alert.alert('Account not deleted', describeError(error));
    } finally {
      deletingRef.current = false;
    }
  }

  function handleDeleteAccount() {
    if (!canStartDeletion(deletion) || deletingRef.current) {
      return;
    }

    Alert.alert(
      ACCOUNT_DELETION_CONFIRMATION.title,
      ACCOUNT_DELETION_CONFIRMATION.message,
      [
        { text: ACCOUNT_DELETION_CONFIRMATION.cancelLabel, style: 'cancel' },
        {
          text: ACCOUNT_DELETION_CONFIRMATION.confirmLabel,
          style: 'destructive',
          onPress: () => {
            void runDeletion();
          },
        },
      ],
    );
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

        <GithubConnectionCard />

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
          <Button
            title="Sign out"
            onPress={handleSignOut}
            disabled={isDeleting(deletion)}
          />
        </View>

        <View style={styles.section}>
          <AppText variant="heading">Delete account</AppText>

          <Card>
            <AppText variant="body" muted>
              Permanently deletes your career profile, your imported resumes
              and the files behind them, and any connected accounts. This
              cannot be undone.
            </AppText>

            {deletion.status === 'failed' ? (
              <AppText variant="caption" style={styles.deleteError}>
                {deletion.message}
              </AppText>
            ) : null}

            <View style={styles.deleteButton}>
              <Button
                title={deletionButtonLabel(deletion)}
                onPress={handleDeleteAccount}
                disabled={!canStartDeletion(deletion)}
              />
            </View>
          </Card>
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
  deleteButton: {
    marginTop: spacing.md,
  },
  deleteError: {
    color: colors.danger,
    marginTop: spacing.sm,
  },
  footer: {
    textAlign: 'center',
  },
});
