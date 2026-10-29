import { createHash } from "node:crypto";

import {
  AppError,
  RelationTypeSchema,
  type ReviewItemView,
  type ReviewProposal,
  type ReviewQueueQuery,
} from "@occ/core";
import {
  getReviewItem,
  listReviewItems,
  resolveCompanyId,
  stableJson,
  upsertReviewItem,
  type Db,
} from "@occ/db";

function textField(
  payload: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * Proposals never write facts/relations directly. They are normalized (ticker
 * or slug → company id) and stored in `review_queue` for a human to accept.
 */
export class ReviewService {
  constructor(private readonly db: Db) {}

  async createProposal(
    input: ReviewProposal,
  ): Promise<{ item: ReviewItemView; created: boolean }> {
    const payload: Record<string, unknown> = { ...input.payload };

    if (input.kind === "fact") {
      const ref = textField(payload, ["companyId", "company_id", "company"]);
      if (!ref) {
        throw new AppError(
          "bad_request",
          "fact proposal requires companyId, company_id or company",
        );
      }
      const companyId = await resolveCompanyId(this.db, ref);
      if (!companyId) {
        throw new AppError("not_found", `company not found: ${ref}`);
      }
      payload.companyId = companyId;
    } else {
      const srcRef = textField(payload, ["srcCompanyId", "src_company_id", "src"]);
      const dstRef = textField(payload, ["dstCompanyId", "dst_company_id", "dst"]);
      const type = textField(payload, ["type"]);
      if (!srcRef || !dstRef || !type) {
        throw new AppError(
          "bad_request",
          "relation proposal requires src, dst and type",
        );
      }
      if (!RelationTypeSchema.safeParse(type).success) {
        throw new AppError("bad_request", `unknown relation type: ${type}`);
      }
      const [srcCompanyId, dstCompanyId] = await Promise.all([
        resolveCompanyId(this.db, srcRef),
        resolveCompanyId(this.db, dstRef),
      ]);
      if (!srcCompanyId) {
        throw new AppError("not_found", `company not found: ${srcRef}`);
      }
      if (!dstCompanyId) {
        throw new AppError("not_found", `company not found: ${dstRef}`);
      }
      if (srcCompanyId === dstCompanyId) {
        throw new AppError("bad_request", "src and dst must differ");
      }
      payload.srcCompanyId = srcCompanyId;
      payload.dstCompanyId = dstCompanyId;
      payload.type = type;
    }

    const key =
      input.idempotency_key ??
      sha1(
        `${input.kind}|${stableJson(payload)}|${stableJson(input.evidence ?? null)}`,
      );
    const dedupeKey = `proposal:${input.kind}:${key}`;
    const { item, created } = await upsertReviewItem(this.db, {
      kind: input.kind,
      payload,
      evidence: input.evidence,
      dedupeKey,
    });
    const stored = await getReviewItem(this.db, item.id);
    if (!stored) {
      throw new AppError("internal_error", "review item was not stored");
    }
    return { item: stored, created };
  }

  async list(
    query: ReviewQueueQuery,
  ): Promise<{ items: ReviewItemView[]; total: number }> {
    return listReviewItems(this.db, query);
  }
}
