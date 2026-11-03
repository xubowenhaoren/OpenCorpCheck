import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type {
  CompanyGraphView,
  CompanySummary,
  RelationView,
} from "@occ/core";

import { getGraph } from "../api";
import { useAgent } from "../contexts/AgentContext";
import { useSource } from "../contexts/SourceContext";
import {
  categoryLabel,
  relationBadgeLabel,
  relationCategory,
  relationMagnitudeLabel,
  relationSourceLabel,
  relationTypeLabel,
  statusLabel,
  truncate,
  type RelationCategory,
} from "../format";
import {
  buildGraphLayout,
  CLUSTER_RADIUS,
  emptyGraphLayout,
  isOwnershipEdge,
  NODE_RADIUS,
  CENTER_RADIUS,
  TOP_HOLDER_LIMIT,
  type ClusterInfo,
  type LabelInfo,
  type Position,
} from "../lib/graph-layout";
import { useLang, type Lang } from "../i18n";
import { EmptyState, ErrorView, Loading } from "./States";

const CATEGORY_ORDER: RelationCategory[] = [
  "investment",
  "supply",
  "competition",
  "partnership",
  "other",
];

const CATEGORY_CLASS: Record<RelationCategory, string> = {
  investment: "invest",
  supply: "supplier",
  competition: "competitor",
  partnership: "partner",
  other: "other",
};

const DIRECTIONAL_TYPES = new Set([
  "invests_in",
  "owns",
  "parent_of",
  "supplies",
  "buys_from",
  "licenses_to",
  "licenses_from",
]);

function directional(edge: RelationView): boolean {
  return DIRECTIONAL_TYPES.has(edge.type);
}

function classFor(type: string): string {
  return CATEGORY_CLASS[relationCategory(type)];
}

function edgeMagnitude(edge: RelationView): number {
  if (
    typeof edge.amount === "number" &&
    Number.isFinite(edge.amount) &&
    edge.amount > 0
  ) {
    return edge.amount;
  }
  const percent = Number(edge.metadata?.percent);
  return Number.isFinite(percent) ? percent : 0;
}

export function CompanyGraph({
  companyRef,
  companyName,
  companySlug,
}: {
  companyRef: string;
  companyName: string;
  companySlug: string;
}) {
  const { t, lang } = useLang();
  const { openAgent } = useAgent();
  const { openSource } = useSource();
  const [depth, setDepth] = useState<1 | 2>(1);
  const [status, setStatus] = useState<
    "all" | "verified" | "inferred" | "reported"
  >("all");
  const [typeFilter, setTypeFilter] = useState<"all" | RelationCategory>("all");
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"graph" | "list">(() =>
    window.matchMedia("(max-width: 720px)").matches ? "list" : "graph",
  );
  const [selected, setSelected] = useState<{
    type: "center" | "node" | "edge";
    id: string;
  }>({ type: "center", id: "" });
  const [view, setView] = useState({ x: 0, y: 0, w: 960, h: 720 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["graph", companySlug || companyRef, depth, status],
    queryFn: () =>
      getGraph({
        company: companySlug || companyRef,
        depth,
        status: status === "all" ? undefined : status,
        limit: 300,
      }),
    enabled: Boolean(companySlug || companyRef),
    staleTime: 30_000,
  });

  const graph = data?.data;
  const allEdges = (graph?.edges ?? []).filter(
    (edge) => edge.status !== "rejected",
  );
  const edges = useMemo(
    () =>
      allEdges.filter(
        (edge) =>
          typeFilter === "all" ||
          relationCategory(edge.type) === typeFilter,
      ),
    [allEdges, typeFilter],
  );
  const layout = useMemo(
    () =>
      graph
        ? buildGraphLayout(graph, edges, {
            expanded,
            clusterLabel: t("graph.otherHolders"),
          })
        : emptyGraphLayout(),
    [graph, edges, expanded, t],
  );

  useEffect(() => {
    if (!graph) return;
    setSelected({ type: "center", id: graph.center.id });
  }, [graph?.center.id, depth, status, typeFilter]);

  useEffect(() => {
    if (!graph) return;
    setExpanded(false);
  }, [graph?.center.id, depth, status, typeFilter]);

  useEffect(() => {
    if (!graph) return;
    setView(layout.view);
  }, [graph?.center.id, layout.view]);

  useEffect(() => {
    if (!graph) return;
    if (selected.type === "center") return;
    const exists =
      layout.nodes.some((node) => node.id === selected.id) ||
      edges.some((edge) => edge.id === selected.id);
    if (!exists) setSelected({ type: "center", id: graph.center.id });
  }, [edges, layout.nodes, selected, graph]);

  function openAllRelations() {
    setExpanded(true);
    window.requestAnimationFrame(() => {
      document
        .getElementById("relation-lists")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const selectedNode =
    selected.type === "center"
      ? graph?.center
      : layout.nodes.find((node) => node.id === selected.id);
  const selectedEdge =
    selected.type === "edge"
      ? edges.find((edge) => edge.id === selected.id)
      : undefined;

  function edgeState(edge: RelationView): {
    dimmed: boolean;
    highlighted: boolean;
  } {
    if (selected.type === "edge") {
      const active = selected.id === edge.id;
      return { dimmed: !active, highlighted: active };
    }
    if (selected.type === "node") {
      const active =
        edge.src.id === selected.id || edge.dst.id === selected.id;
      return { dimmed: !active, highlighted: active };
    }
    return { dimmed: false, highlighted: false };
  }

  function selectCenter() {
    if (graph) setSelected({ type: "center", id: graph.center.id });
  }

  function zoom(factor: number) {
    setView((current) => {
      const cx = current.x + current.w / 2;
      const cy = current.y + current.h / 2;
      const width = Math.max(480, Math.min(1400, current.w * factor));
      const height = width * (current.h / current.w);
      return {
        x: cx - width / 2,
        y: cy - height / 2,
        w: width,
        h: height,
      };
    });
  }

  function resetView() {
    setView(layout.view);
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "mouse") return;
    const target = event.target as Element;
    if (target.closest(".node") || target.closest(".edge-hit")) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      vx: view.x,
      vy: view.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    const element = svgRef.current;
    if (!drag || !element) return;
    const rect = element.getBoundingClientRect();
    const dx = ((event.clientX - drag.x) * view.w) / rect.width;
    const dy = ((event.clientY - drag.y) * view.h) / rect.height;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    setView((current) => ({
      ...current,
      x: drag.vx - dx,
      y: drag.vy - dy,
    }));
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointer already released
    }
    if (drag && !drag.moved) selectCenter();
  }

  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <ErrorView
        message={error instanceof Error ? error.message : String(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!graph) return <Loading />;

  const empty = allEdges.length === 0;
  const filteredEmpty = !empty && edges.length === 0;

  return (
    <div className="card graph-card">
      <div className="graph-toolbar">
        <div className="chips" role="group" aria-label={t("graph.title")}>
          <button
            type="button"
            className={`chip${typeFilter === "all" ? " active" : ""}`}
            onClick={() => setTypeFilter("all")}
          >
            {t("graph.all")}
          </button>
          {CATEGORY_ORDER.map((category) => (
            <button
              type="button"
              key={category}
              className={`chip${typeFilter === category ? " active" : ""}`}
              onClick={() => setTypeFilter(category)}
            >
              {categoryLabel(category, lang)}
            </button>
          ))}
        </div>
        <div className="graph-tools">
          {layout.collapsible ? (
            <button
              type="button"
              className={`chip${expanded ? " active" : ""}`}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded
                ? t("graph.showTop", { count: TOP_HOLDER_LIMIT })
                : t("graph.showAll", { count: layout.totalDirect })}
            </button>
          ) : null}
          <label className="switch">
            <input
              type="checkbox"
              checked={status === "verified"}
              onChange={(event) =>
                setStatus(event.target.checked ? "verified" : "all")
              }
            />
            {t("graph.verifiedOnly")}
          </label>
          <div className="segmented" role="group" aria-label="depth">
            <button
              type="button"
              className={depth === 1 ? "active" : ""}
              onClick={() => setDepth(1)}
            >
              {t("graph.depth1")}
            </button>
            <button
              type="button"
              className={depth === 2 ? "active" : ""}
              onClick={() => setDepth(2)}
            >
              {t("graph.depth2")}
            </button>
          </div>
          <div className="segmented" role="group" aria-label="view">
            <button
              type="button"
              className={viewMode === "graph" ? "active" : ""}
              onClick={() => setViewMode("graph")}
            >
              {t("graph.graphView")}
            </button>
            <button
              type="button"
              className={viewMode === "list" ? "active" : ""}
              onClick={() => setViewMode("list")}
            >
              {t("graph.listView")}
            </button>
          </div>
          <div className="zoom-group" aria-label="zoom">
            <button
              type="button"
              className="icon-btn"
              onClick={() => zoom(0.8)}
              aria-label="zoom in"
            >
              ＋
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => zoom(1.25)}
              aria-label="zoom out"
            >
              －
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={resetView}
              aria-label="reset zoom"
            >
              ⟲
            </button>
          </div>
        </div>
      </div>

      {empty ? (
        <EmptyState title={t("graph.empty")} hint={t("graph.emptyHint")}>
          <div className="head-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() =>
                openAgent(
                  { ref: companySlug, name: companyName },
                  lang === "zh"
                    ? `查一下 ${companyName} 和哪些公司有投资、供应、竞争或合作关系`
                    : `Find the investment, supply, competition and partnership relationships of ${companyName}`,
                )
              }
            >
              {t("graph.askAgent")}
            </button>
            <Link
              className="btn secondary"
              to={`/c/${encodeURIComponent(companySlug)}/news`}
            >
              {t("graph.viewNews")}
            </Link>
          </div>
        </EmptyState>
      ) : filteredEmpty ? (
        <EmptyState title={t("graph.empty")} hint={t("graph.emptyHint")}>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setTypeFilter("all")}
          >
            {t("graph.all")}
          </button>
        </EmptyState>
      ) : (
        <>
          {viewMode === "graph" ? (
            <>
              <div className="graph-layout">
                <div className="graph-stage">
                <svg
                  id="graph"
                  ref={svgRef}
                  viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                  role="img"
                  aria-label={t("graph.title")}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => {
                    dragRef.current = null;
                  }}
                >
                  <defs>
                    {[
                      "invest",
                      "supplier",
                      "competitor",
                      "partner",
                      "other",
                    ].map((cls) => (
                      <marker
                        key={cls}
                        id={`arrow-${cls}`}
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L10,5 L0,10 z" />
                      </marker>
                    ))}
                  </defs>
                  <g>
                    {layout.cluster ? (
                      <ClusterEdge
                        cluster={layout.cluster}
                        positions={layout.positions}
                        centerId={graph.center.id}
                        onOpen={openAllRelations}
                      />
                    ) : null}
                    {edges.map((edge) => {
                      const state = edgeState(edge);
                      return (
                        <GraphEdge
                          key={edge.id}
                          edge={edge}
                          positions={layout.positions}
                          centerId={graph.center.id}
                          selected={
                            selected.type === "edge" && selected.id === edge.id
                          }
                          dimmed={state.dimmed}
                          highlighted={state.highlighted}
                          lang={lang}
                          onSelect={() =>
                            setSelected({ type: "edge", id: edge.id })
                          }
                        />
                      );
                    })}
                  </g>
                  <g>
                    {layout.nodes.map((node) => {
                      const position = layout.positions.get(node.id);
                      if (!position) return null;
                      const isCenter = node.id === graph.center.id;
                      const category =
                        layout.nodeCategories.get(node.id) ?? "other";
                      return (
                        <GraphNode
                          key={node.id}
                          node={node}
                          position={position}
                          isCenter={isCenter}
                          category={category}
                          label={layout.labels.get(node.id)}
                          selected={
                            selected.id === node.id &&
                            (selected.type === "node" ||
                              selected.type === "center")
                          }
                          onSelect={() =>
                            setSelected({
                              type: isCenter ? "center" : "node",
                              id: node.id,
                            })
                          }
                        />
                      );
                    })}
                    {layout.cluster ? (
                      <ClusterNode
                        cluster={layout.cluster}
                        position={layout.positions.get(layout.cluster.id)}
                        label={layout.labels.get(layout.cluster.id)}
                        lang={lang}
                        onOpen={openAllRelations}
                      />
                    ) : null}
                  </g>
                </svg>
                <div className="graph-hint">
                  {lang === "zh" ? "拖动查看 · ＋/－ 缩放" : "Drag · zoom with ＋/－"}
                </div>
              </div>
              <GraphInspector
                graph={graph}
                selected={selected}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                counts={layout.counts}
                edges={edges}
                collapsedCount={layout.collapsedCount}
                totalDirect={layout.totalDirect}
                expanded={expanded}
                onExpand={openAllRelations}
                lang={lang}
                onOpenSource={openSource}
              />
              </div>
              <div className="graph-legend" aria-hidden="true">
              {CATEGORY_ORDER.map((category) => (
                <span className="legend-item" key={category}>
                  <span
                    className={`legend-line cat-${CATEGORY_CLASS[category]}`}
                  />
                  {categoryLabel(category, lang)}
                </span>
              ))}
              <span className="legend-item">
                <span className="legend-line" />
                {t("status.verified")}
              </span>
              <span className="legend-item">
                <span className="legend-line dashed" />
                {t("status.inferred")}
              </span>
              <span className="legend-item">
                <span className="legend-line dotted" />
                {t("status.reported")}
              </span>
              </div>
            </>
          ) : null}

          <RelationList
            edges={edges}
            centerId={graph.center.id}
            selected={selected}
            lang={lang}
            onSelect={(id) => setSelected({ type: "edge", id })}
            onOpenSource={openSource}
          />
          {graph.truncated ? (
            <p className="hint">
              {t("graph.truncated", { count: edges.length })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function GraphNode({
  node,
  position,
  isCenter,
  category,
  label,
  selected,
  onSelect,
}: {
  node: CompanySummary;
  position: Position;
  isCenter: boolean;
  category: RelationCategory;
  label: LabelInfo | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const ticker = node.tickers[0]?.ticker;
  const className = [
    "node",
    isCenter ? "center" : `cat-${CATEGORY_CLASS[category]}`,
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const radius = isCenter ? CENTER_RADIUS : NODE_RADIUS;
  const showLabel = label && (label.visible || selected);
  return (
    <g
      className={className}
      transform={`translate(${position.x},${position.y})`}
      tabIndex={0}
      role="button"
      aria-label={node.displayName}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <circle r={radius} />
      <title>
        {node.displayName}
        {ticker ? ` · ${ticker}` : ""}
      </title>
      {isCenter ? (
        <>
          <text className="center-name" y="5" textAnchor="middle">
            {truncate(ticker ?? "OCC", 6)}
          </text>
          <text
            className="node-label center-label"
            y={radius + 18}
            textAnchor="middle"
          >
            {truncate(node.displayName, 18)}
          </text>
        </>
      ) : showLabel ? (
        <text
          className={`node-label${selected ? " selected-label" : ""}`}
          x={label.x - position.x}
          y={label.y - position.y}
          textAnchor={label.anchor}
          data-visible={label.visible ? "true" : "false"}
        >
          {label.text}
        </text>
      ) : null}
    </g>
  );
}

function ClusterNode({
  cluster,
  position,
  label,
  lang,
  onOpen,
}: {
  cluster: ClusterInfo;
  position: Position | undefined;
  label: LabelInfo | undefined;
  lang: Lang;
  onOpen: () => void;
}) {
  if (!position) return null;
  const title =
    lang === "zh"
      ? `${cluster.label}（${cluster.count} 家）· 点击查看完整列表`
      : `${cluster.label} (${cluster.count}) · click to open the full list`;
  return (
    <g
      className="node cluster"
      transform={`translate(${position.x},${position.y})`}
      tabIndex={0}
      role="button"
      aria-label={title}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <circle r={CLUSTER_RADIUS} />
      <text className="cluster-count" y="4" textAnchor="middle">
        +{cluster.count}
      </text>
      <title>{title}</title>
      {label?.visible ? (
        <text
          className="node-label"
          x={label.x - position.x}
          y={label.y - position.y}
          textAnchor={label.anchor}
        >
          {label.text}
        </text>
      ) : null}
    </g>
  );
}

function ClusterEdge({
  cluster,
  positions,
  centerId,
  onOpen,
}: {
  cluster: ClusterInfo;
  positions: Map<string, Position>;
  centerId: string;
  onOpen: () => void;
}) {
  const from = positions.get(centerId);
  const to = positions.get(cluster.id);
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const x1 = from.x + ux * (CENTER_RADIUS + 2);
  const y1 = from.y + uy * (CENTER_RADIUS + 2);
  const x2 = to.x - ux * (CLUSTER_RADIUS + 2);
  const y2 = to.y - uy * (CLUSTER_RADIUS + 2);
  return (
    <g className="edge-group cluster-edge-group">
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className="edge is-cluster"
      />
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className="edge-hit"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      />
    </g>
  );
}

function GraphEdge({
  edge,
  positions,
  centerId,
  selected,
  dimmed,
  highlighted,
  lang,
  onSelect,
}: {
  edge: RelationView;
  positions: Map<string, Position>;
  centerId: string;
  selected: boolean;
  dimmed: boolean;
  highlighted: boolean;
  lang: Lang;
  onSelect: () => void;
}) {
  const from = positions.get(edge.src.id);
  const to = positions.get(edge.dst.id);
  if (!from || !to) return null;
  const fromCenter = edge.src.id === centerId;
  const toCenter = edge.dst.id === centerId;
  const fromRadius = fromCenter ? CENTER_RADIUS : NODE_RADIUS;
  const toRadius = toCenter ? CENTER_RADIUS : NODE_RADIUS;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const ownership = isOwnershipEdge(edge);
  // Filing holdings add dozens of parallel arrows; dropping the arrowheads
  // (and drawing the lines faintly) keeps the centre readable.
  const arrow = directional(edge) && !ownership;
  const pad = arrow ? 4 : 0;
  const x1 = from.x + ux * fromRadius;
  const y1 = from.y + uy * fromRadius;
  const x2 = to.x - ux * (toRadius + pad);
  const y2 = to.y - uy * (toRadius + pad);
  const cls = classFor(edge.type);
  const marker = arrow ? `url(#arrow-${cls})` : undefined;
  const className = [
    "edge",
    `cat-${cls}`,
    `is-${edge.status}`,
    ownership ? "is-ownership" : "",
    dimmed ? "is-dimmed" : "",
    highlighted ? "is-highlighted" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <g className={`edge-group${dimmed ? " is-dimmed" : ""}`}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className={className}
        markerEnd={marker}
      />
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className="edge-hit"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      />
      {selected ? (
        <text
          x={(x1 + x2) / 2}
          y={(y1 + y2) / 2 - 7}
          className="edge-label"
          textAnchor="middle"
        >
          {relationTypeLabel(edge.type, lang)}
        </text>
      ) : null}
    </g>
  );
}

function GraphInspector({
  graph,
  selected,
  selectedNode,
  selectedEdge,
  counts,
  edges,
  collapsedCount,
  totalDirect,
  expanded,
  onExpand,
  lang,
  onOpenSource,
}: {
  graph: CompanyGraphView;
  selected: { type: "center" | "node" | "edge"; id: string };
  selectedNode: CompanySummary | undefined;
  selectedEdge: RelationView | undefined;
  counts: Record<RelationCategory, number>;
  edges: RelationView[];
  collapsedCount: number;
  totalDirect: number;
  expanded: boolean;
  onExpand: () => void;
  lang: Lang;
  onOpenSource: ReturnType<typeof useSource>["openSource"];
}) {
  const { t } = useLang();
  const { openAgent } = useAgent();

  if (selected.type === "edge" && selectedEdge) {
    const evidence = selectedEdge.evidence[0];
    const evidenceUrl = evidence?.url;
    const magnitude = relationMagnitudeLabel(selectedEdge, lang);
    return (
      <aside className="card graph-inspector" aria-live="polite">
        <div className={`insp-cat cat-${classFor(selectedEdge.type)}`}>
          {categoryLabel(relationCategory(selectedEdge.type), lang)}
        </div>
        <h3>
          {selectedEdge.src.displayName} → {selectedEdge.dst.displayName}
        </h3>
        <div className="insp-sub">
          {relationTypeLabel(selectedEdge.type, lang)} ·{" "}
          {statusLabel(selectedEdge.status, lang)}
          {relationSourceLabel(selectedEdge.extractorVersion, lang)
            ? ` · ${relationSourceLabel(selectedEdge.extractorVersion, lang)}`
            : ""}
        </div>
        {magnitude ? (
          <div className="insp-magnitude">
            <span>{t("graph.amount")}</span>
            <strong>{magnitude}</strong>
          </div>
        ) : null}
        {evidence?.quote ? <blockquote>“{evidence.quote}”</blockquote> : null}
        {evidenceUrl ? (
          <div className="insp-source">
            <button
              type="button"
              className="src-btn"
              onClick={() =>
                onOpenSource({
                  url: evidenceUrl,
                  title: evidence?.title,
                  quote: evidence?.quote,
                  trustTier: evidence?.trustTier,
                  date: evidence?.publishedAt,
                })
              }
            >
              {t("graph.source")}
            </button>
            {evidence?.publishedAt ? (
              <span>{evidence.publishedAt.slice(0, 10)}</span>
            ) : null}
          </div>
        ) : (
          <p className="insp-hint">{t("company.noData")}</p>
        )}
        <div className="head-actions">
          {selectedEdge.src.slug ? (
            <Link
              className="btn secondary"
              to={`/c/${encodeURIComponent(selectedEdge.src.slug)}`}
            >
              {selectedEdge.src.displayName}
            </Link>
          ) : null}
          {selectedEdge.dst.slug ? (
            <Link
              className="btn secondary"
              to={`/c/${encodeURIComponent(selectedEdge.dst.slug)}`}
            >
              {selectedEdge.dst.displayName}
            </Link>
          ) : null}
        </div>
      </aside>
    );
  }

  if (selected.type === "center" || !selectedNode) {
    return (
      <aside className="card graph-inspector" aria-live="polite">
        <div className="insp-cat">{t("graph.center")}</div>
        <h3>{graph.center.displayName}</h3>
        <div className="insp-sub">
          {graph.center.tickers.map((ticker) => ticker.ticker).join(" · ")}
        </div>
        <div className="insp-counts">
          {CATEGORY_ORDER.map((category) => (
            <div className="insp-count" key={category}>
              <strong>{counts[category]}</strong>
              <span>{categoryLabel(category, lang)}</span>
            </div>
          ))}
        </div>
        {collapsedCount > 0 && !expanded ? (
          <div className="insp-note">
            <p className="insp-hint">
              {t("graph.collapsedHint", {
                count: TOP_HOLDER_LIMIT,
                hidden: collapsedCount,
              })}
            </p>
            <button type="button" className="link-button" onClick={onExpand}>
              {t("graph.showAll", { count: totalDirect })}
            </button>
          </div>
        ) : null}
        <p className="insp-hint">{t("graph.clickHint")}</p>
        {counts.investment === 0 ? (
          <div className="insp-note">
            <p className="insp-hint">
              {lang === "zh"
                ? "暂无投资 / 股权关系数据。"
                : "No investment or ownership data yet."}
            </p>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                openAgent(
                  {
                    ref: graph.center.slug,
                    name: graph.center.displayName,
                    ticker: graph.center.tickers[0]?.ticker,
                  },
                  lang === "zh"
                    ? `查一下 ${graph.center.displayName} 的投资和股权关系`
                    : `Find the investments and ownership of ${graph.center.displayName}`,
                )
              }
            >
              {t("graph.askAgent")}
            </button>
          </div>
        ) : null}
        {graph.center.slug ? (
          <Link
            className="btn secondary full"
            to={`/c/${encodeURIComponent(graph.center.slug)}`}
          >
            {lang === "zh" ? "进入公司页" : "Open company page"}
          </Link>
        ) : null}
      </aside>
    );
  }

  const node = selectedNode;
  const nodeEdges = edges.filter(
    (edge) => edge.src.id === node.id || edge.dst.id === node.id,
  );
  const evidenceEdge = nodeEdges.find((edge) => edge.evidence.length > 0);
  const evidence = evidenceEdge?.evidence[0];
  const evidenceUrl = evidence?.url;
  const magnitude = evidenceEdge
    ? relationMagnitudeLabel(evidenceEdge, lang)
    : null;
  const category = relationCategory(nodeEdges[0]?.type ?? "other");
  return (
    <aside className="card graph-inspector" aria-live="polite">
      <div className={`insp-cat cat-${CATEGORY_CLASS[category]}`}>
        {categoryLabel(category, lang)}
      </div>
      <h3>{node.displayName}</h3>
      <div className="insp-sub">
        {node.tickers.map((ticker) => ticker.ticker).join(" · ")}
      </div>
      {evidenceEdge ? (
        <div className="insp-sub">
          {relationTypeLabel(evidenceEdge.type, lang)} ·{" "}
          {statusLabel(evidenceEdge.status, lang)}
          {relationSourceLabel(evidenceEdge.extractorVersion, lang)
            ? ` · ${relationSourceLabel(evidenceEdge.extractorVersion, lang)}`
            : ""}
        </div>
      ) : null}
      {magnitude ? (
        <div className="insp-magnitude">
          <span>{t("graph.amount")}</span>
          <strong>{magnitude}</strong>
        </div>
      ) : null}
      {evidence?.quote ? <blockquote>“{evidence.quote}”</blockquote> : null}
      {evidenceUrl ? (
        <div className="insp-source">
          <button
            type="button"
            className="src-btn"
            onClick={() =>
              onOpenSource({
                url: evidenceUrl,
                title: evidence?.title,
                quote: evidence?.quote,
                trustTier: evidence?.trustTier,
                date: evidence?.publishedAt,
              })
            }
          >
            {t("graph.source")}
          </button>
        </div>
      ) : (
        <p className="insp-hint">{t("company.noData")}</p>
      )}
      {node.slug ? (
        <Link
          className="btn secondary full"
          to={`/c/${encodeURIComponent(node.slug)}`}
        >
          {lang === "zh" ? "进入公司页" : "Open company page"}
        </Link>
      ) : null}
    </aside>
  );
}

function RelationList({
  edges,
  centerId,
  selected,
  lang,
  onSelect,
  onOpenSource,
}: {
  edges: RelationView[];
  centerId: string;
  selected: { type: "center" | "node" | "edge"; id: string };
  lang: Lang;
  onSelect: (id: string) => void;
  onOpenSource: ReturnType<typeof useSource>["openSource"];
}) {
  const { t } = useLang();
  const groups = new Map<RelationCategory, RelationView[]>();
  for (const edge of edges) {
    const category = relationCategory(edge.type);
    groups.set(category, [...(groups.get(category) ?? []), edge]);
  }

  return (
    <div className="relation-lists" id="relation-lists">
      {CATEGORY_ORDER.filter((category) => groups.has(category)).map(
        (category) => {
          const rawRows = groups.get(category) ?? [];
          // Largest holdings first so the list mirrors the graph's top-N.
          const rows =
            category === "investment"
              ? [...rawRows].sort(
                  (left, right) =>
                    edgeMagnitude(right) - edgeMagnitude(left),
                )
              : rawRows;
          return (
            <div className="rel-group" key={category}>
              <h4>
                <span>{categoryLabel(category, lang)}</span>
                <span>{rows.length}</span>
              </h4>
              {rows.map((edge) => {
                const label =
                  edge.src.id === centerId
                    ? edge.dst.displayName
                    : edge.dst.id === centerId
                      ? edge.src.displayName
                      : `${edge.src.displayName} → ${edge.dst.displayName}`;
                const evidence = edge.evidence[0];
                const magnitude = relationMagnitudeLabel(edge, lang);
                return (
                  <div
                    className={`rel-row${
                      selected.type === "edge" && selected.id === edge.id
                        ? " selected"
                        : ""
                    }`}
                    key={edge.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(edge.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(edge.id);
                      }
                    }}
                  >
                    <span
                      className={`rel-dot cat-${CATEGORY_CLASS[category]}`}
                    />
                    <span>
                      <span className="rel-name">
                        {label}
                      </span>
                      <span className="rel-meta">
                        {" "}
                        · {relationTypeLabel(edge.type, lang)} ·{" "}
                        {statusLabel(edge.status, lang)}
                        {relationSourceLabel(edge.extractorVersion, lang)
                          ? ` · ${relationSourceLabel(edge.extractorVersion, lang)}`
                          : ""}
                        {magnitude ? (
                          <span className="rel-amount"> · {magnitude}</span>
                        ) : null}
                      </span>
                    </span>
                    <span
                      className={`pill ${
                        edge.status === "verified"
                          ? "ok"
                          : edge.status === "reported"
                            ? "info"
                            : "warn"
                      }`}
                    >
                      {relationBadgeLabel(edge, lang)}
                    </span>
                    {evidence?.url ? (
                      <button
                        type="button"
                        className="src-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenSource({
                            url: evidence.url!,
                            title: evidence.title,
                            quote: evidence.quote,
                            trustTier: evidence.trustTier,
                            date: evidence.publishedAt,
                          });
                        }}
                      >
                        {t("graph.source")}
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </div>
          );
        },
      )}
    </div>
  );
}
