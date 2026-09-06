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

type GraphNodeType =
  | 'person'
  | 'skill'
  | 'experience'
  | 'project'
  | 'evidence'
  | 'achievement';

type GraphNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  x: number;
  y: number;
  subtitle?: string;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
};

const GRAPH_WIDTH = 390;
const GRAPH_HEIGHT = 520;
const CENTER_X = GRAPH_WIDTH / 2;
const CENTER_Y = GRAPH_HEIGHT / 2;

// Breathing room kept between any painted pixel and the canvas edge.
const GRAPH_PADDING = 12;

// Labels are drawn centred on the node, so they can be wider than the
// circle itself. These keep that overflow inside the canvas.
const NODE_LABEL_MAX_CHARS = 14;
const PERSON_LABEL_MAX_CHARS = 12;
const NODE_LABEL_FONT_SIZE = 10;
const LABEL_CHAR_WIDTH = 5.9;
const NODE_GLOW_PADDING = 7;

// Radial layout is elliptical: the canvas is much taller than it is wide,
// so horizontal reach has to stay shorter than vertical reach.
const SKILL_RX = 100;
const SKILL_RY = 132;
const SPOKE_RX = 138;
const SPOKE_RY = 152;
const OUTER_RX = 150;
const OUTER_RY = 198;

function getLabelHalfWidth(maxChars: number) {
  return (maxChars * LABEL_CHAR_WIDTH) / 2;
}

// Half-extents of everything a node paints: circle + glow ring, and the
// centred label which can be wider than the circle.
function getNodeExtent(type: GraphNodeType) {
  const { radius: nodeRadius } = getNodeStyle(type);
  const outerRadius = nodeRadius + NODE_GLOW_PADDING;

  const labelHalfWidth = getLabelHalfWidth(
    type === 'person'
      ? PERSON_LABEL_MAX_CHARS
      : NODE_LABEL_MAX_CHARS,
  );

  return {
    x: Math.max(outerRadius, labelHalfWidth),
    // Non-person nodes also render a type caption below the label.
    y: outerRadius + (type === 'person' ? 0 : 4),
  };
}

// Places a node on an ellipse around the centre, then guarantees it stays
// inside the canvas no matter how few nodes share a sector.
function placeNode(
  type: GraphNodeType,
  angle: number,
  rx: number,
  ry: number,
) {
  const extent = getNodeExtent(type);

  const minX = GRAPH_PADDING + extent.x;
  const maxX = GRAPH_WIDTH - GRAPH_PADDING - extent.x;
  const minY = GRAPH_PADDING + extent.y;
  const maxY = GRAPH_HEIGHT - GRAPH_PADDING - extent.y;

  return {
    x: clamp(CENTER_X + Math.cos(angle) * rx, minX, maxX),
    y: clamp(CENTER_Y + Math.sin(angle) * ry, minY, maxY),
  };
}

function clamp(
  value: number,
  min: number,
  max: number,
) {
  if (min > max) {
    return (min + max) / 2;
  }

  return Math.min(Math.max(value, min), max);
}

export function CareerScreen() {
  const [graph, setGraph] = useState<CareerGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] =
    useState<GraphNode | null>(null);
  const [canvasWidth, setCanvasWidth] =
    useState(GRAPH_WIDTH);

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

  const graphModel = useMemo(() => {
    if (!graph) {
      return {
        nodes: [] as GraphNode[],
        edges: [] as GraphEdge[],
      };
    }

    return buildGraphModel(graph);
  }, [graph]);

  const snapshot = useMemo(() => {
    if (!graph) {
      return null;
    }

    return buildCareerSnapshot(graph);
  }, [graph]);

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
                {graphModel.nodes.length - 1}
              </AppText>

              <AppText
                variant="caption"
                muted
              >
                signals
              </AppText>
            </View>
          </View>

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
                .filter((edge) => {
                  const isPersonSpoke =
                    edge.from === 'person' ||
                    edge.to === 'person';

                  if (!isPersonSpoke) {
                    return true;
                  }

                  const other =
                    edge.from === 'person'
                      ? edge.to
                      : edge.from;

                  return (
                    !other.startsWith(
                      'evidence-',
                    ) &&
                    !other.startsWith(
                      'achievement-',
                    )
                  );
                })
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

                  return (
                    <Line
                      key={edge.id}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={colors.border}
                      strokeWidth={1.2}
                      strokeOpacity={0.55}
                    />
                  );
                })}

              {graphModel.nodes.map((node) => {
                const nodeStyle =
                  getNodeStyle(node.type);

                const isPerson =
                  node.type === 'person';

                return (
                  <G
                    key={node.id}
                    onPress={() => {
                      if (!isPerson) {
                        setSelectedNode(node);
                      }
                    }}
                  >
                    <Circle
                      cx={node.x}
                      cy={node.y}
                      r={nodeStyle.radius + 7}
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
                    <View
                      key={`${capability.name}-${index}`}
                      style={styles.skillRow}
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
                    </View>
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
              {experiences.length > 0
                ? 'Your experience is becoming a connected career story.'
                : 'Your career story is waiting to be built.'}
            </AppText>

            <AppText
              variant="body"
              muted
              style={styles.cardText}
            >
              {projects.length > 0
                ? `${projects.length} project${projects.length === 1 ? '' : 's'} and ${achievements.length} achievement${achievements.length === 1 ? '' : 's'} are already part of your graph.`
                : 'Confirm more career information to make the graph richer.'}
            </AppText>
          </Card>
        </View>
      </ScrollView>

      <NodeDetailsModal
        node={selectedNode}
        graph={graph}
        onClose={() => setSelectedNode(null)}
      />
    </Screen>
  );
}

function NodeDetailsModal({
  node,
  graph,
  onClose,
}: {
  node: GraphNode | null;
  graph: CareerGraph;
  onClose: () => void;
}) {
  if (!node) {
    return null;
  }

  const style = getNodeStyle(node.type);

  const connections = getNodeConnections(
    node,
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
                {getTypeIcon(node.type)}
              </AppText>
            </View>

            <View style={styles.sheetTitleArea}>
              <AppText variant="heading">
                {node.label}
              </AppText>

              <AppText
                variant="caption"
                muted
              >
                {getTypeLabel(node.type)}
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

          <AppText
            variant="caption"
            muted
          >
            CONNECTED TO
          </AppText>

          {connections.length === 0 ? (
            <AppText
              variant="body"
              muted
              style={styles.noConnections}
            >
              No connected records yet.
            </AppText>
          ) : (
            <View style={styles.connectionList}>
              {connections
                .slice(0, 8)
                .map((connection, index) => (
                  <View
                    key={`${connection}-${index}`}
                    style={styles.connectionRow}
                  >
                    <View style={styles.connectionDot} />

                    <AppText variant="body">
                      {connection}
                    </AppText>
                  </View>
                ))}
            </View>
          )}

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
        </Pressable>
      </Pressable>
    </Modal>
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
  name: string;
  connections: number;
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
    initials: getInitials(name, graph.email),
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
function rankCapabilities(
  userSkills: unknown[],
  experiences: unknown[],
  projects: unknown[],
): CapabilitySummary[] {
  const entries = new Map<
    string,
    CapabilitySummary & { index: number }
  >();

  userSkills.forEach((item, index) => {
    const name = getSkillName(item);
    const key = name.toLowerCase();

    if (entries.has(key)) {
      return;
    }

    entries.set(key, {
      name,
      connections: 0,
      index,
    });
  });

  // Only experiences and projects carry a hydrated skill relation; the
  // evidence payload exposes join rows without skill names.
  [...experiences, ...projects].forEach(
    (record) => {
      const seen = new Set<string>();

      getNestedSkillNames(record).forEach(
        (skillName) => {
          const key = skillName.toLowerCase();

          if (seen.has(key)) {
            return;
          }

          seen.add(key);

          const entry = entries.get(key);

          if (entry) {
            entry.connections += 1;
          }
        },
      );
    },
  );

  return [...entries.values()]
    .sort(
      (a, b) =>
        b.connections - a.connections ||
        a.index - b.index,
    )
    .map(({ name, connections }) => ({
      name,
      connections,
    }));
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

function getInitials(
  name: string | null,
  email: string,
) {
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

  if (email.length > 0) {
    return email.charAt(0).toUpperCase();
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

// Year-only range. A record with a start date but no end date and no
// isCurrent flag is rendered as "From <year>" rather than "— Present",
// because the payload does not say the role is ongoing.
function formatPeriod(
  item: unknown,
): string | null {
  const start = getYearField(
    item,
    'startDate',
  );

  const end = getYearField(item, 'endDate');

  const isCurrent = getBooleanField(
    item,
    'isCurrent',
  );

  if (start !== null && isCurrent) {
    return `${start} — Present`;
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
    return 'Current';
  }

  return null;
}

function getExperienceRecency(
  item: unknown,
) {
  if (getBooleanField(item, 'isCurrent')) {
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

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function getStringField(
  item: unknown,
  key: string,
): string | null {
  if (
    typeof item !== 'object' ||
    item === null
  ) {
    return null;
  }

  const value = (
    item as Record<string, unknown>
  )[key];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0
    ? trimmed
    : null;
}

function getBooleanField(
  item: unknown,
  key: string,
) {
  if (
    typeof item !== 'object' ||
    item === null
  ) {
    return false;
  }

  return (
    (item as Record<string, unknown>)[key] ===
    true
  );
}

function getTimeField(
  item: unknown,
  key: string,
): number | null {
  const value = getStringField(item, key);

  if (value === null) {
    return null;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
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

function buildGraphModel(
  graph: CareerGraph,
) {
  const nodes: GraphNode[] = [
    {
      id: 'person',
      label: 'YOU',
      type: 'person',
      x: CENTER_X,
      y: CENTER_Y,
    },
  ];

  const edges: GraphEdge[] = [];

  const addNode = (
    node: GraphNode,
  ) => {
    if (
      nodes.some(
        (existing) => existing.id === node.id,
      )
    ) {
      return;
    }

    nodes.push(node);
  };

  const addEdge = (
    from: string,
    to: string,
  ) => {
    const id = `${from}-${to}`;

    if (
      edges.some(
        (edge) =>
          edge.id === id ||
          edge.id === `${to}-${from}`,
      )
    ) {
      return;
    }

    edges.push({
      id,
      from,
      to,
    });
  };

  const skills = graph.userSkills
    .slice(0, 8)
    .map((item, index) => {
      const name = getSkillName(item);
      const count = Math.min(
        graph.userSkills.length,
        8,
      );
      const angle =
        -Math.PI / 2 +
        (index / Math.max(count, 1)) *
          Math.PI *
          2;

      const node: GraphNode = {
        id: `skill-${getNestedId(item, index)}`,
        label: name,
        type: 'skill',
        ...placeNode(
          'skill',
          angle,
          SKILL_RX,
          SKILL_RY,
        ),
      };

      addNode(node);
      addEdge('person', node.id);

      return node;
    });

  const projects = graph.projects
    .slice(0, 5)
    .map((item, index) => {
      const count = Math.min(
        graph.projects.length,
        5,
      );
      const sectorStart = -Math.PI / 3;
      const sectorEnd = Math.PI / 3;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `project-${getNestedId(item, index)}`,
        label: getProjectName(item),
        type: 'project',
        ...placeNode(
          'project',
          angle,
          SPOKE_RX,
          SPOKE_RY,
        ),
      };

      addNode(node);
      addEdge('person', node.id);

      connectNestedSkills(
        item,
        node.id,
        skills,
        addEdge,
      );

      return node;
    });

  const experiences = graph.experiences
    .slice(0, 4)
    .map((item, index) => {
      const count = Math.min(
        graph.experiences.length,
        4,
      );
      const sectorStart = (2 * Math.PI) / 3;
      const sectorEnd = (4 * Math.PI) / 3;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `experience-${getNestedId(item, index)}`,
        label: getExperienceTitle(item),
        type: 'experience',
        ...placeNode(
          'experience',
          angle,
          SPOKE_RX,
          SPOKE_RY,
        ),
        subtitle: getCompanyName(item),
      };

      addNode(node);
      addEdge('person', node.id);

      return node;
    });

  const evidence = graph.evidence
    .slice(0, 5)
    .map((item, index) => {
      const count = Math.min(
        graph.evidence.length,
        5,
      );
      const sectorStart = Math.PI / 4;
      const sectorEnd = (3 * Math.PI) / 4;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `evidence-${getNestedId(item, index)}`,
        label: getEvidenceTitle(item),
        type: 'evidence',
        ...placeNode(
          'evidence',
          angle,
          OUTER_RX,
          OUTER_RY,
        ),
      };

      addNode(node);
      addEdge('person', node.id);

      return node;
    });

  graph.achievements
    .slice(0, 4)
    .forEach((item, index) => {
      const count = Math.min(
        graph.achievements.length,
        4,
      );
      const sectorStart = (5 * Math.PI) / 4;
      const sectorEnd = (7 * Math.PI) / 4;
      const angle =
        count <= 1
          ? (sectorStart + sectorEnd) / 2
          : sectorStart +
            ((index + 0.5) / count) *
              (sectorEnd - sectorStart);

      const node: GraphNode = {
        id: `achievement-${getNestedId(item, index)}`,
        label: getAchievementTitle(item),
        type: 'achievement',
        ...placeNode(
          'achievement',
          angle,
          OUTER_RX,
          OUTER_RY,
        ),
      };

      addNode(node);
      addEdge('person', node.id);
    });

  return {
    nodes,
    edges,
  };
}

function connectNestedSkills(
  item: unknown,
  projectId: string,
  skills: GraphNode[],
  addEdge: (
    from: string,
    to: string,
  ) => void,
) {
  if (
    typeof item !== 'object' ||
    item === null ||
    !('skills' in item) ||
    !Array.isArray(item.skills)
  ) {
    return;
  }

  item.skills.forEach((relationship) => {
    const skillName =
      getSkillName(relationship);

    const matchingSkill = skills.find(
      (skill) =>
        skill.label.toLowerCase() ===
        skillName.toLowerCase(),
    );

    if (matchingSkill) {
      addEdge(projectId, matchingSkill.id);
    }
  });
}

function getNodeConnections(
  node: GraphNode,
  graph: CareerGraph,
): string[] {
  if (node.type === 'skill') {
    const connections: string[] = [];

    graph.experiences.forEach((experience) => {
      if (hasSkill(experience, node.label)) {
        connections.push(
          `Experience · ${getExperienceTitle(
            experience,
          )}`,
        );
      }
    });

    graph.projects.forEach((project) => {
      if (hasSkill(project, node.label)) {
        connections.push(
          `Project · ${getProjectName(project)}`,
        );
      }
    });

    graph.evidence.forEach((item) => {
      if (hasNestedSkill(item, node.label)) {
        connections.push(
          `Evidence · ${getEvidenceTitle(item)}`,
        );
      }
    });

    return connections;
  }

  if (node.type === 'project') {
    const project = graph.projects.find(
      (item, index) =>
        `project-${getNestedId(item, index)}` ===
        node.id,
    );

    if (!project) {
      return [];
    }

    return [
      ...getNestedSkillNames(project).map(
        (skill) => `Skill · ${skill}`,
      ),
      ...getNestedAchievementNames(project).map(
        (achievement) =>
          `Achievement · ${achievement}`,
      ),
    ];
  }

  if (node.type === 'experience') {
    const experience = graph.experiences.find(
      (item, index) =>
        `experience-${getNestedId(item, index)}` ===
        node.id,
    );

    if (!experience) {
      return [];
    }

    return [
      getCompanyName(experience),
      ...getNestedSkillNames(experience).map(
        (skill) => `Skill · ${skill}`,
      ),
    ];
  }

  if (node.type === 'evidence') {
    const evidence = graph.evidence.find(
      (item, index) =>
        `evidence-${getNestedId(item, index)}` ===
        node.id,
    );

    if (!evidence) {
      return [];
    }

    return [
      ...getNestedSkillNames(evidence).map(
        (skill) => `Skill · ${skill}`,
      ),
      ...getNestedProjectNames(evidence).map(
        (project) => `Project · ${project}`,
      ),
    ];
  }

  if (node.type === 'achievement') {
    const achievement = graph.achievements.find(
      (item, index) =>
        `achievement-${getNestedId(item, index)}` ===
        node.id,
    );

    if (!achievement) {
      return [];
    }

    return graph.evidence
      .filter((item) =>
        hasNestedAchievement(
          item,
          getAchievementTitle(achievement),
        ),
      )
      .map(
        (item) =>
          `Evidence · ${getEvidenceTitle(item)}`,
      );
  }

  return [];
}

function getNodeStyle(
  type: GraphNodeType,
) {
  switch (type) {
    case 'person':
      return {
        radius: 42,
        fill: colors.primary,
        stroke: colors.primary,
        text: colors.primaryText,
        glow: colors.primary,
      };

    case 'skill':
      return {
        radius: 28,
        fill: '#E0E7FF',
        stroke: '#6366F1',
        text: '#3730A3',
        glow: '#6366F1',
      };

    case 'experience':
      return {
        radius: 31,
        fill: '#DCFCE7',
        stroke: '#16A34A',
        text: '#166534',
        glow: '#16A34A',
      };

    case 'project':
      return {
        radius: 30,
        fill: '#FEF3C7',
        stroke: '#D97706',
        text: '#92400E',
        glow: '#D97706',
      };

    case 'evidence':
      return {
        radius: 27,
        fill: '#FCE7F3',
        stroke: '#DB2777',
        text: '#9D174D',
        glow: '#DB2777',
      };

    case 'achievement':
      return {
        radius: 29,
        fill: '#E0F2FE',
        stroke: '#0284C7',
        text: '#075985',
        glow: '#0284C7',
      };
  }
}

function getTypeLabel(
  type: GraphNodeType,
) {
  switch (type) {
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
  type: GraphNodeType,
) {
  switch (type) {
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

function getNestedId(
  item: unknown,
  fallback: number,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    typeof item.id === 'string'
  ) {
    return item.id;
  }

  return String(fallback);
}

function getSkillName(item: unknown) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'skill' in item &&
    typeof item.skill === 'object' &&
    item.skill !== null &&
    'name' in item.skill &&
    typeof item.skill.name === 'string'
  ) {
    return item.skill.name;
  }

  if (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    typeof item.name === 'string'
  ) {
    return item.name;
  }

  return 'Skill';
}

function getExperienceTitle(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'title' in item &&
    typeof item.title === 'string'
  ) {
    return item.title;
  }

  return 'Experience';
}

function getCompanyName(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'company' in item &&
    typeof item.company === 'object' &&
    item.company !== null &&
    'name' in item.company &&
    typeof item.company.name === 'string'
  ) {
    return item.company.name;
  }

  return 'Company not specified';
}

function getProjectName(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    typeof item.name === 'string'
  ) {
    return item.name;
  }

  return 'Project';
}

function getEvidenceTitle(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'title' in item &&
    typeof item.title === 'string'
  ) {
    return item.title;
  }

  return 'Evidence';
}

function getAchievementTitle(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'title' in item &&
    typeof item.title === 'string'
  ) {
    return item.title;
  }

  return 'Achievement';
}

function hasSkill(
  item: unknown,
  skillName: string,
) {
  return getNestedSkillNames(item)
    .some(
      (skill) =>
        skill.toLowerCase() ===
        skillName.toLowerCase(),
    );
}

function hasNestedSkill(
  item: unknown,
  skillName: string,
) {
  return hasSkill(item, skillName);
}

function getNestedSkillNames(
  item: unknown,
): string[] {
  if (
    typeof item !== 'object' ||
    item === null ||
    !('skills' in item) ||
    !Array.isArray(item.skills)
  ) {
    return [];
  }

  return item.skills.map(getSkillName);
}

function getNestedAchievementNames(
  item: unknown,
): string[] {
  if (
    typeof item !== 'object' ||
    item === null ||
    !('achievements' in item) ||
    !Array.isArray(item.achievements)
  ) {
    return [];
  }

  return item.achievements.map(
    getAchievementTitle,
  );
}

function getNestedProjectNames(
  item: unknown,
): string[] {
  if (
    typeof item !== 'object' ||
    item === null ||
    !('projects' in item) ||
    !Array.isArray(item.projects)
  ) {
    return [];
  }

  return item.projects.map(
    getProjectNameFromRelationship,
  );
}

function getProjectNameFromRelationship(
  item: unknown,
) {
  if (
    typeof item === 'object' &&
    item !== null &&
    'project' in item &&
    typeof item.project === 'object' &&
    item.project !== null &&
    'name' in item.project &&
    typeof item.project.name === 'string'
  ) {
    return item.project.name;
  }

  return getProjectName(item);
}

function hasNestedAchievement(
  item: unknown,
  achievementTitle: string,
) {
  return getNestedAchievementNames(item)
    .some(
      (achievement) =>
        achievement.toLowerCase() ===
        achievementTitle.toLowerCase(),
    );
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