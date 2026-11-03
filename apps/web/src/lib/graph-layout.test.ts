import { describe, expect, it } from "vitest";
import type { CompanyGraphView, CompanySummary, RelationView } from "@occ/core";

import {
  buildGraphLayout,
  CENTER_RADIUS,
  CENTER_X,
  CENTER_Y,
  CLUSTER_ID,
  CLUSTER_RADIUS,
  isOwnershipEdge,
  NODE_RADIUS,
  TOP_HOLDER_LIMIT,
} from "./graph-layout";

function company(id: string, name: string): CompanySummary {
  return { id, slug: id, displayName: name, tickers: [] };
}

interface EdgeOptions {
  amount?: number;
  percent?: number;
  source?: string;
  type?: RelationView["type"];
}

function edge(
  center: CompanySummary,
  holder: CompanySummary,
  options: EdgeOptions = {},
): RelationView {
  return {
    id: `r-${holder.id}`,
    src: holder,
    dst: center,
    type: options.type ?? "invests_in",
    label: options.type ?? "invests_in",
    direction: "incoming",
    status: "reported",
    confidence: 0.9,
    amount: options.amount,
    currency: options.amount === undefined ? undefined : "USD",
    extractorVersion: options.source ?? "sec-13f-v1",
    metadata:
      options.percent === undefined ? {} : { percent: options.percent },
    evidence: [],
  };
}

function graph(
  center: CompanySummary,
  edges: RelationView[],
): CompanyGraphView {
  const nodes = new Map<string, CompanySummary>();
  nodes.set(center.id, center);
  for (const item of edges) {
    nodes.set(item.src.id, item.src);
    nodes.set(item.dst.id, item.dst);
  }
  return {
    center,
    nodes: [...nodes.values()],
    edges,
    depth: 1,
    truncated: false,
  };
}

function thirteenFilers(
  center: CompanySummary,
  count: number,
): { edges: RelationView[]; holders: CompanySummary[] } {
  const holders = Array.from({ length: count }, (_, index) =>
    company(`holder-${index + 1}`, `HOLDER ${index + 1}`),
  );
  return {
    holders,
    edges: holders.map((holder, index) =>
      edge(center, holder, { amount: (index + 1) * 1_000_000 }),
    ),
  };
}

function radius(position: { x: number; y: number }): number {
  return Math.round(Math.hypot(position.x - CENTER_X, position.y - CENTER_Y));
}

describe("dense ownership layout", () => {
  it("shows the ten largest 13F holders and collapses the rest", () => {
    const center = company("alphabet", "Alphabet Inc.");
    const { edges, holders } = thirteenFilers(center, 20);
    const layout = buildGraphLayout(graph(center, edges), edges, {
      expanded: false,
      clusterLabel: "其他机构",
    });

    expect(layout.collapsible).toBe(true);
    expect(layout.totalDirect).toBe(20);
    expect(layout.collapsedCount).toBe(10);
    expect(layout.cluster).toMatchObject({ id: CLUSTER_ID, count: 10 });
    expect(layout.nodes).toHaveLength(1 + TOP_HOLDER_LIMIT);
    expect(layout.positions.has(CLUSTER_ID)).toBe(true);

    // The ten largest (amounts 20..11 × 1M) stay; the ten smallest collapse.
    for (const holder of holders.slice(10)) {
      expect(layout.positions.has(holder.id)).toBe(true);
    }
    for (const holder of holders.slice(0, 10)) {
      expect(layout.positions.has(holder.id)).toBe(false);
    }
    // Priority for the visible labels follows the largest holding first once
    // the cluster label (always placed first) is accounted for.
    expect([...layout.labels.keys()][0]).toBe(CLUSTER_ID);
    expect([...layout.labels.keys()][1]).toBe(holders[19].id);
  });

  it("uses two rings once more than eight direct nodes are visible", () => {
    const center = company("alphabet", "Alphabet Inc.");
    const { edges } = thirteenFilers(center, 20);
    const layout = buildGraphLayout(graph(center, edges), edges, {
      expanded: false,
      clusterLabel: "其他机构",
    });

    const radii = new Set(
      [...layout.positions.entries()]
        .filter(([id]) => id !== center.id)
        .map(([, position]) => radius(position)),
    );
    expect(layout.dense).toBe(true);
    expect(radii.has(222)).toBe(true);
    expect(radii.has(302)).toBe(true);
  });

  it("expands to every holder and keeps the amount order", () => {
    const center = company("blackrock", "BlackRock, Inc.");
    const { edges } = thirteenFilers(center, 26);
    const layout = buildGraphLayout(graph(center, edges), edges, {
      expanded: true,
      clusterLabel: "其他机构",
    });

    expect(layout.collapsible).toBe(true);
    expect(layout.cluster).toBeNull();
    expect(layout.collapsedCount).toBe(0);
    expect(layout.nodes).toHaveLength(27);
    const firstLabel = [...layout.labels.keys()][0];
    expect(firstLabel).toBe("holder-26");
  });

  it("only collapses above the twelve-holder threshold", () => {
    const center = company("apple", "Apple Inc.");
    const twelve = thirteenFilers(center, 12);
    const compact = buildGraphLayout(
      graph(center, twelve.edges),
      twelve.edges,
      { expanded: false, clusterLabel: "其他机构" },
    );
    expect(compact.collapsible).toBe(false);
    expect(compact.cluster).toBeNull();

    const thirteen = thirteenFilers(center, 13);
    const collapsed = buildGraphLayout(
      graph(center, thirteen.edges),
      thirteen.edges,
      { expanded: false, clusterLabel: "其他机构" },
    );
    expect(collapsed.collapsible).toBe(true);
    expect(collapsed.cluster?.count).toBe(3);
  });

  it("keeps non-13F investment and other families visible", () => {
    const center = company("nvidia", "NVIDIA Corporation");
    const { edges } = thirteenFilers(center, 20);
    const f10 = company("f10-holder", "F10 HOLDER");
    const supplier = company("supplier", "SUPPLIER");
    const gleif = company("gleif-parent", "GLEIF PARENT");
    const mixed = [
      ...edges,
      edge(center, f10, { source: "f10-table-v1" }),
      edge(center, supplier, { source: "f10-table-v1", type: "supplies" }),
      edge(center, gleif, { source: "gleif-lei-v1", type: "parent_of" }),
    ];
    const layout = buildGraphLayout(graph(center, mixed), mixed, {
      expanded: false,
      clusterLabel: "其他机构",
    });

    expect(layout.cluster?.count).toBe(10);
    for (const visible of [f10, supplier, gleif]) {
      expect(layout.positions.has(visible.id)).toBe(true);
    }
  });

  it("ranks HKEX DION holders by long-position percentage when amount is absent", () => {
    const center = company("02318", "中国平安");
    const holders = Array.from({ length: 15 }, (_, index) =>
      company(`dion-${index + 1}`, `DION ${index + 1}`),
    );
    const edges = holders.map((holder, index) =>
      edge(center, holder, {
        source: "hkex-dion-v1",
        percent: (index + 1) / 10,
      }),
    );
    const layout = buildGraphLayout(graph(center, edges), edges, {
      expanded: false,
      clusterLabel: "其他机构",
    });

    expect(layout.cluster?.count).toBe(5);
    // Highest percentage stays, lowest five collapse.
    expect(layout.positions.has(holders[14].id)).toBe(true);
    expect(layout.positions.has(holders[0].id)).toBe(false);
  });
});

describe("label collision", () => {
  it("never places a visible label over the centre or another node/label", () => {
    const center = company("alphabet", "Alphabet Inc.");
    const { edges } = thirteenFilers(center, 20);
    const layout = buildGraphLayout(graph(center, edges), edges, {
      expanded: false,
      clusterLabel: "其他机构",
    });

    const visibleLabels = [...layout.labels.entries()].filter(
      ([, label]) => label.visible,
    );
    expect(visibleLabels.length).toBeGreaterThanOrEqual(8);

    const centerBox = {
      x: CENTER_X - CENTER_RADIUS,
      y: CENTER_Y - CENTER_RADIUS,
      w: CENTER_RADIUS * 2,
      h: CENTER_RADIUS * 2,
    };
    const overlaps = (
      left: { x: number; y: number; w: number; h: number },
      right: { x: number; y: number; w: number; h: number },
    ) =>
      left.x < right.x + right.w &&
      left.x + left.w > right.x &&
      left.y < right.y + right.h &&
      left.y + left.h > right.y;

    const nodeCircles = [
      ...layout.nodes.map((node) => ({
        id: node.id,
        x: layout.positions.get(node.id)?.x ?? 0,
        y: layout.positions.get(node.id)?.y ?? 0,
        radius: node.id === center.id ? CENTER_RADIUS : NODE_RADIUS,
      })),
      {
        id: CLUSTER_ID,
        x: layout.positions.get(CLUSTER_ID)?.x ?? 0,
        y: layout.positions.get(CLUSTER_ID)?.y ?? 0,
        radius: CLUSTER_RADIUS,
      },
    ];

    visibleLabels.forEach(([id, label], index) => {
      expect(overlaps(label.box, centerBox)).toBe(false);
      for (const circle of nodeCircles) {
        if (circle.id === id) continue;
        const box = {
          x: circle.x - circle.radius,
          y: circle.y - circle.radius,
          w: circle.radius * 2,
          h: circle.radius * 2,
        };
        expect(overlaps(label.box, box)).toBe(false);
      }
      visibleLabels.slice(index + 1).forEach(([, other]) => {
        expect(overlaps(label.box, other.box)).toBe(false);
      });
    });
  });
});

describe("filing edge emphasis", () => {
  it("marks 13F and DION edges as ownership but not F10/GLEIF", () => {
    const center = company("alphabet", "Alphabet Inc.");
    const holder = company("holder", "HOLDER");
    expect(isOwnershipEdge(edge(center, holder))).toBe(true);
    expect(
      isOwnershipEdge(edge(center, holder, { source: "hkex-dion-v1" })),
    ).toBe(true);
    expect(
      isOwnershipEdge(edge(center, holder, { source: "f10-table-v1" })),
    ).toBe(false);
    expect(
      isOwnershipEdge(edge(center, holder, { source: "gleif-lei-v1" })),
    ).toBe(false);
  });
});
