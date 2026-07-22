import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import {
  noteEpochBump,
  getEpochFloor,
  resetEpochFloorForTest,
} from "../../src/auth/token-epoch.js";
import { checkTokenEpoch } from "../../src/auth/refresh-rotation.js";
import { initDatabase, closeDb } from "../../src/database.js";

const DIR = "data-test-token-epoch-floor";

// The refresh grant must honor an epoch bump received via pub/sub (floor)
// even if the local READ DB has not yet converged (WAL cross-instance).
describe("token-epoch floor (multi-instance) — refresh grant", () => {
  const SUB = "user-123";

  // checkTokenEpoch's rejection path calls audit(), which reaches through
  // to the global getDb() singleton — needs a real (test) DB initialized,
  // even though the epoch read itself is stubbed via fakeCtx below.
  beforeAll(() => {
    fs.mkdirSync(DIR, { recursive: true });
    initDatabase(DIR);
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetEpochFloorForTest();
  });

  it("effective epoch = max(db, floor) so a pub/sub bump revokes a stale-epoch refresh", () => {
    noteEpochBump(SUB, 7); // un autre pod a bumpé l'epoch à 7
    const dbEpoch = 3; // le READ DB local est en retard
    const effective = Math.max(dbEpoch, getEpochFloor(SUB));
    expect(effective).toBe(7); // le refresh doit utiliser 7, pas 3
  });

  // Real-code regression coverage: exercises checkTokenEpoch (the actual
  // refresh-rotation step) end-to-end, not just the pure floor math above.
  // Without the multi-instance floor fix, this fails (the stale-epoch refresh is wrongly
  // accepted); with the fix, it's rejected.
  describe("checkTokenEpoch — cross-instance floor honored", () => {
    function fakeCtx(dbEpoch: number) {
      return {
        db: {
          prepare: (_sql: string) => ({
            get: (_userId: string) => ({ token_epoch: dbEpoch }),
          }),
        },
      } as unknown as Parameters<typeof checkTokenEpoch>[0];
    }

    function fakeRes() {
      let statusCode: number | null = null;
      let body: string | null = null;
      return {
        res: {
          writeHead: (status: number) => {
            statusCode = status;
          },
          end: (payload?: string) => {
            body = payload ?? null;
          },
        } as unknown as Parameters<typeof checkTokenEpoch>[2],
        get statusCode() {
          return statusCode;
        },
        get body() {
          return body;
        },
      };
    }

    it("rejects a refresh whose iat is stale relative to a pub/sub-bumped floor, even though the local DB read hasn't converged", () => {
      // Instance B's local READ DB still shows epoch=3 (WAL visibility lag),
      // but instance A already bumped to 7 and published it — this instance
      // observed that bump via noteEpochBump (what the subscriber wiring in
      // serve-http.ts does on the pub/sub channel).
      noteEpochBump(SUB, 7);
      const claims = { sub: SUB, iat: 5 } as unknown as Parameters<typeof checkTokenEpoch>[1];
      const mock = fakeRes();

      const result = checkTokenEpoch(fakeCtx(3), claims, mock.res as never);

      // Pre-fix bug: readTokenEpoch alone returns 3, so
      // claims.iat(5) < 3 is false — the stale refresh is wrongly accepted
      // (result.ok === true, no 400 written). Post-fix: max(3, floor=7) = 7,
      // 5 < 7 is true — correctly rejected.
      expect(result.ok).toBe(false);
      expect(mock.statusCode).toBe(400);
    });

    it("control: without a floor bump, the same iat/dbEpoch pair is accepted (no false positives)", () => {
      const claims = { sub: SUB, iat: 5 } as unknown as Parameters<typeof checkTokenEpoch>[1];
      const { res } = fakeRes();

      const result = checkTokenEpoch(fakeCtx(3), claims, res as never);

      expect(result.ok).toBe(true);
    });
  });
});
