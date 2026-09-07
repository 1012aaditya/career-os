import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Line,
  RadialGradient,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import {
  AppText,
  Card,
  Screen,
  colors,
  radius,
  spacing,
} from '../../ui';

import {
  getCareerGraph,
  type CareerGraph,
} from '../../api/career-graph';

import {
  getObjectField,
  getStringField,
  getTimeField,
  toArray,
} from '../../career/graph-fields';

import {
  buildCareerTimeline,
  getTimelineTypeLabel,
  type CareerTimeline,
  type TimelineItem,
} from '../../career/timeline';

import {
  buildGraphModel,
  describeTruncation,
  getEdgeEmphasis,
  getEvidenceTitle,
  getExperienceTitle,
  getNodeEmphasis,
  getNodeTypeLabelForLink,
  getProjectName,
  getSkillName,
  isEdgeRendered,
  selectionFromNode,
  CENTER_X,
  CENTER_Y,
  GRAPH_HEIGHT,
  GRAPH_LENSES,
  GRAPH_WIDTH,
  NODE_GLOW_PADDING,
  NODE_LABEL_MAX_CHARS,
  NODE_RADIUS,
  PERSON_LABEL_MAX_CHARS,
  type DetailEntityType,
  type DetailSelection,
  type GraphLens,
  type GraphNodeType,
} from '../../career/graph-model';

import {
  buildDataQualityReport,
  getCareerState,
  type DataQualityReport,
} from '../../career/data-quality';

import {
  getEntityRelations,
  type RelationGroup,
} from '../../career/relations';

import {
  buildCareerStory,
  type CareerStory,
} from '../../career/story';

import {
  buildEvidenceIndex,
  formatEvidenceDate,
  getEvidenceForEntities,
  getSupportSummary,
  type EvidenceEntityType,
  type EvidenceIndex,
  type EvidenceView,
} from '../../career/evidence';

// Font size of the label drawn inside each node. The character budget it
// has to fit in lives with the layout maths in graph-model.
const NODE_LABEL_FONT_SIZE = 10;

export function CareerScreen() {
  const [graph, setGraph] = useState<CareerGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] =
    useState<DetailSelection | null>(null);
  const [canvasWidth, setCanvasWidth] =
    useState(GRAPH_WIDTH);
  const [lens, setLens] =
    useState<GraphLens>('all');

  const loadCareerGraph = useCallback(async () => {
    try {
      setError(null);

      const data = await getCareerGraph();

      setGraph(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to load your career graph.',
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadCareerGraph();
    }, [loadCareerGraph]),
  );

  const graphModel = useMemo(
    () => buildGraphModel(graph),
    [graph],
  );

  const snapshot = useMemo(() => {
    if (!graph) {
      return null;
    }

    return buildCareerSnapshot(graph);
  }, [graph]);

  const timeline = useMemo(
    () => buildCareerTimeline(graph),
    [graph],
  );

  const evidenceIndex = useMemo(
    () => buildEvidenceIndex(graph),
    [graph],
  );

  /*
   * The map draws only a slice of a large career. The note states what was
   * left out; it is independent of the lens, because a lens changes focus
   * and never changes what exists.
   */
  const story = useMemo(
    () => buildCareerStory(graph),
    [graph],
  );

  const dataQuality = useMemo(
    () => buildDataQualityReport(graph),
    [graph],
  );

  const truncationNote = useMemo(
    () =>
      describeTruncation(graphModel.counts),
    [graphModel],
  );

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator size="large" />

          <AppText
            variant="body"
            muted
            style={styles.loadingText}
          >
            Mapping your career...
          </AppText>
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View style={styles.center}>
          <AppText variant="heading">
            Couldn’t load your career map
          </AppText>

          <AppText
            variant="body"
            muted
            style={styles.errorText}
          >
            {error}
          </AppText>

          <Pressable
            style={styles.retryButton}
            onPress={loadCareerGraph}
          >
            <AppText
              variant="bodyMedium"
              style={styles.retryButtonText}
            >
              Try again
            </AppText>
          </Pressable>
        </View>
      </Screen>
    );
  }

  if (!graph) {
    return null;
  }

  const experiences = graph.experiences ?? [];
  const projects = graph.projects ?? [];
  const achievements = graph.achievements ?? [];
  const capabilities =
    snapshot?.capabilities ?? [];

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadCareerGraph();
            }}
          />
        }
      >
        <View style={styles.header}>
          <View>
            <AppText variant="title">
              Career Map
            </AppText>

            <AppText
              variant="body"
              muted
              style={styles.subtitle}
            >
              See how your experience connects.
            </AppText>
          </View>

          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />

            <AppText
              variant="caption"
              style={styles.liveText}
            >
              LIVE
            </AppText>
          </View>
        </View>

        {snapshot ? (
          <CareerSnapshotSection
            snapshot={snapshot}
          />
        ) : null}

        <Card>
          <View style={styles.graphHeader}>
            <View style={styles.graphHeaderText}>
              <AppText variant="heading">
                Your career graph
              </AppText>

              <AppText
                variant="body"
                muted
                style={styles.graphSubtitle}
              >
                Tap any node to explore the connection.
              </AppText>
            </View>

            <View style={styles.graphCount}>
              <AppText
                variant="bodyMedium"
                style={styles.graphCountNumber}
              >
                {graphModel.counts.totalRecords}
              </AppText>

              <AppText
                variant="caption"
                muted
              >
                signals
              </AppText>
            </View>
          </View>

          <View style={styles.lensRow}>
            {GRAPH_LENSES.map((option) => {
              const isActive =
                option.id === lens;

              return (
                <Pressable
                  key={option.id}
                  style={[
                    styles.lensChip,
                    isActive
                      ? styles.lensChipActive
                      : styles.lensChipIdle,
                  ]}
                  onPress={() =>
                    setLens(option.id)
                  }
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: isActive,
                  }}
                >
                  <AppText
                    variant="caption"
                    style={
                      isActive
                        ? styles.lensChipTextActive
                        : styles.lensChipText
                    }
                  >
                    {option.label}
                  </AppText>
                </Pressable>
              );
            })}
          </View>

          {truncationNote ? (
            <AppText
              variant="caption"
              muted
              style={styles.truncationNote}
            >
              {truncationNote}
            </AppText>
          ) : null}

          <View
            style={styles.graphCanvas}
            onLayout={(event) => {
              const { width } =
                event.nativeEvent.layout;

              if (width > 0) {
                setCanvasWidth(width);
              }
            }}
          >
            <Svg
              width={canvasWidth}
              height={
                (canvasWidth * GRAPH_HEIGHT) /
                GRAPH_WIDTH
              }
              viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            >
              <Defs>
                <RadialGradient
                  id="graphBackground"
                  cx="50%"
                  cy="50%"
                  rx="65%"
                  ry="65%"
                >
                  <Stop
                    offset="0%"
                    stopColor={colors.background}
                    stopOpacity="1"
                  />

                  <Stop
                    offset="100%"
                    stopColor={colors.muted}
                    stopOpacity="1"
                  />
                </RadialGradient>

                <LinearGradient
                  id="personGradient"
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="100%"
                >
                  <Stop
                    offset="0%"
                    stopColor={colors.primary}
                  />

                  <Stop
                    offset="100%"
                    stopColor="#3B82F6"
                  />
                </LinearGradient>
              </Defs>

              <Circle
                cx={CENTER_X}
                cy={CENTER_Y}
                r={215}
                fill="url(#graphBackground)"
              />

              {graphModel.edges
                .filter(isEdgeRendered)
                .map((edge) => {
                  const from =
                    graphModel.nodes.find(
                      (node) =>
                        node.id === edge.from,
                    );

                  const to =
                    graphModel.nodes.find(
                      (node) =>
                        node.id === edge.to,
                    );

                  if (!from || !to) {
                    return null;
                  }

                  const emphasis =
                    getEdgeEmphasis(edge, lens);

                  return (
                    <Line
                      key={edge.id}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={colors.border}
                      strokeWidth={1.2}
                      strokeOpacity={
                        emphasis === 'full'
                          ? 0.55
                          : 0.12
                      }
                    />
                  );
                })}

              {graphModel.nodes.map((node) => {
                const nodeStyle =
                  getNodeStyle(node.type);

                const isPerson =
                  node.type === 'person';

                /*
                 * Out-of-lens nodes are dimmed, never removed: the layout
                 * stays put and every node stays tappable, so a lens can
                 * never imply a record is gone.
                 */
                const emphasis = getNodeEmphasis(
                  node,
                  lens,
                );

                return (
                  <G
                    key={node.id}
                    opacity={
                      emphasis === 'full'
                        ? 1
                        : 0.22
                    }
                    onPress={() => {
                      if (!isPerson) {
                        setSelectedEntity(
                          selectionFromNode(
                            node,
                          ),
                        );
                      }
                    }}
                  >
                    <Circle
                      cx={node.x}
                      cy={node.y}
                      r={
                        nodeStyle.radius +
                        NODE_GLOW_PADDING
                      }
                      fill={nodeStyle.glow}
                      opacity={0.18}
                    />

                    <Circle
                      cx={node.x}
                      cy={node.y}
                      r={nodeStyle.radius}
                      fill={
                        isPerson
                          ? 'url(#personGradient)'
                          : nodeStyle.fill
                      }
                      stroke={nodeStyle.stroke}
                      strokeWidth={isPerson ? 2 : 1.5}
                    />

                    <SvgText
                      x={node.x}
                      y={node.y - 2}
                      fill={
                        isPerson
                          ? colors.primaryText
                          : nodeStyle.text
                      }
                      fontSize={
                        isPerson
                          ? 13
                          : NODE_LABEL_FONT_SIZE
                      }
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {truncate(
                        node.label,
                        isPerson
                          ? PERSON_LABEL_MAX_CHARS
                          : NODE_LABEL_MAX_CHARS,
                      )}
                    </SvgText>

                    {!isPerson && (
                      <SvgText
                        x={node.x}
                        y={node.y + 12}
                        fill={nodeStyle.text}
                        fontSize={7}
                        opacity={0.65}
                        textAnchor="middle"
                      >
                        {getTypeLabel(node.type)}
                      </SvgText>
                    )}
                  </G>
                );
              })}
            </Svg>
          </View>

          <View style={styles.legend}>
            <LegendItem
              label="Skills"
              type="skill"
            />

            <LegendItem
              label="Work"
              type="experience"
            />

            <LegendItem
              label="Projects"
              type="project"
            />

            <LegendItem
              label="Proof"
              type="evidence"
            />
          </View>
        </Card>

        <CareerTimelineSection
          timeline={timeline}
          onSelect={setSelectedEntity}
        />

        <View style={styles.section}>
          <AppText variant="heading">
            Strongest capabilities
          </AppText>

          <Card>
            {capabilities.length === 0 ? (
              <AppText variant="body" muted>
                No capabilities mapped yet.
              </AppText>
            ) : (
              <View style={styles.skillList}>
                {capabilities
                  .slice(0, 8)
                  .map((capability, index) => (
                    <Pressable
                      key={`${capability.name}-${index}`}
                      style={styles.skillRow}
                      disabled={
                        capability.skillIds
                          .length === 0
                      }
                      onPress={() =>
                        setSelectedEntity({
                          type: 'skill',
                          entityIds:
                            capability.skillIds,
                          label:
                            capability.name,
                        })
                      }
                    >
                      <View
                        style={styles.skillIcon}
                      >
                        <AppText
                          variant="caption"
                          style={styles.skillIconText}
                        >
                          {index + 1}
                        </AppText>
                      </View>

                      <View
                        style={styles.skillInfo}
                      >
                        <AppText variant="bodyMedium">
                          {capability.name}
                        </AppText>

                        <AppText
                          variant="caption"
                          muted
                        >
                          {capability.connections >
                          0
                            ? `Linked to ${capability.connections} ${pluralize(capability.connections, 'record')} in your graph`
                            : 'Not linked to a record yet'}
                        </AppText>
                      </View>

                      <AppText
                        variant="caption"
                        muted
                      >
                        →
                      </AppText>
                    </Pressable>
                  ))}
              </View>
            )}
          </Card>
        </View>

        <View style={styles.section}>
          <AppText variant="heading">
            Career story
          </AppText>

          <Card>
            <AppText variant="bodyMedium">
              {story.headline}
            </AppText>

            {story.lines.map((line) => (
              <AppText
                key={line.id}
                variant="body"
                muted
                style={styles.cardText}
              >
                {line.text}
              </AppText>
            ))}
          </Card>
        </View>

        {dataQuality.isClean ? null : (
          <View style={styles.section}>
            <DataQualitySection
              report={dataQuality}
            />
          </View>
        )}
      </ScrollView>

      <NodeDetailsModal
        selection={selectedEntity}
        graph={graph}
        evidenceIndex={evidenceIndex}
        onClose={() =>
          setSelectedEntity(null)
        }
      />
    </Screen>
  );
}

/*
 * Evidence Mode: what supports this record, and where it came from.
 *
 * Vocabulary is limited to Supported / Unsupported — nothing in the
 * current schema can honestly justify a stronger claim.
 */
/*
 * One semantic relationship group. The heading states what the
 * relationship is — USED IN, USES SKILLS, PART OF — rather than listing
 * neighbours under a generic label. Groups with no members are dropped
 * upstream, so this never renders an empty section.
 */
/*
 * What to say when a record has no structural relationships.
 *
 * The wording is scoped to the type so it never contradicts Evidence Mode
 * directly below it: an achievement with no role or project link is still
 * backed by the resume it came from, and saying "no linked records" there
 * would read as though nothing supports it. Evidence and the person node
 * say nothing at all — their content is entirely Evidence Mode's.
 */
function getEmptyRelationsText(
  type: DetailEntityType,
): string | null {
  switch (type) {
    case 'achievement':
      return 'No roles or projects list this achievement yet.';

    case 'skill':
      return 'No roles or projects list this skill yet.';

    case 'education':
      return 'No roles, projects or skills link to this education record.';

    case 'experience':
    case 'project':
      return 'No linked records yet.';

    case 'evidence':
    case 'person':
      return null;
  }
}

/*
 * Records that could use the user's attention.
 *
 * Deliberately not a score, a grade, or a completeness percentage — those
 * invite optimising the number instead of the record, and a career is not
 * a number. Each line states what is missing or what disagrees, and says
 * nothing about whether the career itself is any good.
 *
 * Renders nothing at all when there is nothing to report.
 */
function DataQualitySection({
  report,
}: {
  report: DataQualityReport;
}) {
  if (report.isClean) {
    return null;
  }

  return (
    <>
      <View style={styles.sectionHeader}>
        <AppText variant="heading">
          Needs review
        </AppText>

        <AppText variant="caption" muted>
          From your graph
        </AppText>
      </View>

      <Card>
        <View style={styles.qualityList}>
          {report.issues.map((issue) => (
            <View
              key={issue.id}
              style={styles.qualityRow}
            >
              <View
                style={styles.qualityDot}
              />

              <View
                style={styles.qualityText}
              >
                <AppText variant="body">
                  {issue.message}
                </AppText>

                {issue.entities.length > 0 ? (
                  <AppText
                    variant="caption"
                    muted
                    style={styles.qualityMeta}
                  >
                    {issue.entities
                      .slice(0, 3)
                      .map(
                        (entity) =>
                          entity.label,
                      )
                      .join(', ')}
                    {issue.entities.length > 3
                      ? ` +${issue.entities.length - 3} more`
                      : ''}
                  </AppText>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      </Card>
    </>
  );
}

function RelationGroupBlock({
  group,
}: {
  group: RelationGroup;
}) {
  return (
    <View style={styles.relationGroup}>
      <AppText variant="caption" muted>
        {group.title}
      </AppText>

      <View style={styles.connectionList}>
        {group.items
          .slice(0, 8)
          .map((item) => (
            <View
              key={`${item.entityType}-${item.entityId}`}
              style={styles.connectionRow}
            >
              <View
                style={styles.connectionDot}
              />

              <AppText variant="body">
                {item.label}
              </AppText>
            </View>
          ))}

        {group.items.length > 8 ? (
          <AppText
            variant="caption"
            muted
            style={styles.truncationNote}
          >
            {`Showing 8 of ${group.items.length}`}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

function EvidenceSection({
  selection,
  evidenceIndex,
}: {
  selection: DetailSelection;
  evidenceIndex: EvidenceIndex;
}) {
  if (selection.type === 'person') {
    return null;
  }

  /*
   * An evidence node is the source end of the chain, so it shows its own
   * record rather than asking what supports it.
   */
  if (selection.type === 'evidence') {
    const record =
      evidenceIndex.byId[
        selection.entityIds[0]
      ];

    return (
      <View style={styles.evidenceSection}>
        <View style={styles.sheetDivider} />

        <AppText variant="caption" muted>
          SOURCE
        </AppText>

        {record ? (
          <EvidenceCard
            record={record}
            excludeEntityIds={[]}
          />
        ) : (
          <AppText
            variant="body"
            muted
            style={styles.evidenceEmpty}
          >
            This evidence record is no longer
            in your graph.
          </AppText>
        )}
      </View>
    );
  }

  const entityType: EvidenceEntityType =
    selection.type;

  /*
   * Union across ids so a merged capability row reports every record that
   * supports any of the Skill rows behind it.
   */
  const evidence = getEvidenceForEntities(
    evidenceIndex,
    entityType,
    selection.entityIds,
  );

  const summary = getSupportSummary(
    evidenceIndex,
    entityType,
    selection.entityIds[0] ?? '',
  );

  const isSupported = evidence.length > 0;

  return (
    <View style={styles.evidenceSection}>
      <View style={styles.sheetDivider} />

      <View style={styles.evidenceHeader}>
        <AppText variant="caption" muted>
          EVIDENCE
        </AppText>

        <View
          style={[
            styles.supportBadge,
            isSupported
              ? styles.supportBadgeOn
              : styles.supportBadgeOff,
          ]}
        >
          <AppText
            variant="caption"
            style={styles.supportBadgeText}
          >
            {isSupported
              ? 'Supported'
              : 'Unsupported'}
          </AppText>
        </View>
      </View>

      {isSupported ? (
        <View style={styles.evidenceList}>
          {evidence.map((record) => (
            <EvidenceCard
              key={record.id}
              record={record}
              excludeEntityIds={
                selection.entityIds
              }
            />
          ))}
        </View>
      ) : (
        <View style={styles.evidenceList}>
          <AppText
            variant="body"
            muted
            style={styles.evidenceEmpty}
          >
            No evidence is linked to this
            record yet.
          </AppText>

          {summary.note ? (
            <AppText
              variant="caption"
              muted
            >
              {summary.note}
            </AppText>
          ) : null}
        </View>
      )}
    </View>
  );
}

function EvidenceCard({
  record,
  excludeEntityIds,
}: {
  record: EvidenceView;
  excludeEntityIds: string[];
}) {
  /*
   * capturedAt is when the record was ingested; occurredAt is when the
   * thing happened. They are labelled separately, and the occurred line is
   * omitted entirely when the payload has no such date.
   */
  const captured = formatEvidenceDate(
    record.capturedAt,
  );

  const occurred = formatEvidenceDate(
    record.occurredAt,
  );

  /* Other records this same evidence backs, matched by id. */
  const alsoSupports = record.links.filter(
    (link) =>
      link.name !== null &&
      !excludeEntityIds.includes(
        link.entityId,
      ),
  );

  return (
    <View style={styles.evidenceCard}>
      <AppText variant="bodyMedium">
        {record.title}
      </AppText>

      <AppText
        variant="caption"
        muted
        style={styles.evidenceMeta}
      >
        {`Source · ${record.source.label}`}
      </AppText>

      {record.source.statement ? (
        <AppText
          variant="caption"
          style={styles.evidenceStatement}
        >
          {record.source.statement}
        </AppText>
      ) : null}

      {record.source.fileName ? (
        <AppText
          variant="caption"
          muted
          style={styles.evidenceMeta}
        >
          {`File · ${record.source.fileName}`}
        </AppText>
      ) : null}

      {captured ? (
        <AppText
          variant="caption"
          muted
          style={styles.evidenceMeta}
        >
          {`Captured · ${captured}`}
        </AppText>
      ) : null}

      {occurred ? (
        <AppText
          variant="caption"
          muted
          style={styles.evidenceMeta}
        >
          {`Occurred · ${occurred}`}
        </AppText>
      ) : null}

      {record.description ? (
        <AppText
          variant="caption"
          muted
          style={styles.evidenceDescription}
        >
          {record.description}
        </AppText>
      ) : null}

      {alsoSupports.length > 0 ? (
        <View style={styles.evidenceLinks}>
          <AppText variant="caption" muted>
            Also supports
          </AppText>

          {alsoSupports
            .slice(0, 6)
            .map((link) => (
              <AppText
                key={`${link.entityType}-${link.entityId}`}
                variant="caption"
                muted
                style={styles.evidenceMeta}
              >
                {`${getNodeTypeLabelForLink(link.entityType)} · ${link.name}`}
              </AppText>
            ))}

          {alsoSupports.length > 6 ? (
            <AppText
              variant="caption"
              muted
              style={styles.evidenceMeta}
            >
              {`+${alsoSupports.length - 6} more`}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function NodeDetailsModal({
  selection,
  graph,
  evidenceIndex,
  onClose,
}: {
  selection: DetailSelection | null;
  graph: CareerGraph;
  evidenceIndex: EvidenceIndex;
  onClose: () => void;
}) {
  if (!selection) {
    return null;
  }

  const style = getNodeStyle(selection.type);

  const relationGroups = getEntityRelations(
    selection,
    graph,
  );

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.modalBackdrop}
        onPress={onClose}
      >
        <Pressable
          style={styles.bottomSheet}
          onPress={() => undefined}
        >
          <View style={styles.sheetHandle} />

          <ScrollView
            style={styles.sheetScroll}
            showsVerticalScrollIndicator={false}
          >
          <View style={styles.sheetHeader}>
            <View
              style={[
                styles.sheetIcon,
                {
                  backgroundColor: style.fill,
                },
              ]}
            >
              <AppText
                variant="bodyMedium"
                style={{
                  color: style.text,
                }}
              >
                {getTypeIcon(selection.type)}
              </AppText>
            </View>

            <View style={styles.sheetTitleArea}>
              <AppText variant="heading">
                {selection.label}
              </AppText>

              <AppText
                variant="caption"
                muted
              >
                {getTypeLabel(selection.type)}
              </AppText>
            </View>

            <Pressable
              style={styles.closeButton}
              onPress={onClose}
            >
              <AppText variant="bodyMedium">
                ×
              </AppText>
            </Pressable>
          </View>

          <View style={styles.sheetDivider} />

          {selection.subtitle ? (
            <AppText
              variant="caption"
              muted
              style={styles.sheetContext}
            >
              {selection.subtitle}
            </AppText>
          ) : null}

          {relationGroups.length === 0 ? (
            getEmptyRelationsText(
              selection.type,
            ) === null ? null : (
              <AppText
                variant="body"
                muted
                style={styles.noConnections}
              >
                {getEmptyRelationsText(
                  selection.type,
                )}
              </AppText>
            )
          ) : (
            relationGroups.map((group) => (
              <RelationGroupBlock
                key={group.kind}
                group={group}
              />
            ))
          )}

          <EvidenceSection
            selection={selection}
            evidenceIndex={evidenceIndex}
          />

          <View style={styles.whyBox}>
            <AppText
              variant="caption"
              muted
            >
              WHY THIS MATTERS
            </AppText>

            <AppText
              variant="body"
              style={styles.whyText}
            >
              Career OS uses these connections to understand
              what you have done, what you can do, and the
              evidence behind it.
            </AppText>
          </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/*
 * Minimal functional rendering of the timeline projection. Visual design is
 * intentionally plain: this exists to verify the data, and the screen is
 * scheduled for redesign against the approved design system.
 */
function CareerTimelineSection({
  timeline,
  onSelect,
}: {
  timeline: CareerTimeline;
  onSelect: (
    selection: DetailSelection,
  ) => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <AppText variant="heading">
          Career timeline
        </AppText>

        <AppText variant="caption" muted>
          {timeline.counts.dated} dated
          {timeline.counts.undated > 0
            ? ` · ${timeline.counts.undated} undated`
            : ''}
        </AppText>
      </View>

      <Card>
        {timeline.isEmpty ? (
          <AppText variant="body" muted>
            No career events yet.
          </AppText>
        ) : (
          <View style={styles.timelineBody}>
            {timeline.counts.dated === 0 ? (
              <AppText variant="body" muted>
                No career events have dates
                yet.
              </AppText>
            ) : (
              timeline.groups.map((group) => (
                <View
                  key={`year-${group.year}`}
                  style={styles.timelineGroup}
                >
                  <AppText
                    variant="bodyMedium"
                    style={styles.timelineYear}
                  >
                    {group.year}
                  </AppText>

                  {group.items.map((item) => (
                    <TimelineRow
                      key={item.id}
                      item={item}
                      onSelect={onSelect}
                    />
                  ))}
                </View>
              ))
            )}

            {timeline.hasUndated ? (
              <View
                style={styles.timelineUndated}
              >
                <AppText
                  variant="bodyMedium"
                  style={styles.timelineYear}
                >
                  Undated
                </AppText>

                <AppText
                  variant="caption"
                  muted
                  style={styles.timelineNote}
                >
                  Some career records don’t
                  have dates yet, so they
                  aren’t placed on the
                  timeline.
                </AppText>

                {timeline.undated.map(
                  (item) => (
                    <TimelineRow
                      key={item.id}
                      item={item}
                      onSelect={onSelect}
                    />
                  ),
                )}
              </View>
            ) : null}

            {timeline.excludedEvidenceCount >
            0 ? (
              <AppText
                variant="caption"
                muted
                style={styles.timelineNote}
              >
                {`${timeline.excludedEvidenceCount} evidence ${
                  timeline.excludedEvidenceCount ===
                  1
                    ? 'record only records'
                    : 'records only record'
                } when it was captured, not when it happened — kept off the timeline.`}
              </AppText>
            ) : null}
          </View>
        )}
      </Card>
    </View>
  );
}

function TimelineRow({
  item,
  onSelect,
}: {
  item: TimelineItem;
  onSelect: (
    selection: DetailSelection,
  ) => void;
}) {
  /*
   * The range and the current-state marker are composed here rather than
   * concatenated inline, so a record carrying one but not the other still
   * renders. An undated role that is current has no range at all, and the
   * marker used to be dropped with it.
   */
  const stateMarker = item.isCurrent
    ? item.stateBasis === 'stated-current'
      ? 'Current'
      : 'Current (assumed)'
    : null;

  const periodLabel = [
    item.rangeLabel,
    stateMarker,
  ]
    .filter(
      (part): part is string =>
        part !== null,
    )
    .join(' · ');

  return (
    <Pressable
      style={styles.timelineRow}
      onPress={() =>
        onSelect({
          type: item.type,
          entityIds: [item.entityId],
          label: item.title,
          subtitle:
            item.subtitle ?? undefined,
        })
      }
    >
      <View style={styles.timelineRowHead}>
        <AppText variant="bodyMedium">
          {item.title}
        </AppText>

        <AppText
          variant="caption"
          muted
          style={styles.timelineType}
        >
          {getTimelineTypeLabel(item.type)}
        </AppText>
      </View>

      {item.subtitle ? (
        <AppText variant="caption" muted>
          {item.subtitle}
        </AppText>
      ) : null}

      {periodLabel ? (
        <AppText variant="caption" muted>
          {periodLabel}
        </AppText>
      ) : null}

      <AppText
        variant="caption"
        muted
        style={styles.timelineProvenance}
      >
        {item.provenance.label}
      </AppText>
    </Pressable>
  );
}

function CareerSnapshotSection({
  snapshot,
}: {
  snapshot: CareerSnapshot;
}) {
  const shapeParts = [
    snapshot.capabilityCount > 0
      ? `${snapshot.capabilityCount} ${pluralize(snapshot.capabilityCount, 'capability', 'capabilities')}`
      : null,
    snapshot.experienceCount > 0
      ? `${snapshot.experienceCount} ${pluralize(snapshot.experienceCount, 'experience')}`
      : null,
    snapshot.projectCount > 0
      ? `${snapshot.projectCount} ${pluralize(snapshot.projectCount, 'project')}`
      : null,
    snapshot.evidenceCount > 0
      ? `${snapshot.evidenceCount} evidence ${pluralize(snapshot.evidenceCount, 'signal')}`
      : null,
    snapshot.achievementCount > 0
      ? `${snapshot.achievementCount} ${pluralize(snapshot.achievementCount, 'achievement')}`
      : null,
  ].filter(
    (part): part is string => part !== null,
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <AppText variant="heading">
          Career Snapshot
        </AppText>

        <AppText variant="caption" muted>
          From your graph
        </AppText>
      </View>

      <Card>
        <View style={styles.identityRow}>
          <View style={styles.identityAvatar}>
            <AppText
              variant="bodyMedium"
              style={styles.identityInitials}
            >
              {snapshot.initials}
            </AppText>
          </View>

          <View style={styles.identityText}>
            <AppText variant="heading">
              {snapshot.name ??
                'Your career profile'}
            </AppText>

            {snapshot.headline ? (
              <AppText
                variant="bodyMedium"
                style={styles.identityHeadline}
              >
                {snapshot.headline}
              </AppText>
            ) : null}

            {snapshot.location ? (
              <AppText
                variant="caption"
                muted
                style={styles.identityMeta}
              >
                {snapshot.location}
              </AppText>
            ) : null}

            {snapshot.headlineIsDerived ? (
              <AppText
                variant="caption"
                muted
                style={styles.identityMeta}
              >
                Summarised from your graph — add
                a headline to personalise it.
              </AppText>
            ) : null}
          </View>
        </View>
      </Card>

      <View style={styles.snapshotGrid}>
        <SnapshotTile
          label="Capabilities"
          value={
            snapshot.capabilityCount > 0
              ? `${snapshot.capabilityCount} ${pluralize(snapshot.capabilityCount, 'capability', 'capabilities')}`
              : 'None yet'
          }
          lines={snapshot.capabilities
            .slice(0, 3)
            .map(
              (capability) =>
                capability.name,
            )}
          emptyText="Import a resume to map your skills."
          caption={
            snapshot.capabilityCount > 0
              ? 'Most connected first'
              : null
          }
        />

        <SnapshotTile
          label="Experience"
          value={
            snapshot.experienceCount > 0
              ? `${snapshot.experienceCount} ${pluralize(snapshot.experienceCount, 'role')}`
              : 'None yet'
          }
          lines={
            snapshot.latestExperience
              ? [
                  snapshot.latestExperience
                    .title,
                  snapshot.latestExperience
                    .company,
                  snapshot.latestExperience
                    .period,
                ].filter(
                  (line): line is string =>
                    line !== null,
                )
              : []
          }
          emptyText="No roles recorded yet."
          caption={
            snapshot.latestExperience
              ? 'Most recent'
              : null
          }
        />

        <SnapshotTile
          label="Projects"
          value={
            snapshot.projectCount > 0
              ? `${snapshot.projectCount} ${pluralize(snapshot.projectCount, 'project')}`
              : 'None yet'
          }
          lines={snapshot.recentProjects}
          emptyText="No projects recorded yet."
          caption={
            snapshot.recentProjects.length > 0
              ? 'Most recent'
              : null
          }
        />

        <SnapshotTile
          label="Evidence"
          value={
            snapshot.evidenceCount > 0
              ? `${snapshot.evidenceCount} ${pluralize(snapshot.evidenceCount, 'signal')}`
              : 'None yet'
          }
          lines={
            snapshot.latestEvidence
              ? [snapshot.latestEvidence]
              : []
          }
          emptyText="No supporting signals yet."
          caption={
            snapshot.latestEvidence
              ? 'Latest captured'
              : null
          }
        />
      </View>

      <Card>
        <AppText variant="bodyMedium">
          Career shape
        </AppText>

        <AppText
          variant="body"
          muted
          style={styles.shapeText}
        >
          {shapeParts.length > 0
            ? shapeParts.join('  ·  ')
            : 'No records in your graph yet.'}
        </AppText>

        {shapeParts.length > 0 ? (
          <AppText
            variant="caption"
            muted
            style={styles.shapeFootnote}
          >
            {snapshot.totalRecords} records
            counted directly from your career
            graph.
          </AppText>
        ) : null}
      </Card>
    </View>
  );
}

function SnapshotTile({
  label,
  value,
  lines,
  caption,
  emptyText,
}: {
  label: string;
  value: string;
  lines: string[];
  caption: string | null;
  emptyText: string;
}) {
  return (
    <View style={styles.snapshotTile}>
      <AppText
        variant="caption"
        muted
        style={styles.snapshotTileLabel}
      >
        {label}
      </AppText>

      <AppText
        variant="bodyMedium"
        style={styles.snapshotTileValue}
      >
        {value}
      </AppText>

      {lines.length === 0 ? (
        <AppText
          variant="caption"
          muted
          style={styles.snapshotTileEmpty}
        >
          {emptyText}
        </AppText>
      ) : (
        <View style={styles.snapshotTileLines}>
          {caption ? (
            <AppText
              variant="caption"
              muted
              style={styles.snapshotTileCaption}
            >
              {caption}
            </AppText>
          ) : null}

          {lines.map((line, index) => (
            <AppText
              key={`${line}-${index}`}
              variant="caption"
              muted={index > 0}
              style={styles.snapshotTileLine}
            >
              {truncate(line, 24)}
            </AppText>
          ))}
        </View>
      )}
    </View>
  );
}

function LegendItem({
  label,
  type,
}: {
  label: string;
  type: GraphNodeType;
}) {
  const style = getNodeStyle(type);

  return (
    <View style={styles.legendItem}>
      <View
        style={[
          styles.legendDot,
          {
            backgroundColor: style.fill,
            borderColor: style.stroke,
          },
        ]}
      />

      <AppText
        variant="caption"
        muted
      >
        {label}
      </AppText>
    </View>
  );
}

type CapabilitySummary = {
  /** Display label, taken from the first Skill row that produced this row. */
  name: string;
  /** Experience/project records referencing this capability. */
  connections: number;
  /*
   * Stable Skill.id values behind this display row — normally one. More
   * than one only when the graph genuinely holds separate Skill records
   * that happen to read the same. Empty when the payload carried no id.
   */
  skillIds: string[];
};

type CareerSnapshot = {
  name: string | null;
  headline: string | null;
  headlineIsDerived: boolean;
  location: string | null;
  initials: string;
  capabilities: CapabilitySummary[];
  capabilityCount: number;
  experienceCount: number;
  latestExperience: {
    title: string;
    company: string | null;
    period: string | null;
  } | null;
  projectCount: number;
  recentProjects: string[];
  evidenceCount: number;
  latestEvidence: string | null;
  achievementCount: number;
  totalRecords: number;
};

// Everything below is a deterministic read of the CareerGraph payload:
// counting records, de-duplicating, sorting by date, formatting. No value
// is inferred or generated.
function buildCareerSnapshot(
  graph: CareerGraph,
): CareerSnapshot {
  const userSkills = toArray(graph.userSkills);
  const experiences = toArray(graph.experiences);
  const projects = toArray(graph.projects);
  const evidence = toArray(graph.evidence);
  const achievements = toArray(graph.achievements);

  const capabilities = rankCapabilities(
    userSkills,
    experiences,
    projects,
  );

  const name = getProfileName(graph.profile);

  const latestExperienceRecord =
    pickMostRecent(
      experiences,
      getExperienceRecency,
    );

  const orderedProjects = sortByRecency(
    projects,
    getProjectRecency,
  );

  const latestEvidenceRecord = pickMostRecent(
    evidence,
    getEvidenceRecency,
  );

  const derivedHeadline = deriveHeadline(
    capabilities,
    experiences.length,
    projects.length,
    evidence.length,
  );

  const profileHeadline = getStringField(
    graph.profile,
    'headline',
  );

  return {
    name,
    headline: profileHeadline ?? derivedHeadline,
    headlineIsDerived:
      profileHeadline === null &&
      derivedHeadline !== null,
    location: getStringField(
      graph.profile,
      'location',
    ),
    initials: getInitials(name),
    capabilities,
    capabilityCount: capabilities.length,
    experienceCount: experiences.length,
    latestExperience: latestExperienceRecord
      ? {
          title: getExperienceTitle(
            latestExperienceRecord,
          ),
          company: getSnapshotCompanyName(
            latestExperienceRecord,
          ),
          period: formatPeriod(
            latestExperienceRecord,
          ),
        }
      : null,
    projectCount: projects.length,
    recentProjects: orderedProjects
      .slice(0, 2)
      .map(getProjectName),
    evidenceCount: evidence.length,
    latestEvidence: latestEvidenceRecord
      ? getEvidenceTitle(
          latestEvidenceRecord,
        )
      : null,
    achievementCount: achievements.length,
    totalRecords:
      capabilities.length +
      experiences.length +
      projects.length +
      evidence.length +
      achievements.length,
  };
}

// "Strongest" = most referenced across the graph, which is a count of real
// records rather than an invented proficiency score. Ties keep the order
// the API returned them in, so the list is stable between refreshes.
/*
 * Identity of a skill reference.
 *
 * Skill.id is the identity: two rows are the same capability when they
 * point at the same Skill record, never because they read alike. The
 * normalized name is only a fallback for payloads that omit the id, and it
 * is namespaced so a name can never collide with a real id.
 *
 * The same shape covers UserSkill, ExperienceSkill and ProjectSkill rows —
 * all three carry `skillId` plus a hydrated `skill`.
 */
function getSkillIdentity(item: unknown) {
  const id =
    getStringField(item, 'skillId') ??
    getStringField(
      getObjectField(item, 'skill'),
      'id',
    );

  const name = getSkillName(item);

  return {
    id,
    name,
    key:
      id ?? `name:${normalizeSkillName(name)}`,
  };
}

function normalizeSkillName(name: string) {
  return name.trim().toLowerCase();
}

/*
 * "Strongest" = referenced by the most experience and project records.
 *
 * Two distinct layers, deliberately kept apart:
 *
 *   1. Identity — one entry per distinct Skill.id. All reference counting
 *      happens here, so two different Skill records never merge just
 *      because they share a name.
 *
 *   2. Display — rows that read identically are collapsed for
 *      presentation, so the user never sees "Python" twice. The ids that
 *      fed each row are retained on `skillIds`.
 */
function rankCapabilities(
  userSkills: unknown[],
  experiences: unknown[],
  projects: unknown[],
): CapabilitySummary[] {
  type Entry = {
    id: string | null;
    name: string;
    connections: number;
    order: number;
  };

  const entries = new Map<string, Entry>();

  userSkills.forEach((item, index) => {
    const identity = getSkillIdentity(item);

    if (entries.has(identity.key)) {
      return;
    }

    entries.set(identity.key, {
      id: identity.id,
      name: identity.name,
      connections: 0,
      order: index,
    });
  });

  /*
   * Only experiences and projects carry a skill relation. Each record
   * counts at most once per capability.
   */
  [...experiences, ...projects].forEach(
    (record) => {
      const seen = new Set<string>();

      toArray(
        getObjectField(record, 'skills'),
      ).forEach((row) => {
        const identity =
          getSkillIdentity(row);

        if (seen.has(identity.key)) {
          return;
        }

        seen.add(identity.key);

        const entry = entries.get(
          identity.key,
        );

        if (entry) {
          entry.connections += 1;
        }
      });
    },
  );

  const display = new Map<
    string,
    CapabilitySummary & { order: number }
  >();

  entries.forEach((entry) => {
    const displayKey = normalizeSkillName(
      entry.name,
    );

    const existing = display.get(displayKey);

    if (existing) {
      existing.connections +=
        entry.connections;

      existing.order = Math.min(
        existing.order,
        entry.order,
      );

      if (
        entry.id !== null &&
        !existing.skillIds.includes(entry.id)
      ) {
        existing.skillIds.push(entry.id);
      }

      return;
    }

    display.set(displayKey, {
      name: entry.name,
      connections: entry.connections,
      skillIds:
        entry.id !== null ? [entry.id] : [],
      order: entry.order,
    });
  });

  return [...display.values()]
    .sort(
      (a, b) =>
        b.connections - a.connections ||
        a.order - b.order,
    )
    .map(
      ({ name, connections, skillIds }) => ({
        name,
        connections,
        skillIds,
      }),
    );
}

// Used only when the profile has no headline of its own. Built from a real
// skill name plus a record count, so it never asserts a job title.
function deriveHeadline(
  capabilities: CapabilitySummary[],
  experienceCount: number,
  projectCount: number,
  evidenceCount: number,
): string | null {
  const parts: string[] = [];

  if (capabilities.length > 0) {
    parts.push(capabilities[0].name);
  }

  if (experienceCount > 0) {
    parts.push(
      `${experienceCount} ${pluralize(experienceCount, 'role')}`,
    );
  } else if (projectCount > 0) {
    parts.push(
      `${projectCount} ${pluralize(projectCount, 'project')}`,
    );
  } else if (evidenceCount > 0) {
    parts.push(
      `${evidenceCount} ${pluralize(evidenceCount, 'signal')}`,
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' • ');
}

function getProfileName(
  profile: unknown,
): string | null {
  const parts = [
    getStringField(profile, 'firstName'),
    getStringField(profile, 'lastName'),
  ].filter(
    (part): part is string => part !== null,
  );

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' ');
}

/*
 * Initials come from the profile name only. The payload carries no email
 * (the User model has no such column), so there is nothing else to derive
 * them from — a nameless profile gets a neutral mark rather than a guess.
 */
function getInitials(name: string | null) {
  if (name) {
    const initials = name
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .slice(0, 2)
      .map((part) =>
        part.charAt(0).toUpperCase(),
      )
      .join('');

    if (initials.length > 0) {
      return initials;
    }
  }

  return '•';
}

function getSnapshotCompanyName(
  item: unknown,
): string | null {
  if (
    typeof item === 'object' &&
    item !== null &&
    'company' in item
  ) {
    return getStringField(
      item.company,
      'name',
    );
  }

  return null;
}

// Year-only range, and the one place a card can say a role is open: entity
// cards render `period` alone, with no marker beside it. So unlike the
// timeline — where TimelineRow appends the marker — the qualification has
// to live inside the string.
//
// "Present" is reserved for a record that STATED it is ongoing. A record
// that is current only because no end date was supplied says so as
// "Current (assumed)", because dropping the marker entirely would have
// left the card silent about a role the timeline calls current.
function formatPeriod(
  item: unknown,
): string | null {
  const start = getYearField(
    item,
    'startDate',
  );

  const end = getYearField(item, 'endDate');

  const careerState = getCareerState(item);

  const isCurrent =
    careerState.state === 'current';

  const statedCurrent =
    careerState.basis === 'stated-current';

  if (start !== null && isCurrent) {
    return statedCurrent
      ? `${start} — Present`
      : `From ${start} · Current (assumed)`;
  }

  if (start !== null && end !== null) {
    return start === end
      ? `${start}`
      : `${start} — ${end}`;
  }

  if (start !== null) {
    return `From ${start}`;
  }

  if (end !== null) {
    return `Until ${end}`;
  }

  if (isCurrent) {
    return statedCurrent
      ? 'Current'
      : 'Current (assumed)';
  }

  return null;
}

function getExperienceRecency(
  item: unknown,
) {
  if (getCareerState(item).state === 'current') {
    return Number.POSITIVE_INFINITY;
  }

  return (
    getTimeField(item, 'endDate') ??
    getTimeField(item, 'startDate') ??
    Number.NEGATIVE_INFINITY
  );
}

function getProjectRecency(item: unknown) {
  return (
    getTimeField(item, 'endDate') ??
    getTimeField(item, 'startDate') ??
    Number.NEGATIVE_INFINITY
  );
}

function getEvidenceRecency(item: unknown) {
  return (
    getTimeField(item, 'capturedAt') ??
    getTimeField(item, 'occurredAt') ??
    Number.NEGATIVE_INFINITY
  );
}

function sortByRecency(
  items: unknown[],
  recencyOf: (item: unknown) => number,
) {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        recencyOf(b.item) -
          recencyOf(a.item) ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

function pickMostRecent(
  items: unknown[],
  recencyOf: (item: unknown) => number,
) {
  if (items.length === 0) {
    return null;
  }

  return sortByRecency(items, recencyOf)[0];
}

function pluralize(
  count: number,
  singular: string,
  plural?: string,
) {
  if (count === 1) {
    return singular;
  }

  return plural ?? `${singular}s`;
}

function getYearField(
  item: unknown,
  key: string,
): number | null {
  const time = getTimeField(item, key);

  if (time === null) {
    return null;
  }

  return new Date(time).getUTCFullYear();
}

function getNodeStyle(
  type: DetailEntityType,
) {
  switch (type) {
    case 'education':
      return {
        radius: NODE_RADIUS.education,
        fill: '#EDE9FE',
        stroke: '#7C3AED',
        text: '#5B21B6',
        glow: '#7C3AED',
      };

    case 'person':
      return {
        radius: NODE_RADIUS.person,
        fill: colors.primary,
        stroke: colors.primary,
        text: colors.primaryText,
        glow: colors.primary,
      };

    case 'skill':
      return {
        radius: NODE_RADIUS.skill,
        fill: '#E0E7FF',
        stroke: '#6366F1',
        text: '#3730A3',
        glow: '#6366F1',
      };

    case 'experience':
      return {
        radius: NODE_RADIUS.experience,
        fill: '#DCFCE7',
        stroke: '#16A34A',
        text: '#166534',
        glow: '#16A34A',
      };

    case 'project':
      return {
        radius: NODE_RADIUS.project,
        fill: '#FEF3C7',
        stroke: '#D97706',
        text: '#92400E',
        glow: '#D97706',
      };

    case 'evidence':
      return {
        radius: NODE_RADIUS.evidence,
        fill: '#FCE7F3',
        stroke: '#DB2777',
        text: '#9D174D',
        glow: '#DB2777',
      };

    case 'achievement':
      return {
        radius: NODE_RADIUS.achievement,
        fill: '#E0F2FE',
        stroke: '#0284C7',
        text: '#075985',
        glow: '#0284C7',
      };
  }
}

function getTypeLabel(
  type: DetailEntityType,
) {
  switch (type) {
    case 'education':
      return 'EDUCATION';

    case 'skill':
      return 'SKILL';

    case 'experience':
      return 'WORK';

    case 'project':
      return 'PROJECT';

    case 'evidence':
      return 'PROOF';

    case 'achievement':
      return 'OUTCOME';

    default:
      return 'CAREER';
  }
}

function getTypeIcon(
  type: DetailEntityType,
) {
  switch (type) {
    case 'education':
      return '◈';

    case 'skill':
      return '✦';

    case 'experience':
      return '▣';

    case 'project':
      return '◆';

    case 'evidence':
      return '✓';

    case 'achievement':
      return '★';

    default:
      return '•';
  }
}

function truncate(
  value: string,
  length: number,
) {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 1)}…`;
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },

  subtitle: {
    marginTop: spacing.xs,
  },

  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.muted,
  },

  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#22C55E',
  },

  liveText: {
    fontWeight: '700',
  },

  graphHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },

  graphHeaderText: {
    flex: 1,
    paddingRight: spacing.xs,
  },

  graphSubtitle: {
    marginTop: spacing.xs,
    lineHeight: 18,
  },

  graphCount: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    flexShrink: 0,
    minWidth: 58,
  },

  graphCountNumber: {
    fontSize: 18,
  },

  graphCanvas: {
    marginTop: spacing.md,
    marginHorizontal: -spacing.sm,
    overflow: 'hidden',
    borderRadius: radius.lg,
    backgroundColor: colors.muted,
  },

  lensRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.md,
  },

  lensChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
  },

  lensChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },

  lensChipIdle: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },

  lensChipText: {
    color: colors.textSecondary,
  },

  lensChipTextActive: {
    color: colors.primaryText,
    fontWeight: '700',
  },

  truncationNote: {
    marginTop: spacing.sm,
    fontSize: 12,
    lineHeight: 16,
  },

  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.md,
  },

  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },

  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
  },

  section: {
    gap: spacing.sm,
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },

  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },

  identityAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },

  identityInitials: {
    color: colors.primaryText,
    fontWeight: '700',
  },

  identityText: {
    flex: 1,
    minWidth: 0,
  },

  identityHeadline: {
    marginTop: 2,
  },

  identityMeta: {
    marginTop: 2,
  },

  snapshotGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },

  snapshotTile: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 0,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },

  snapshotTileLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontSize: 11,
    lineHeight: 14,
  },

  snapshotTileValue: {
    marginTop: spacing.xs,
  },

  snapshotTileLines: {
    marginTop: spacing.sm,
  },

  snapshotTileCaption: {
    fontSize: 11,
    lineHeight: 14,
    marginBottom: 2,
  },

  snapshotTileLine: {
    fontSize: 13,
    lineHeight: 18,
  },

  snapshotTileEmpty: {
    marginTop: spacing.sm,
    fontSize: 13,
    lineHeight: 18,
  },

  shapeText: {
    marginTop: spacing.xs,
    lineHeight: 24,
  },

  shapeFootnote: {
    marginTop: spacing.sm,
  },

  timelineBody: {
    gap: spacing.lg,
  },

  timelineGroup: {
    gap: spacing.sm,
  },

  timelineYear: {
    color: colors.textSecondary,
  },

  timelineRow: {
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    gap: 2,
  },

  timelineRowHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },

  timelineType: {
    flexShrink: 0,
  },

  timelineProvenance: {
    fontSize: 12,
    lineHeight: 16,
  },

  timelineUndated: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  timelineNote: {
    fontSize: 12,
    lineHeight: 16,
  },

  skillList: {
    gap: spacing.md,
  },

  skillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },

  skillIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.muted,
  },

  skillIconText: {
    fontWeight: '700',
  },

  skillInfo: {
    flex: 1,
  },

  cardText: {
    marginTop: spacing.sm,
    lineHeight: 21,
  },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },

  loadingText: {
    marginTop: spacing.md,
  },

  errorText: {
    marginTop: spacing.sm,
    textAlign: 'center',
  },

  retryButton: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },

  retryButtonText: {
    color: colors.primaryText,
  },

  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },

  bottomSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },

  sheetHandle: {
    alignSelf: 'center',
    width: 42,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginBottom: spacing.lg,
  },

  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },

  sheetIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },

  sheetTitleArea: {
    flex: 1,
  },

  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.muted,
  },

  sheetDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },

  connectionList: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },

  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },

  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },

  noConnections: {
    marginTop: spacing.md,
  },

  relationGroup: {
    marginBottom: spacing.md,
  },

  qualityList: {
    gap: spacing.md,
  },

  qualityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },

  qualityDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 8,
    backgroundColor: colors.textSecondary,
  },

  qualityText: {
    flex: 1,
  },

  qualityMeta: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
  },

  sheetContext: {
    marginBottom: spacing.md,
  },

  sheetScroll: {
    maxHeight: 460,
  },

  evidenceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },

  evidenceSection: {
    marginTop: 0,
  },

  supportBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },

  supportBadgeOn: {
    backgroundColor: '#DCFCE7',
    borderColor: '#16A34A',
  },

  supportBadgeOff: {
    backgroundColor: colors.muted,
    borderColor: colors.border,
  },

  supportBadgeText: {
    fontWeight: '700',
    fontSize: 12,
    lineHeight: 16,
  },

  evidenceList: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },

  evidenceEmpty: {
    marginBottom: spacing.xs,
  },

  evidenceCard: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    gap: 2,
  },

  evidenceMeta: {
    fontSize: 12,
    lineHeight: 17,
  },

  evidenceStatement: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.success,
  },

  evidenceDescription: {
    marginTop: spacing.xs,
    fontSize: 12,
    lineHeight: 17,
  },

  evidenceLinks: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 2,
  },

  whyBox: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.muted,
  },

  whyText: {
    marginTop: spacing.xs,
    lineHeight: 21,
  },
});