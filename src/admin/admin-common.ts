// qualite-code-04: shared response/body helpers extracted from
// handle-admin-orgs.ts and handle-admin-users.ts, which duplicated
// writeJson/readJsonBody/writeValidationError verbatim. Both handlers use the
// same 4096-byte body cap, so it's inlined here rather than parameterized.
//
// Note: handle-service-tokens.ts does NOT use these helpers — it hand-rolls
// its own body read + res.writeHead/res.end calls with a different response
// shape, so it is intentionally NOT wired to this module (kept out of scope).
import type { IncomingMessage, ServerResponse } from "node:http";
import { appError } from "../http/response-contract.js";
import { AdminValidationError } from "./validate.js";

const MAX_BODY_BYTES = 4096;

/** Return true and write a JSON error response; caller exits early. */
export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Read a JSON body up to MAX_BODY_BYTES. Returns null + writes 400 on error. */
export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<T | null> {
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        writeJson(
          res,
          400,
          appError("INVALID_REQUEST", "Request body too large"),
        );
        return null;
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length === 0) {
      writeJson(res, 400, appError("INVALID_REQUEST", "Empty request body"));
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      writeJson(
        res,
        400,
        appError("INVALID_REQUEST", "Body must be a JSON object"),
      );
      return null;
    }
    return parsed as T;
  } catch {
    writeJson(
      res,
      400,
      appError("INVALID_REQUEST", "Could not parse JSON body"),
    );
    return null;
  }
}

/** Translate AdminValidationError into a 400 with the validator's code. */
export function writeValidationError(
  res: ServerResponse,
  err: AdminValidationError,
): void {
  writeJson(res, 400, appError(err.code, err.message));
}
