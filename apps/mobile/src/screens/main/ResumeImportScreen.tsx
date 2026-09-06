import { useEffect, useRef, useState } from 'react';

import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { getResumeImport } from '../../api/resume-import';
import { pickAndUploadResume } from '../../api/resume-upload';
import {
  AppText,
  Button,
  Card,
  Screen,
  spacing,
} from '../../ui';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

export function ResumeImportScreen() {
  const navigation = useNavigation<any>();

  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      const message =
        error instanceof Error
          ? error.message
          : 'Something went wrong while importing your resume.';

      Alert.alert('Unable to import resume', message);
    } finally {
      if (mountedRef.current) {
        setUploading(false);
        setProcessing(false);
      }
    }
  }

  const buttonTitle = uploading
    ? 'Uploading...'
    : processing
      ? 'Processing resume...'
      : 'Choose resume';

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
});
