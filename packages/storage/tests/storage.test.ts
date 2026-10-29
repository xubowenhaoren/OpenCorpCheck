import { describe, expect, it } from "vitest";

import {
  sectionSnapshotKey,
  snapshotStoreConfigFromEnv,
} from "../src/index.js";

describe("snapshot store config", () => {
  it("is disabled when neither endpoint nor bucket is set", () => {
    expect(snapshotStoreConfigFromEnv({})).toBeNull();
  });

  it("rejects a half-configured store", () => {
    expect(() =>
      snapshotStoreConfigFromEnv({ OCC_S3_ENDPOINT: "http://127.0.0.1:9000" }),
    ).toThrow(/OCC_S3_BUCKET/);
  });

  it("requires credentials when enabled", () => {
    expect(() =>
      snapshotStoreConfigFromEnv({
        OCC_S3_ENDPOINT: "http://127.0.0.1:9000",
        OCC_S3_BUCKET: "opencorpcheck",
      }),
    ).toThrow(/OCC_S3_ACCESS_KEY/);
  });

  it("normalizes defaults and the prefix", () => {
    const config = snapshotStoreConfigFromEnv({
      OCC_S3_ENDPOINT: "http://127.0.0.1:9000/",
      OCC_S3_BUCKET: "opencorpcheck",
      OCC_S3_ACCESS_KEY: "minioadmin",
      OCC_S3_SECRET_KEY: "minioadmin",
      OCC_S3_PREFIX: "/occ/",
    });
    expect(config).toMatchObject({
      endpoint: "http://127.0.0.1:9000/",
      bucket: "opencorpcheck",
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "occ",
    });
  });
});

describe("snapshot keys", () => {
  it("uses a content-addressed section path", () => {
    expect(sectionSnapshotKey("apple", "abc123")).toBe(
      "sections/apple/abc123.md",
    );
  });
});
