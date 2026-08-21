import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/*
 * How tests launch a TypeScript entry point in a subprocess.
 *
 * NOT `npx tsx <entry>`: on Windows that costs ~2.6s per spawn (package
 * resolution plus the npx.cmd shim routing through cmd.exe -- measured 3097ms
 * vs 475ms for the form below), and it wedges a cmd.exe process between the
 * test and the server, so `child.kill()` signals the shim instead of the
 * server and long-lived children get orphaned.
 *
 * The loader is resolved from THIS file and passed as an absolute file URL:
 * `--import tsx` resolves the bare specifier against the CHILD's cwd, and
 * several tests deliberately spawn with cwd set to a temp dir outside the
 * repo (see tests/integration/data-dir-boot-warning.test.ts).
 */
const tsxLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** Spawn as `spawn(process.execPath, [...TSX_NODE_ARGS, entry, ...args])`. */
export const TSX_NODE_ARGS: readonly string[] = ["--import", tsxLoaderUrl];
