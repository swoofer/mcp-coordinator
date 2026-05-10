import { describe, it, expect } from "vitest";
import { parseBody } from "../../src/http/utils.js";
import { Readable } from "stream";

function makeReq(payload: Buffer | string): any {
  const stream = Readable.from([Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
  return stream;
}

describe("parseBody size cap", () => {
  it("accepts a small JSON body", async () => {
    const req = makeReq(JSON.stringify({ ok: true }));
    const body = await parseBody(req);
    expect(body).toEqual({ ok: true });
  });

  it("rejects > MAX_BODY_BYTES with 413", async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MB of 'a'
    const req = makeReq(huge);
    let err: any;
    await parseBody(req).catch((e) => (err = e));
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(413);
    expect(err.message).toMatch(/payload too large/i);
  });
});
