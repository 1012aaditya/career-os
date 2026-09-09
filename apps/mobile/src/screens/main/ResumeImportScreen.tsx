import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import {
  deleteResumeImport,
  getResumeImport,
  getResumeImports,
  type ResumeImport,
} from '../../api/resume-import';
import { canRetry, describeError } from '../../api/client';
import { pickAndUploadResume } from '../../api/resume-upload';
import {
  canDelete,
  deleteConfirmation,
  listState,
  removeImport,
  sortImports,
  statusLabel,
} from '../../resume/resume-list';
import {
  AppText,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  colors,
  spacing,
} from '../../ui';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

export function ResumeImportScreen() {
  const navigation = useNavigation<any>();

  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);

  /*
   * The list of previous imports, which is also where a resume is deleted
   * from. It did not exist before PR-4: `getResumeImports` sat in the API
   * client with no caller, so a user could import a resume and then had no
   * way to see it again, let alone remove it.
   */
  const [imports, setImports] = useState<ResumeImport[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<{
    message: string;
    retryable: boolean;
  } | null>(null);

  /*
   * Which import is being deleted, if any. One value rather than a set:
   * two deletions at once is not a state this screen needs, and allowing
   * it would let a row vanish from under a confirmation dialog belonging
   * to a different row.
   */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadImports = useCallback(async () => {
    setListLoading(true);
    setListError(null);

    try {
      const result = await getResumeImports();

      if (!mountedRef.current) {
        return;
      }

      setImports(sortImports(result));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      /*
       * The existing list is left alone rather than cleared. A failed
       * refresh is not evidence that the user's imports are gone, and
       * wiping valid state because one request failed is exactly the
       * behaviour this phase set out to remove.
       */
      setListError({
        message: describeError(error),
        retryable: canRetry(error),
      });
    } finally {
      if (mountedRef.current) {
        setListLoading(false);
      }
    }
  }, []);

  /*
   * Reloaded on focus, so the list is correct after a review, after a
   * deletion, and on returning from the review screen - without the user
   * having to pull to refresh.
   */
  useFocusEffect(
    useCallback(() => {
      void loadImports();
    }, [loadImports]),
  );

  async function waitForProcessing(resumeImportId: string) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const resumeImport = await getResumeImport(resumeImportId);

      if (!mountedRef.current) {
        return;
      }

      if (resumeImport.status === 'NEEDS_REVIEW') {
        navigation.navigate('ResumeReview', {
          resumeImportId,
        });
        return;
      }

      if (resumeImport.status === 'FAILED') {
        throw new Error(
          resumeImport.errorMessage ||
            'Resume processing failed. Please try again.',
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, POLL_INTERVAL_MS),
      );
    }

    throw new Error(
      'Resume processing is taking longer than expected. Please try again later.',
    );
  }

  async function handleImportResume() {
    try {
      setUploading(true);

      const result = await pickAndUploadResume();

      if (!result) {
        return;
      }

      setUploading(false);
      setProcessing(true);

      await waitForProcessing(result.id);
    } catch (error) {
      Alert.alert('Unable to import resume', describeError(error));
    } finally {
      if (mountedRef.current) {
        setUploading(false);
        setProcessing(false);
        void loadImports();
      }
    }
  }

  /*
   * Deleting one import. Never retried automatically - a destructive call
   * that timed out may already have succeeded, so trying again is a
   * decision for the user rather than for the client.
   */
  async function runDelete(resumeImport: ResumeImport) {
    setDeletingId(resumeImport.id);

    try {
      const result = await deleteResumeImport(resumeImport.id);

      if (!mountedRef.current) {
        return;
      }

      /*
       * Removed locally rather than left until the next refresh, so a
       * deleted row cannot sit on screen looking like it still exists.
       */
      setImports((current) =>
        current === null ? current : removeImport(current, resumeImport.id),
      );

      /*
       * The server's own sentence about what it kept, not one written
       * here. If those semantics ever change, the copy the user reads
       * changes with them rather than quietly becoming wrong.
       */
      Alert.alert('Resume deleted', result.careerGraphNote);
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert('Resume not deleted', describeError(error));
      }
    } finally {
      if (mountedRef.current) {
        setDeletingId(null);
      }
    }
  }

  function handleDelete(resumeImport: ResumeImport) {
    if (!canDelete(deletingId)) {
      return;
    }

    const confirmation = deleteConfirmation(resumeImport.fileName);

    Alert.alert(confirmation.title, confirmation.message, [
      { text: confirmation.cancelLabel, style: 'cancel' },
      {
        text: confirmation.confirmLabel,
        style: 'destructive',
        onPress: () => {
          void runDelete(resumeImport);
        },
      },
    ]);
  }

  const buttonTitle = uploading
    ? 'Uploading...'
    : processing
      ? 'Processing resume...'
      : 'Choose resume';

  const state = listState({
    loading: listLoading,
    error: listError,
    imports,
  });

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="title">Import your resume</AppText>

          <AppText variant="body" muted style={styles.subtitle}>
            Start with your existing resume. Career OS will use it to build
            your career profile.
          </AppText>
        </View>

        <Card>
          <AppText variant="caption" muted>
            RESUME IMPORT
          </AppText>

          <AppText variant="heading" style={styles.title}>
            Upload a PDF resume
          </AppText>

          <AppText variant="body" muted>
            We'll extract your experience, skills, projects, and other career
            information for you to review.
          </AppText>
        </Card>

        <Button
          title={buttonTitle}
          onPress={handleImportResume}
          disabled={uploading || processing}
        />

        {processing && (
          <AppText variant="caption" muted style={styles.processing}>
            Reading your resume and preparing it for review...
          </AppText>
        )}

        <AppText variant="caption" muted style={styles.note}>
          PDF files are supported in this first version.
        </AppText>

        <View style={styles.section}>
          <AppText variant="heading">Your resumes</AppText>

          {/*
            Four distinct states. An error is never rendered as an empty
            state: "you have no resumes" and "we could not find out" are
            different sentences, and only one of them should invite a user
            to import their first one.
          */}
          {state.status === 'loading' ? (
            <Card>
              <LoadingState message="Loading your resumes..." />
            </Card>
          ) : null}

          {state.status === 'error' ? (
            <Card>
              <ErrorState
                title="Could not load your resumes"
                message={state.message}
                onRetry={state.retryable ? () => void loadImports() : undefined}
              />
            </Card>
          ) : null}

          {state.status === 'empty' ? (
            <Card>
              <EmptyState
                title="No resumes yet"
                message="Resumes you import will appear here, and you can delete them at any time."
              />
            </Card>
          ) : null}

          {state.status === 'loaded'
            ? state.imports.map((resumeImport) => {
                const busy = deletingId === resumeImport.id;

                return (
                  <Card key={resumeImport.id}>
                    <View style={styles.row}>
                      <View style={styles.rowContent}>
                        <AppText variant="bodyMedium" numberOfLines={1}>
                          {resumeImport.fileName}
                        </AppText>

                        <AppText variant="caption" muted>
                          {statusLabel(resumeImport.status)}
                        </AppText>
                      </View>

                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${resumeImport.fileName}`}
                        disabled={!canDelete(deletingId)}
                        onPress={() => handleDelete(resumeImport)}
                        style={({ pressed }) => [
                          styles.delete,
                          pressed && styles.deletePressed,
                          !canDelete(deletingId) && styles.deleteDisabled,
                        ]}
                      >
                        <AppText variant="caption" style={styles.deleteLabel}>
                          {busy ? 'Deleting...' : 'Delete'}
                        </AppText>
                      </Pressable>
                    </View>
                  </Card>
                );
              })
            : null}
        </View>
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

  title: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },

  processing: {
    textAlign: 'center',
  },

  note: {
    textAlign: 'center',
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

  delete: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },

  deletePressed: {
    opacity: 0.6,
  },

  deleteDisabled: {
    opacity: 0.4,
  },

  deleteLabel: {
    color: colors.danger,
  },
});
