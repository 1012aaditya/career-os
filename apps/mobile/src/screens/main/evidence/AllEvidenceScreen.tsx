import { useNavigation } from '@react-navigation/native';
import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { EvidenceCard } from '../../../evidence/EvidenceCard';
import {
  AGE_LABELS,
  NO_FILTERS,
  activeFilterCount,
  applyFilters,
  evidenceViewState,
  sourceOptions,
  type AgeBucket,
  type EvidenceFilters,
} from '../../../evidence/evidence-filters';
import {
  STRENGTH_ORDER,
  strengthLabel,
} from '../../../evidence/evidence-view';
import { useEvidence } from '../../../evidence/useEvidence';
import type { TrustClass } from '../../../evidence/evidence-api';
import {
  AppText,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  colors,
  radius,
  spacing,
  typography,
} from '../../../ui';

/*
 * Every piece of evidence, filterable.
 *
 * Ordering is the server's and is never recomputed here. Filters remove
 * items; nothing re-sorts them, so the same evidence appears in the same
 * order whichever filter is active.
 */
export function AllEvidenceScreen() {
  const navigation = useNavigation<{
    navigate: (screen: string, params?: object) => void;
  }>();
  const { data, loading, loaded, error, reload } = useEvidence();

  const [filters, setFilters] = useState<EvidenceFilters>(NO_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);

  const visible = useMemo(
    () => applyFilters(data.evidence, filters),
    [data.evidence, filters],
  );

  const state = evidenceViewState({
    loading: loading && !loaded,
    error,
    total: data.evidence.length,
    visible: visible.length,
    filters,
  });

  const filterCount = activeFilterCount(filters);

  return (
    <Screen>
      <View style={styles.header}>
        <AppText variant="title">All evidence</AppText>

        <View style={styles.controls}>
          <TextInput
            value={filters.search}
            onChangeText={(search) => setFilters({ ...filters, search })}
            placeholder="Search evidence..."
            placeholderTextColor={colors.textSecondary}
            style={styles.search}
            autoCorrect={false}
            accessibilityLabel="Search evidence"
          />

          <Pressable
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.filterButton,
              pressed && styles.pressed,
            ]}
          >
            <AppText style={styles.filterButtonText}>
              {filterCount === 0 ? 'Filter' : `Filter · ${filterCount}`}
            </AppText>
          </Pressable>
        </View>
      </View>

      {state === 'loading' ? (
        <LoadingState message="Loading your evidence..." />
      ) : null}

      {state === 'error' ? (
        <ErrorState message={error ?? ''} onRetry={() => void reload()} />
      ) : null}

      {state === 'empty' ? (
        <EmptyState
          title="No evidence yet"
          message="Connect a source or add your work to start building proof."
        />
      ) : null}

      {state === 'no-matches' ? (
        <EmptyState
          title="Nothing matches"
          message="No evidence matches these filters. Your evidence is still there."
        />
      ) : null}

      {state === 'ready' ? (
        <ScrollView contentContainerStyle={styles.list}>
          <AppText style={styles.count}>
            {visible.length === data.evidence.length
              ? `${visible.length} of ${data.evidence.length}`
              : `${visible.length} of ${data.evidence.length} shown`}
          </AppText>

          {visible.map((item) => (
            <EvidenceCard
              key={item.id}
              item={item}
              onPress={() =>
                navigation.navigate('EvidenceDetail', {
                  evidenceId: item.id,
                })
              }
            />
          ))}

          {/*
            Truncation is the server's, not the filter's. Said plainly so
            a user counting their repositories against this list is not
            left wondering which of the two is wrong.
          */}
          {data.truncated ? (
            <AppText style={styles.truncated}>
              More evidence exists than this list can show.
            </AppText>
          ) : null}
        </ScrollView>
      ) : null}

      <FilterSheet
        open={sheetOpen}
        filters={filters}
        sources={sourceOptions(data.evidence)}
        onChange={setFilters}
        onClose={() => setSheetOpen(false)}
      />
    </Screen>
  );
}

function FilterSheet({
  open,
  filters,
  sources,
  onChange,
  onClose,
}: {
  open: boolean;
  filters: EvidenceFilters;
  sources: { value: string; label: string }[];
  onChange: (next: EvidenceFilters) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={open}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <AppText style={styles.sheetTitle}>Filter evidence</AppText>
          <Pressable onPress={onClose} accessibilityRole="button">
            <AppText style={styles.sheetDone}>Done</AppText>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.sheetBody}>
          <ChipGroup
            title="Source"
            options={[
              { value: null, label: 'All' },
              ...sources.map((s) => ({ value: s.value, label: s.label })),
            ]}
            selected={filters.sourceType}
            onSelect={(sourceType) =>
              onChange({ ...filters, sourceType: sourceType as string | null })
            }
          />

          <ChipGroup
            title="Strength"
            options={[
              { value: null, label: 'All' },
              ...STRENGTH_ORDER.map((value) => ({
                value,
                label: strengthLabel(value).label,
              })),
            ]}
            selected={filters.strength}
            onSelect={(strength) =>
              onChange({ ...filters, strength: strength as TrustClass | null })
            }
          />

          <ChipGroup
            title="Last confirmed"
            options={[
              { value: null, label: 'All' },
              { value: 'RECENT', label: AGE_LABELS.RECENT },
              { value: 'AGING', label: AGE_LABELS.AGING },
              { value: 'HISTORICAL', label: AGE_LABELS.HISTORICAL },
            ]}
            selected={filters.age}
            onSelect={(age) =>
              onChange({ ...filters, age: age as AgeBucket | null })
            }
          />

          <Pressable
            onPress={() => onChange({ ...NO_FILTERS, search: filters.search })}
            accessibilityRole="button"
            style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
          >
            <AppText style={styles.clearText}>Clear filters</AppText>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function ChipGroup({
  title,
  options,
  selected,
  onSelect,
}: {
  title: string;
  options: { value: string | null; label: string }[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  return (
    <View style={styles.chipGroup}>
      <AppText style={styles.chipGroupTitle}>{title}</AppText>
      <View style={styles.chips}>
        {options.map((option) => {
          const active = option.value === selected;

          return (
            <Pressable
              key={option.label}
              onPress={() => onSelect(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.chip, active && styles.chipActive]}
            >
              <AppText
                style={[styles.chipText, active && styles.chipTextActive]}
              >
                {option.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: spacing.md,
    gap: spacing.md,
  },
  controls: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  search: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...typography.caption,
    color: colors.text,
  },
  filterButton: {
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterButtonText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  pressed: {
    backgroundColor: colors.muted,
  },
  list: {
    padding: spacing.md,
    paddingTop: 0,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  count: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  truncated: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingTop: spacing.sm,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.25)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '75%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetTitle: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  sheetDone: {
    ...typography.bodyMedium,
    color: colors.text,
    fontWeight: '600',
  },
  sheetBody: {
    padding: spacing.md,
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },
  chipGroup: {
    gap: spacing.sm,
  },
  chipGroupTitle: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.muted,
  },
  chipActive: {
    backgroundColor: colors.primary,
  },
  chipText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.primaryText,
    fontWeight: '600',
  },
  clear: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
  },
  clearText: {
    ...typography.caption,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },
});
