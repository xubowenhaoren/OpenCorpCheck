import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface SnapshotObject {
  /** Object key inside the bucket (prefix included). */
  key: string;
  /** `s3://bucket/key`. */
  uri: string;
  sha256: string;
  bytes: number;
}

export interface SnapshotHead {
  key: string;
  bytes: number;
  etag?: string;
}

/**
 * Minimal S3-compatible store. MinIO is the development/default target; AWS S3
 * or any S3-compatible service works with the same configuration.
 */
export interface SnapshotStore {
  readonly bucket: string;
  readonly endpoint: string;
  put(
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<SnapshotObject>;
  head(key: string): Promise<SnapshotHead | null>;
  list(prefix: string, limit?: number): Promise<string[]>;
  uri(key: string): string;
}

export interface SnapshotStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** MinIO needs path-style addressing; AWS accepts it too. */
  forcePathStyle?: boolean;
  /** Optional key prefix, e.g. `opencorpcheck/`. */
  prefix?: string;
}

/**
 * Build config from `OCC_S3_*`. Returns null when the store is not configured,
 * so the pipeline stays unchanged unless an operator opts in.
 */
export function snapshotStoreConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SnapshotStoreConfig | null {
  const endpoint = env.OCC_S3_ENDPOINT?.trim();
  const bucket = env.OCC_S3_BUCKET?.trim();
  if (!endpoint && !bucket) return null;
  if (!endpoint || !bucket) {
    throw new Error(
      "snapshot store needs both OCC_S3_ENDPOINT and OCC_S3_BUCKET",
    );
  }
  const accessKeyId = env.OCC_S3_ACCESS_KEY?.trim();
  const secretAccessKey = env.OCC_S3_SECRET_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "OCC_S3_ACCESS_KEY and OCC_S3_SECRET_KEY are required when OCC_S3_ENDPOINT is set",
    );
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.OCC_S3_REGION?.trim() || "us-east-1",
    forcePathStyle: env.OCC_S3_FORCE_PATH_STYLE !== "false",
    prefix: env.OCC_S3_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || undefined,
  };
}

/** Create a store, or null when `OCC_S3_ENDPOINT`/`OCC_S3_BUCKET` are unset. */
export function createSnapshotStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SnapshotStore | null {
  const config = snapshotStoreConfigFromEnv(env);
  return config ? new S3SnapshotStore(config) : null;
}

export class S3SnapshotStore implements SnapshotStore {
  readonly bucket: string;
  readonly endpoint: string;
  private readonly client: S3Client;
  private readonly prefix?: string;
  private bucketReady: Promise<void> | null = null;

  constructor(private readonly config: SnapshotStoreConfig) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.prefix = config.prefix;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? "us-east-1",
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(
    key: string,
    body: Uint8Array | string,
    contentType = "application/octet-stream",
  ): Promise<SnapshotObject> {
    await this.ensureBucket();
    const bytes =
      typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = this.objectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType,
        Metadata: { sha256 },
      }),
    );
    return {
      key: objectKey,
      uri: this.uri(objectKey),
      sha256,
      bytes: bytes.byteLength,
    };
  }

  async head(key: string): Promise<SnapshotHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
        }),
      );
      return {
        key: this.objectKey(key),
        bytes: result.ContentLength ?? 0,
        etag: result.ETag,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async list(prefix: string, limit = 1_000): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.objectKey(prefix),
          MaxKeys: Math.min(1_000, limit - keys.length),
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      continuationToken = result.IsTruncated
        ? result.NextContinuationToken
        : undefined;
    } while (continuationToken && keys.length < limit);
    return keys;
  }

  uri(key: string): string {
    return `s3://${this.bucket}/${this.objectKey(key)}`;
  }

  private objectKey(key: string): string {
    const clean = key.replace(/^\/+/, "");
    if (!this.prefix) return clean;
    // Idempotent: callers may pass a key returned by put()/head()/list().
    return clean.startsWith(`${this.prefix}/`)
      ? clean
      : `${this.prefix}/${clean}`;
  }

  private async ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        try {
          await this.client.send(
            new HeadBucketCommand({ Bucket: this.bucket }),
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
          await this.client.send(
            new CreateBucketCommand({ Bucket: this.bucket }),
          );
        }
      })();
    }
    return this.bucketReady;
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    record.name === "NotFound" ||
    record.name === "NoSuchKey" ||
    record.name === "NoSuchBucket" ||
    record.$metadata?.httpStatusCode === 404
  );
}

/** Content-addressed section snapshot key: `sections/<slug>/<sha256>.md`. */
export function sectionSnapshotKey(companySlug: string, sha256: string): string {
  return `sections/${companySlug}/${sha256}.md`;
}
