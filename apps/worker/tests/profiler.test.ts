import { describe, expect, it } from "vitest";

import { config } from "../src/config.ts";
import {
  promptHash,
  renderPrompt,
  sha256Text,
} from "../src/research/profiler.ts";
import type { CompanyTarget } from "../src/universe.ts";

const target: CompanyTarget = {
  key: "US:AAPL",
  ticker: "AAPL",
  name: "Apple Inc.",
  market: "US",
  code: "AAPL",
  focus: "iPhone and services",
  priority: 60,
  source: "mag7",
};

describe("renderPrompt", () => {
  it("fills every template placeholder and loads the skill", () => {
    const prompt = renderPrompt(target, "2026-10-28");
    expect(prompt).toContain("Apple Inc.");
    expect(prompt).toContain("AAPL");
    expect(prompt).toContain("2026-10-28");
    expect(prompt).toContain("iPhone and services");
    expect(prompt).toContain("mag7-profile");
    expect(prompt).not.toContain("{{");
  });
});

describe("promptHash", () => {
  it("is stable for identical inputs and changes with model", () => {
    const prompt = renderPrompt(target, "2026-10-28");
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
    const prompt = renderPrompt(target, "2026-10-28");
    expect(promptHash(prompt, [config.basePatch])).not.toBe(
      promptHash(prompt, [config.basePatch, config.f10Patch]),
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
