export type ErrorCode =
  | "auth_failed"
  | "not_found"
  | "conflict"
  | "read_only_calendar"
  | "invalid_input"
  | "server_error"
  | "not_configured";

export class CalDavError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = "CalDavError";
    this.code = code;
    this.status = status;
  }
}

export function invalidInput(message: string): CalDavError {
  return new CalDavError("invalid_input", message);
}

/** Logical not-found (no HTTP status): does not trigger discovery refresh. */
export function notFound(message: string): CalDavError {
  return new CalDavError("not_found", message);
}
