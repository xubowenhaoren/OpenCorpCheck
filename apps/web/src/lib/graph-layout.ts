import type { CompanyGraphView, CompanySummary, RelationView } from "@occ/core";

import {
  relationCategory,
  truncate,
  type RelationCategory,
} from "../format";

export const CENTER_X = 480;
export const CENTER_Y = 360;
export const CENTER_RADIUS = 38;
export const NODE_RADIUS = 18;
export const CLUSTER_RADIUS = 21;
export const CLUSTER_ID = "__other_holders__";

/**
 * Top-N default for dense ownership graphs. 13F/HKEX DION add 25–40 direct
 * neighbours to a large cap; showing all of them turns the graph into a
 * hairball. Below the collapse threshold the graph is already readable, so the
 * top-N rule only kicks in when a company really is dense.
 */
export const TOP_HOLDER_LIMIT = 10;
export const COLLAPSE_THRESHOLD = 12;

/** Filing sources that add many holders at once (13F / HKEX DI). */
const DENSE_OWNERSHIP_SOURCES = new Set(["sec-13f-v1", "hkex-dion-v1"]);

const START_ANGLE = -90;
const SINGLE_RADIUS_SMALL = 200;
const SINGLE_RADIUS_MEDIUM = 220;
const SINGLE_RADIUS_LARGE = 270;
const INNER_RADIUS = 222;
const OUTER_RADIUS = 302;
const SECOND_RADIUS = 330;
const DENSE_SECOND_RADIUS = 360;

const CATEGORY_ORDER: RelationCategory[] = [
  "investment",
  "supply",
  "competition",
  "partnership",
  "other",
];

const CATEGORY_META: Record<
  RelationCategory,
  { angle: number; spread: number }
> = {
  investment: { angle: 150, spread: 60 },
  supply: { angle: 270, spread: 60 },
  competition: { angle: 210, spread: 50 },
  partnership: { angle: 90, spread: 50 },
  other: { angle: 330, spread: 50 },
};

export interface Position {
  x: number;
  y: number;
  angle: number;
}

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelInfo {
  text: string;
  fullName: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  box: Rect;
  /** False when every candidate collided with another label. */
  visible: boolean;
}

export interface ClusterInfo {
  id: string;
  count: number;
  label: string;
}

export interface GraphLayoutResult {
  positions: Map<string, Position>;
  nodes: CompanySummary[];
  nodeCategories: Map<string, RelationCategory>;
  counts: Record<RelationCategory, number>;
  labels: Map<string, LabelInfo>;
  cluster: ClusterInfo | null;
  collapsedCount: number;
  totalDirect: number;
  collapsible: boolean;
  dense: boolean;
  view: ViewBox;
}

interface DirectCandidate {
  id: string;
  node: CompanySummary;
  category: RelationCategory;
  amount: number;
  percent: number;
  institutional: boolean;
}

export function emptyGraphLayout(): GraphLayoutResult {
  return {
    positions: new Map(),
    nodes: [],
    nodeCategories: new Map(),
    counts: {
      investment: 0,
      supply: 0,
      competition: 0,
      partnership: 0,
      other: 0,
    },
    labels: new Map(),
    cluster: null,
    collapsedCount: 0,
    totalDirect: 0,
    collapsible: false,
    dense: false,
    view: { x: 0, y: 0, w: 960, h: 720 },
  };
}

export function isOwnershipEdge(edge: RelationView): boolean {
  return DENSE_OWNERSHIP_SOURCES.has(edge.extractorVersion ?? "");
}

function categoryPriority(category: RelationCategory): number {
  return CATEGORY_ORDER.indexOf(category);
}

function metadataPercent(edge: RelationView): number {
  const value = edge.metadata?.percent;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 13F reports USD; HKEX DION reports a long-position percentage. */
function candidateMagnitude(candidate: DirectCandidate): number {
  if (candidate.amount > 0) return candidate.amount;
  return candidate.percent;
}

function compareByMagnitude(
  left: DirectCandidate,
  right: DirectCandidate,
): number {
  return (
    candidateMagnitude(right) - candidateMagnitude(left) ||
    (left.node.displayName ?? "").localeCompare(right.node.displayName ?? "")
  );
}

function compareCandidates(
  left: DirectCandidate,
  right: DirectCandidate,
): number {
  return (
    categoryPriority(left.category) - categoryPriority(right.category) ||
    compareByMagnitude(left, right)
  );
}

function shouldShowLabelOnTop(candidate: DirectCandidate): boolean {
  return candidate.institutional;
}

function setPolarPosition(
  positions: Map<string, Position>,
  id: string,
  radius: number,
  angle: number,
): void {
  const radians = (angle * Math.PI) / 180;
  positions.set(id, {
    x: CENTER_X + radius * Math.cos(radians),
    y: CENTER_Y - radius * Math.sin(radians),
    angle,
  });
}

interface GroupSplit {
  category: RelationCategory;
  inner: DirectCandidate[];
  outer: DirectCandidate[];
}

/**
 * Split each family over two rings. Within a family the largest holdings stay
 * on the inner ring; the rest move out. Small families stay on one ring.
 */
function splitGroups(candidates: DirectCandidate[]): GroupSplit[] {
  const groups = new Map<RelationCategory, DirectCandidate[]>();
  for (const candidate of candidates) {
    groups.set(candidate.category, [
      ...(groups.get(candidate.category) ?? []),
      candidate,
    ]);
  }
  return CATEGORY_ORDER.filter((category) => groups.has(category)).map(
    (category) => {
      const sorted = [...(groups.get(category) ?? [])].sort(compareCandidates);
      const innerCount =
        sorted.length <= 2 ? sorted.length : Math.ceil(sorted.length / 2);
      const inner = sorted.slice(0, innerCount);
      const outer = sorted.slice(innerCount);
      return {
        category,
        inner,
        outer,
      };
    },
  );
}

function placeTwoRings(
  candidates: DirectCandidate[],
  positions: Map<string, Position>,
): void {
  const groups = splitGroups(candidates);
  const totalSlots = groups.reduce(
    (sum, group) => sum + group.inner.length + group.outer.length,
    0,
  );
  let cursor = START_ANGLE;
  for (const group of groups) {
    const slots = group.inner.length + group.outer.length;
    const arc = (360 * slots) / Math.max(totalSlots, 1);
    const step = arc / Math.max(slots, 1);
    /**
     * Interleave inner and outer nodes instead of giving both rings the same
     * angles. Otherwise an outer holder's edge to the centre runs straight
     * through the inner node at the same angle, which reads as if the two
     * companies were connected. Each node now gets its own angle; edges to the
     * outer ring pass between the inner nodes.
     */
    let slot = 0;
    for (let index = 0; index < Math.max(group.inner.length, group.outer.length); index += 1) {
      const inner = group.inner[index];
      if (inner) {
        setPolarPosition(positions, inner.id, INNER_RADIUS, cursor + step * (slot + 0.5));
        slot += 1;
      }
      const outer = group.outer[index];
      if (outer) {
        setPolarPosition(positions, outer.id, OUTER_RADIUS, cursor + step * (slot + 0.5));
        slot += 1;
      }
    }
    cursor += arc;
  }
}

function placeSingleRing(
  candidates: DirectCandidate[],
  positions: Map<string, Position>,
): void {
  const radius =
    candidates.length <= 4
      ? SINGLE_RADIUS_SMALL
      : candidates.length <= 6
        ? SINGLE_RADIUS_MEDIUM
        : SINGLE_RADIUS_LARGE;
  candidates.forEach((candidate, index) => {
    const angle = START_ANGLE + (360 * index) / Math.max(candidates.length, 1);
    setPolarPosition(positions, candidate.id, radius, angle);
  });
}

/**
 * Place the collapsed cluster near the last named holder without stacking it
 * on top of a node or running its edge through another node. Falls back to the
 * preferred angle if the ring is unusually crowded.
 */
function findClusterAngle(
  positions: Map<string, Position>,
  preferredAngle: number,
  radius: number,
): number {
  const minDistance = NODE_RADIUS * 2 + CLUSTER_RADIUS + 8;
  const offsets = [0];
  for (let offset = 6; offset <= 180; offset += 6) {
    offsets.push(offset, -offset);
  }
  for (const offset of offsets) {
    const angle = preferredAngle + offset;
    const radians = (angle * Math.PI) / 180;
    const x = CENTER_X + radius * Math.cos(radians);
    const y = CENTER_Y - radius * Math.sin(radians);
    const clear = [...positions.values()].every((position) => {
      // Ignore the centre itself: every candidate edge starts there.
      if (
        Math.abs(position.x - CENTER_X) < 0.5 &&
        Math.abs(position.y - CENTER_Y) < 0.5
      ) {
        return true;
      }
      const endpointGap = Math.hypot(position.x - x, position.y - y);
      if (endpointGap < minDistance) return false;
      // Edges to the outer ring must pass between nodes, not through them.
      return (
        distanceToSegment(
          position,
          { x: CENTER_X, y: CENTER_Y },
          { x, y },
        ) >=
        NODE_RADIUS + 6
      );
    });
    if (clear) return angle;
  }
  return preferredAngle;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + t * dx),
    point.y - (start.y + t * dy),
  );
}

export function defaultView(nodeCount: number): ViewBox {
  return nodeCount <= 6
    ? { x: 80, y: -20, w: 800, h: 640 }
    : { x: 0, y: 0, w: 960, h: 720 };
}

/**
 * Rough width of an 11px bold label in SVG units. Uppercase institutional
 * names are much wider than lowercase names, so a single per-character
 * constant underestimates labels like "MORGAN STANLEY" and lets them overlap.
 * The trailing 6px reserves the stroke halo on both sides.
 */
export function estimateTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/[⺀-鿿＀-￯]/.test(char)) width += 12;
    else if (/[A-Z0-9]/.test(char)) width += 8.2;
    else if (/[a-z]/.test(char)) width += 6.3;
    else if (char === " ") width += 3.6;
    else width += 7;
  }
  return width + 6;
}

function overlaps(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.w &&
    left.x + left.w > right.x &&
    left.y < right.y + right.h &&
    left.y + left.h > right.y
  );
}

function circleBox(x: number, y: number, radius: number, pad = 0): Rect {
  return {
    x: x - radius - pad,
    y: y - radius - pad,
    w: (radius + pad) * 2,
    h: (radius + pad) * 2,
  };
}

interface LabelCandidate {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  box: Rect;
}

function labelCandidates(
  position: Position,
  radius: number,
  text: string,
): LabelCandidate[] {
  const width = estimateTextWidth(text);
  const below = {
    text,
    x: position.x,
    y: position.y + radius + 15,
    anchor: "middle" as const,
    box: {
      x: position.x - width / 2,
      y: position.y + radius + 3,
      w: width,
      h: 20,
    },
  };
  const above = {
    text,
    x: position.x,
    y: position.y - radius - 6,
    anchor: "middle" as const,
    box: {
      x: position.x - width / 2,
      y: position.y - radius - 19,
      w: width,
      h: 20,
    },
  };
  const right = {
    text,
    x: position.x + radius + 5,
    y: position.y + 4,
    anchor: "start" as const,
    box: {
      x: position.x + radius + 5,
      y: position.y - 12,
      w: width,
      h: 20,
    },
  };
  const left = {
    text,
    x: position.x - radius - 5,
    y: position.y + 4,
    anchor: "end" as const,
    box: {
      x: position.x - radius - 5 - width,
      y: position.y - 12,
      w: width,
      h: 20,
    },
  };
  return [below, above, right, left];
}

interface LabelNode {
  id: string;
  text: string;
  fullName: string;
  position: Position;
  radius: number;
}

function buildLabels(
  center: CompanySummary,
  nodeList: LabelNode[],
  allCircles: Array<{ x: number; y: number; radius: number; id: string }>,
): Map<string, LabelInfo> {
  const labels = new Map<string, LabelInfo>();
  const placed: Rect[] = [];

  const centerName = truncate(center.displayName, 18);
  const centerNameWidth = estimateTextWidth(centerName);
  const hardBoxes: Rect[] = [
    circleBox(CENTER_X, CENTER_Y, CENTER_RADIUS, 8),
    {
      x: CENTER_X - centerNameWidth / 2 - 6,
      y: CENTER_Y + CENTER_RADIUS + 4,
      w: centerNameWidth + 12,
      h: 22,
    },
  ];

  for (const node of nodeList) {
    const circles = allCircles
      .filter((circle) => circle.id !== node.id)
      .map((circle) => circleBox(circle.x, circle.y, circle.radius, 3));
    const candidates = labelCandidates(node.position, node.radius, node.text);
    let fallback: LabelCandidate | null = null;
    let chosen: LabelCandidate | null = null;
    for (const candidate of candidates) {
      if (
        hardBoxes.some((box) => overlaps(candidate.box, box)) ||
        circles.some((box) => overlaps(candidate.box, box))
      ) {
        continue;
      }
      if (!fallback) fallback = candidate;
      if (!placed.some((box) => overlaps(candidate.box, box))) {
        chosen = candidate;
        break;
      }
    }
    const label = chosen ?? fallback;
    if (!label) continue;
    if (chosen) placed.push(chosen.box);
    labels.set(node.id, {
      text: label.text,
      fullName: node.fullName,
      x: label.x,
      y: label.y,
      anchor: label.anchor,
      box: label.box,
      visible: Boolean(chosen),
    });
  }
  return labels;
}

export interface BuildGraphLayoutOptions {
  expanded: boolean;
  /** Language-specific label for the collapsed "other holders" node. */
  clusterLabel: string;
}

export function buildGraphLayout(
  graph: CompanyGraphView,
  edges: RelationView[],
  options: BuildGraphLayoutOptions,
): GraphLayoutResult {
  const centerId = graph.center.id;
  const nodeMap = new Map<string, CompanySummary>();
  nodeMap.set(centerId, graph.center);

  const direct = new Map<string, DirectCandidate>();
  for (const edge of edges) {
    nodeMap.set(edge.src.id, edge.src);
    nodeMap.set(edge.dst.id, edge.dst);
    if (edge.src.id !== centerId && edge.dst.id !== centerId) continue;
    const other = edge.src.id === centerId ? edge.dst.id : edge.src.id;
    const node = edge.src.id === centerId ? edge.dst : edge.src;
    if (!other || !node) continue;
    const category = relationCategory(edge.type);
    const previous = direct.get(other);
    const candidate: DirectCandidate = previous ?? {
      id: other,
      node,
      category,
      amount: 0,
      percent: 0,
      institutional: false,
    };
    if (categoryPriority(category) < categoryPriority(candidate.category)) {
      candidate.category = category;
    }
    candidate.amount = Math.max(
      candidate.amount,
      Number.isFinite(edge.amount) ? (edge.amount ?? 0) : 0,
    );
    candidate.percent = Math.max(candidate.percent, metadataPercent(edge));
    candidate.institutional =
      candidate.institutional || isOwnershipEdge(edge);
    direct.set(other, candidate);
  }

  const candidates = [...direct.values()];
  const institutional = candidates.filter(
    (candidate) => candidate.institutional,
  );
  const nonInstitutional = candidates.filter(
    (candidate) => !candidate.institutional,
  );
  const collapsible = institutional.length > COLLAPSE_THRESHOLD;

  let visible: DirectCandidate[];
  let collapsed: DirectCandidate[] = [];
  if (!options.expanded && collapsible) {
    const ranked = [...institutional].sort(compareByMagnitude);
    visible = [...nonInstitutional, ...ranked.slice(0, TOP_HOLDER_LIMIT)];
    collapsed = ranked.slice(TOP_HOLDER_LIMIT);
  } else {
    visible = [...candidates];
  }
  visible.sort(compareCandidates);

  const cluster: ClusterInfo | null = collapsed.length
    ? {
        id: CLUSTER_ID,
        count: collapsed.length,
        label: options.clusterLabel,
      }
    : null;

  const positions = new Map<string, Position>();
  positions.set(centerId, { x: CENTER_X, y: CENTER_Y, angle: 0 });

  const dense = visible.length > 8;
  if (dense) {
    placeTwoRings(visible, positions);
  } else {
    placeSingleRing(visible, positions);
  }

  // The "other holders" node sits at the end of the investment family. In the
  // two-ring layout it lands on the outer ring, after the named holders.
  if (cluster) {
    const lastInvestment = [...visible]
      .reverse()
      .find((candidate) => candidate.category === "investment");
    const anchorAngle = lastInvestment
      ? (positions.get(lastInvestment.id)?.angle ?? START_ANGLE)
      : START_ANGLE;
    const clusterRadius = dense ? OUTER_RADIUS : 240;
    const angle = findClusterAngle(
      positions,
      anchorAngle + 18,
      clusterRadius,
    );
    setPolarPosition(positions, cluster.id, clusterRadius, angle);
  }

  const nodeCategories = new Map<string, RelationCategory>();
  for (const candidate of visible) {
    nodeCategories.set(candidate.id, candidate.category);
  }
  if (cluster) nodeCategories.set(cluster.id, "investment");

  // Second ring (depth 2), grouped by parent as before. Collapsed holders are
  // still direct neighbours of the centre; they must not reappear as ring-two
  // nodes.
  const allDirectIds = new Set(candidates.map((candidate) => candidate.id));
  const directIds = new Set(visible.map((candidate) => candidate.id));
  const secondRing = [...nodeMap.keys()].filter(
    (id) => id !== centerId && !allDirectIds.has(id),
  );
  const secondByParent = new Map<string, string[]>();
  const secondWithoutParent: string[] = [];
  for (const id of secondRing) {
    const parentEdge = edges.find(
      (edge) =>
        (directIds.has(edge.src.id) && edge.dst.id === id) ||
        (directIds.has(edge.dst.id) && edge.src.id === id),
    );
    const parentId = parentEdge
      ? directIds.has(parentEdge.src.id)
        ? parentEdge.src.id
        : parentEdge.dst.id
      : null;
    if (parentId) {
      secondByParent.set(parentId, [
        ...(secondByParent.get(parentId) ?? []),
        id,
      ]);
    } else {
      secondWithoutParent.push(id);
    }
  }

  const secondRadius = dense ? DENSE_SECOND_RADIUS : SECOND_RADIUS;
  for (const [parentId, ids] of secondByParent) {
    const parent = positions.get(parentId);
    if (!parent) continue;
    ids.forEach((id, index) => {
      const offset =
        ids.length === 1
          ? 0
          : (index - (ids.length - 1) / 2) *
            (Math.min(40, ids.length * 14) / Math.max(ids.length - 1, 1));
      setPolarPosition(positions, id, secondRadius, parent.angle + offset);
      const category = relationCategory(
        edges.find(
          (edge) =>
            (edge.src.id === parentId && edge.dst.id === id) ||
            (edge.dst.id === parentId && edge.src.id === id),
        )?.type ?? "other",
      );
      if (!nodeCategories.has(id)) nodeCategories.set(id, category);
    });
  }

  secondWithoutParent.forEach((id, index) => {
    const meta = CATEGORY_META.other;
    const angle =
      meta.angle + (index - (secondWithoutParent.length - 1) / 2) * 18;
    setPolarPosition(positions, id, secondRadius, angle);
    if (!nodeCategories.has(id)) nodeCategories.set(id, "other");
  });

  const counts: Record<RelationCategory, number> = {
    investment: 0,
    supply: 0,
    competition: 0,
    partnership: 0,
    other: 0,
  };
  for (const edge of edges) counts[relationCategory(edge.type)] += 1;

  const visibleNodes = visible.map((candidate) => candidate.node);
  const nodes = [
    graph.center,
    ...visibleNodes,
    ...secondRing
      .map((id) => nodeMap.get(id))
      .filter((node): node is CompanySummary => Boolean(node)),
  ];

  const circles = nodes.map((node) => ({
    id: node.id,
    x: positions.get(node.id)?.x ?? CENTER_X,
    y: positions.get(node.id)?.y ?? CENTER_Y,
    radius: node.id === centerId ? CENTER_RADIUS : NODE_RADIUS,
  }));
  if (cluster) {
    const clusterPosition = positions.get(cluster.id);
    if (clusterPosition) {
      circles.push({
        id: cluster.id,
        x: clusterPosition.x,
        y: clusterPosition.y,
        radius: CLUSTER_RADIUS,
      });
    }
  }

  // Labels are placed in priority order: direct holders first (largest first),
  // then the cluster, then second-ring nodes.
  const labelNodes: LabelNode[] = [];
  for (const candidate of visible) {
    const position = positions.get(candidate.id);
    if (!position) continue;
    labelNodes.push({
      id: candidate.id,
      text: truncate(candidate.node.displayName, 14),
      fullName: candidate.node.displayName,
      position,
      radius: NODE_RADIUS,
    });
  }
  if (cluster) {
    const position = positions.get(cluster.id);
    if (position) {
      labelNodes.push({
        id: cluster.id,
        text: truncate(cluster.label, 14),
        fullName: `${cluster.label} (${cluster.count})`,
        position,
        radius: CLUSTER_RADIUS,
      });
    }
  }
  for (const id of secondRing) {
    const node = nodeMap.get(id);
    const position = positions.get(id);
    if (!node || !position) continue;
    labelNodes.push({
      id,
      text: truncate(node.displayName, 14),
      fullName: node.displayName,
      position,
      radius: NODE_RADIUS,
    });
  }

  // Largest holders deserve the label first, but the cluster must always be
  // identifiable: it is the only affordance for the hidden majority.
  labelNodes.sort((left, right) => {
    const leftCluster = left.id === cluster?.id;
    const rightCluster = right.id === cluster?.id;
    if (leftCluster !== rightCluster) return leftCluster ? -1 : 1;
    const leftCandidate = direct.get(left.id);
    const rightCandidate = direct.get(right.id);
    if (leftCandidate && rightCandidate) {
      return (
        Number(shouldShowLabelOnTop(rightCandidate)) -
          Number(shouldShowLabelOnTop(leftCandidate)) ||
        compareCandidates(leftCandidate, rightCandidate)
      );
    }
    if (leftCandidate) return -1;
    if (rightCandidate) return 1;
    return 0;
  });

  const labels = buildLabels(graph.center, labelNodes, circles);

  const nodeCount = directIds.size + (cluster ? 1 : 0) + secondRing.length;
  const view = dense
    ? { x: 0, y: -40, w: 960, h: 800 }
    : defaultView(nodeCount + 1);

  return {
    positions,
    nodes,
    nodeCategories,
    counts,
    labels,
    cluster,
    collapsedCount: collapsed.length,
    totalDirect: candidates.length,
    collapsible,
    dense,
    view,
  };
}
