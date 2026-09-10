import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  EMPTY_DRAFT,
  MANUAL_EVIDENCE_DISCLOSURE,
  MANUAL_EVIDENCE_KINDS,
  draftProblems,
  isSubmittable,
  submissionState,
  type ManualEvidenceDraft,
} from '../../../evidence/manual-evidence';
import {
  AppText,
  Screen,
  colors,
  radius,
  spacing,
  typography,
} from '../../../ui';

/*
 * Adding your own evidence.
 *
 * This screen exists because Career OS is not for engineers with busy
 * GitHub accounts. A fresher has a college project and a hackathon; a
 * designer has a case study; a founder has a deck. None of that lives
 * behind an API, and an evidence layer that only understands APIs tells
 * most people they have no career.
 *
 * IT DOES NOT SAVE. There is no endpoint, and inventing one would produce
 * a form that appears to store work and does not - the worst possible
 * outcome on a screen about trust. So the notice is shown FIRST, before
 * any field, rather than as a surprise at the end.
 */
export function AddEvidenceScreen() {
  const navigation = useNavigation();
  const [draft, setDraft] = useState<ManualEvidenceDraft>(EMPTY_DRAFT);

  const submission = submissionState();
  const problems = draftProblems(draft);
  const ready = isSubmittable(draft);

  const problemFor = (field: keyof ManualEvidenceDraft) =>
    problems.find((problem) => problem.field === field)?.message;

  const set = (field: keyof ManualEvidenceDraft, value: string) =>
    setDraft({ ...draft, [field]: value });

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <AppText variant="title">Add evidence</AppText>
          <AppText style={styles.subtitle}>
            For work that does not live behind an API.
          </AppText>
        </View>

        {/*
          Before any field, not after. A person should know this cannot be
          saved before they spend ten minutes writing a case study into it.
        */}
        <View style={styles.notice}>
          <AppText style={styles.noticeTitle}>Not available yet</AppText>
          <AppText style={styles.noticeText}>{submission.notice}</AppText>
        </View>

        <Field label="What kind of evidence is this?" error={problemFor('kind')}>
          <View style={styles.kinds}>
            {MANUAL_EVIDENCE_KINDS.map((kind) => {
              const active = draft.kind === kind.value;

              return (
                <Pressable
                  key={kind.value}
                  onPress={() => setDraft({ ...draft, kind: kind.value })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.kind, active && styles.kindActive]}
                >
                  <AppText
                    style={[styles.kindText, active && styles.kindTextActive]}
                  >
                    {kind.label}
                  </AppText>
                </Pressable>
              );
            })}
          </View>

          {draft.kind !== null ? (
            <AppText style={styles.hint}>
              {
                MANUAL_EVIDENCE_KINDS.find((k) => k.value === draft.kind)
                  ?.hint
              }
            </AppText>
          ) : null}
        </Field>

        <Field label="Title" error={problemFor('title')}>
          <TextInput
            value={draft.title}
            onChangeText={(value) => set('title', value)}
            placeholder="What was it?"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            accessibilityLabel="Title"
          />
        </Field>

        <Field label="Description">
          <TextInput
            value={draft.description}
            onChangeText={(value) => set('description', value)}
            placeholder="What did it involve?"
            placeholderTextColor={colors.textSecondary}
            style={[styles.input, styles.multiline]}
            multiline
            accessibilityLabel="Description"
          />
        </Field>

        <Field
          label="Date"
          error={problemFor('date')}
          hint="YYYY-MM or YYYY-MM-DD. Leave blank if you are not sure — a guessed date is worse than none."
        >
          <TextInput
            value={draft.date}
            onChangeText={(value) => set('date', value)}
            placeholder="2025-06"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            autoCapitalize="none"
            accessibilityLabel="Date"
          />
        </Field>

        <Field label="Your role">
          <TextInput
            value={draft.role}
            onChangeText={(value) => set('role', value)}
            placeholder="What did you do on it?"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            accessibilityLabel="Your role"
          />
        </Field>

        <Field label="Outcome">
          <TextInput
            value={draft.outcome}
            onChangeText={(value) => set('outcome', value)}
            placeholder="What happened as a result?"
            placeholderTextColor={colors.textSecondary}
            style={[styles.input, styles.multiline]}
            multiline
            accessibilityLabel="Outcome"
          />
        </Field>

        <Field
          label="Link"
          error={problemFor('url')}
          hint="A link makes evidence checkable by someone else."
        >
          <TextInput
            value={draft.url}
            onChangeText={(value) => set('url', value)}
            placeholder="https://"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Link"
          />
        </Field>

        {/*
          The trade-off, shown while the user decides whether to bother:
          evidence you add is real, and it is not the same as evidence a
          source confirmed.
        */}
        <View style={styles.disclosure}>
          <AppText style={styles.disclosureTitle}>
            {MANUAL_EVIDENCE_DISCLOSURE.provenance}
          </AppText>
          <AppText style={styles.disclosureText}>
            {MANUAL_EVIDENCE_DISCLOSURE.detail}
          </AppText>
        </View>

        <Pressable
          disabled
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          accessibilityHint="Saving is not available yet"
          style={[styles.submit, styles.submitDisabled]}
        >
          <AppText style={styles.submitText}>
            {ready ? 'Ready to save — not available yet' : 'Save'}
          </AppText>
        </Pressable>

        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
        >
          <AppText style={styles.back}>Back</AppText>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <AppText style={styles.label}>{label}</AppText>
      {children}
      {hint !== undefined ? (
        <AppText style={styles.hint}>{hint}</AppText>
      ) : null}
      {error !== undefined ? (
        <AppText style={styles.error}>{error}</AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.md,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  header: { gap: spacing.xs },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  notice: {
    backgroundColor: '#FFFBEB',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  noticeTitle: {
    ...typography.caption,
    fontWeight: '700',
    color: '#B45309',
  },
  noticeText: {
    fontSize: 13,
    lineHeight: 19,
    color: '#92400E',
  },
  field: { gap: spacing.sm },
  label: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...typography.caption,
    color: colors.text,
  },
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  kinds: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  kind: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.muted,
  },
  kindActive: { backgroundColor: colors.primary },
  kindText: { fontSize: 13, color: colors.textSecondary },
  kindTextActive: { color: colors.primaryText, fontWeight: '600' },
  hint: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  error: {
    fontSize: 12,
    color: colors.danger,
  },
  disclosure: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
  },
  disclosureTitle: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  disclosureText: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  submit: {
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.primary,
  },
  submitDisabled: { opacity: 0.4 },
  submitText: {
    ...typography.bodyMedium,
    color: colors.primaryText,
  },
  back: {
    ...typography.caption,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },
});
