import { createConnection } from "node:net";

/**
 * Does something accept a TCP connection at host:port?
 *
 * Shared by `doctor` (which reports it) and `server start --daemon` (which
 * waits on it before claiming the daemon is up — issue #273). It lived only in
 * doctor.ts; the start path needs the identical question answered, and two
 * copies of a liveness probe drift.
 */
export async function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolveP) => {
    const sock = createConnection({ host, port });
    const settle = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* already destroyed */
      }
      resolveP(ok);
    };
    sock.setTimeout(timeoutMs, () => settle(false));
    sock.on("connect", () => settle(true));
    sock.on("error", () => settle(false));
  });
}
