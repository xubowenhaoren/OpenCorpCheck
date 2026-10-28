import { describe, expect, it } from "vitest";

import { pinyinAliasForms, pinyinVariants } from "../src/pinyin.js";

describe("pinyinVariants", () => {
  it("returns full pinyin and initials", () => {
    expect(pinyinVariants("英伟达")).toEqual({
      full: "yingweida",
      initials: "ywd",
    });
  });

  it("drops non-Chinese brand tokens", () => {
    expect(pinyinVariants("智谱 AI")).toEqual({ full: "zhipu", initials: "zp" });
  });

  it("returns null for non-Chinese aliases", () => {
    expect(pinyinVariants("NVIDIA")).toBeNull();
  });
});

describe("pinyinAliasForms", () => {
  it("adds full and initial forms", () => {
    expect(pinyinAliasForms("英伟达")).toEqual(["yingweida", "ywd"]);
  });

  it("also handles the corporate-suffix-stripped stem", () => {
    const forms = pinyinAliasForms("英特尔公司");
    expect(forms).toContain("ytegs");
    expect(forms).toContain("yte");
  });
});
