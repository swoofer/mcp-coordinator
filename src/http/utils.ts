import type { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { AuthResult } from "../auth.js";

/**
 * S1: shared HTTP helpers extracted from serve-http.ts.
 * parseBody, json, decodeJwtPayload, safeEqual, jsonAuthError.
 */

const MAX_BODY_BYTES = parseInt(process.env.COORDINATOR_MAX_BODY_BYTES || "1048576", 10);

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const err: Error & { statusCode?: number } = new Error("Payload too large");
        err.statusCode = 413;
        // destroy() may not exist on every IncomingMessage-like input (test stub).
        (req as unknown as { destroy?: (e?: Error) => void }).destroy?.(err);
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

/**
 * Decode a JWT payload WITHOUT verifying. Used only on tokens we just minted
 * ourselves (to read the `exp` claim before returning it to the client). Real
 * verification of inbound tokens happens in `authenticateRequest` via
 * jose.jwtVerify().
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64url = token.split(".")[1];
  return JSON.parse(Buffer.from(base64url, "base64url").toString("utf-8"));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function jsonAuthError(res: ServerResponse, authResult: Exclude<AuthResult, { ok: true }>): void {
  if (authResult.wwwAuthenticate) {
    res.setHeader("WWW-Authenticate", authResult.wwwAuthenticate);
  }
  json(res, { error: authResult.error }, authResult.status);
}
