import { createHash } from "node:crypto";

import {
  AppError,
  RelationTypeSchema,
  type ReviewBatchDecision,
  type ReviewBatchResult,
  type ReviewDecision,
  type ReviewItemView,
  type ReviewProposal,
  type ReviewQueueQuery,
} from "@occ/core";
import {
  decideReviewItems,
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
      if (!textField(payload, ["predicate"])) {
        throw new AppError("bad_request", "fact proposal requires predicate");
      }
      if (!("value" in payload) || payload.value === null) {
        throw new AppError("bad_request", "fact proposal requires value");
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

  /** Decide one item. Already-decided items are returned unchanged. */
  async decide(
    id: string,
    input: ReviewDecision,
  ): Promise<{ item: ReviewItemView; updated: boolean }> {
    const outcome = await decideReviewItems(
      this.db,
      { ids: [id], limit: 1 },
      { status: input.decision, reviewer: input.reviewer },
    );
    const item = outcome.items[0] ?? (await getReviewItem(this.db, id));
    if (!item) {
      throw new AppError("not_found", `review item not found: ${id}`);
    }
    return { item, updated: outcome.updated > 0 };
  }

  /**
   * Decide a filtered batch. A non-empty filter is mandatory (`ids`, `kind`,
   * `company`, or `all: true`) so a blank request cannot approve everything.
   */
  async decideBatch(input: ReviewBatchDecision): Promise<ReviewBatchResult> {
    if (!input.all && !input.ids?.length && !input.kind && !input.company) {
      throw new AppError(
        "bad_request",
        "batch decision requires ids, kind, company or all=true",
      );
    }
    let companyId: string | undefined;
    if (input.company) {
      const resolved = await resolveCompanyId(this.db, input.company);
      if (!resolved) {
        throw new AppError("not_found", `company not found: ${input.company}`);
      }
      companyId = resolved;
    }
    return decideReviewItems(
      this.db,
      {
        ids: input.ids,
        kind: input.kind,
        companyId,
        limit: input.limit,
        all: input.all,
      },
      { status: input.decision, reviewer: input.reviewer },
    );
  }
}
