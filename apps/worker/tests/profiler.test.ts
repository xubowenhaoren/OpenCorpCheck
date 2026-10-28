import path from "node:path";

import { describe, expect, it } from "vitest";

import { config } from "../src/config.ts";
import {
  DEFAULT_FOCUS,
  promptHash,
  renderPrompt,
  sha256Text,
  skillForTarget,
  skillPath,
} from "../src/research/profiler.ts";
import type { CompanyTarget } from "../src/universe.ts";

const mag7Target: CompanyTarget = {
  key: "US:AAPL",
  ticker: "AAPL",
  name: "Apple Inc.",
  market: "US",
  code: "AAPL",
  focus: "iPhone and services",
  priority: 60,
  source: "mag7",
};

const aShareTarget: CompanyTarget = {
  key: "A:600519",
  ticker: "600519",
  name: "600519",
  market: "A",
  code: "600519",
  priority: 50,
  source: "explicit",
};

const hkTarget: CompanyTarget = {
  key: "HK:00700",
  ticker: "00700",
  name: "00700",
  market: "HK",
  code: "00700",
  priority: 100,
  source: "ai-watchlist",
};

describe("skillForTarget", () => {
  it("keeps the tuned MAG7 skill for the MAG7 universe", () => {
    expect(skillForTarget(mag7Target)).toBe("mag7-profile");
  });

  it("uses the generic company-profile skill for A/HK and other targets", () => {
    expect(skillForTarget(aShareTarget)).toBe("company-profile");
    expect(skillForTarget(hkTarget)).toBe("company-profile");
  });
});

describe("renderPrompt", () => {
  it("fills every template placeholder for a MAG7 target", () => {
    const prompt = renderPrompt(mag7Target, "2026-10-28");
    expect(prompt).toContain("Apple Inc.");
    expect(prompt).toContain("AAPL");
    expect(prompt).toContain("美股");
    expect(prompt).toContain("2026-10-28");
    expect(prompt).toContain("iPhone and services");
    expect(prompt).toContain("mag7-profile");
    expect(prompt).not.toContain("{{");
  });

  it("uses the generic skill and the market label for an A-share target", () => {
    const prompt = renderPrompt(aShareTarget, "2026-10-28");
    expect(prompt).toContain("company-profile");
    expect(prompt).toContain("A 股");
    expect(prompt).toContain(DEFAULT_FOCUS);
    expect(prompt).not.toContain("{{");
  });

  it("labels HK targets and survives unknown markets", () => {
    expect(renderPrompt(hkTarget, "2026-10-28")).toContain("港股");
    const unknown = { ...hkTarget, market: undefined };
    expect(renderPrompt(unknown, "2026-10-28")).toContain("未指明");
  });
});

describe("promptHash", () => {
  it("is stable for identical inputs and changes with model", () => {
    const prompt = renderPrompt(mag7Target, "2026-10-28");
    const first = promptHash(prompt, [config.basePatch]);
    expect(promptHash(prompt, [config.basePatch])).toBe(first);

    const originalModel = config.model;
    try {
      config.model = "some-other-model";
      expect(promptHash(prompt, [config.basePatch])).not.toBe(first);
    } finally {
      config.model = originalModel;
    }
  });

  it("changes when a patch layer is added", () => {
    const prompt = renderPrompt(mag7Target, "2026-10-28");
    expect(promptHash(prompt, [config.basePatch])).not.toBe(
      promptHash(prompt, [config.basePatch, config.f10Patch]),
    );
  });

  it("changes when the skill differs, so a skill switch invalidates the cache", () => {
    const prompt = renderPrompt(aShareTarget, "2026-10-28");
    expect(promptHash(prompt, [config.basePatch], "company-profile")).not.toBe(
      promptHash(prompt, [config.basePatch], "mag7-profile"),
    );
  });
});

describe("sha256Text", () => {
  it("matches a known digest", () => {
    expect(sha256Text("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("skillPath", () => {
  it("resolves inside the repo's dsh skills directory", () => {
    expect(skillPath("company-profile")).toBe(
      path.join(config.repoRoot, ".dsh", "skills", "company-profile", "SKILL.md"),
    );
  });
});
