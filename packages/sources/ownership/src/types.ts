/** A planned ownership edge, before it goes through the DB writer. */
export type OwnershipEdgeType = "owns" | "invests_in" | "parent_of";

export interface OwnershipEdgeDraft {
  srcCompanyId: string;
  dstCompanyId: string;
  type: OwnershipEdgeType;
  quote: string;
  sourceUrl: string;
  sourceTitle: string;
  confidence: number;
  validFrom?: string;
  publishedAt?: Date;
  amount?: number;
  currency?: string;
  metadata: Record<string, unknown>;
  extractorVersion: string;
  origin: string;
}
