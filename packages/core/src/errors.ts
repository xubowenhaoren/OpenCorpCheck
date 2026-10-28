export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "ambiguous"
  | "upstream_error"
  | "auth_error"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  ambiguous: 409,
  upstream_error: 502,
  auth_error: 401,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("internal_error", message);
}
