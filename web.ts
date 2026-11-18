// web.ts — the tiny HTTP contract between app.ts (the server shell) and the
// surface modules (rest.ts, graphql.ts, mcp.ts, git.ts). Type-only except for
// HttpError, so importing it never creates a runtime cycle.

/** One inbound request, pre-parsed by the shell: decoded path segments + query. */
export interface WebRequest {
  method: string;
  /** Decoded path segments, e.g. ['api', 'v3', 'repos', 'adaiversen', 'x']. */
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
  /** The request's Host header, for building absolute pagination links. */
  host: string;
  /** The Git-Protocol header value, when present (git info/refs negotiation). */
  gitProtocol: string | null;
  /** Parse the body as JSON; throws HttpError(400) when it is not valid JSON. */
  json(): unknown;
}

/** One outbound response. `body` is sent verbatim; '' means an empty body. */
export interface WebResponse {
  status: number;
  body: string | Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

/** An error that maps directly onto an HTTP status + JSON {message} body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A JSON response object. */
export function jsonResponse(status: number, value: unknown, headers?: Record<string, string>): WebResponse {
  return { status, body: JSON.stringify(value), contentType: 'application/json; charset=utf-8', headers };
}

/** A JSON {message} error response. */
export function errorResponse(status: number, message: string): WebResponse {
  return jsonResponse(status, { message });
}
