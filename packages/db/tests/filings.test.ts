import { describe, expect, it } from "vitest";

import { filingRowId } from "../src/repositories/filings.js";

describe("filingRowId", () => {
  it("is deterministic for one source + accession", () => {
    const first = filingRowId("edgar", "0000320193-26-000026");
    const second = filingRowId("edgar", "0000320193-26-000026");
    expect(first).toBe(second);
    expect(first).toMatch(/^fil_[0-9a-f]{24}$/);
  });

  it("does not collide across sources or accessions", () => {
    expect(filingRowId("edgar", "A")).not.toBe(filingRowId("cninfo", "A"));
    expect(filingRowId("edgar", "A")).not.toBe(filingRowId("edgar", "B"));
  });
});
