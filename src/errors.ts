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

export function notFound(message: string): CalDavError {
  return new CalDavError("not_found", message, 404);
}
