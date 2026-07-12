// architecture-11: version resolution now lives in src/version.ts (the core)
// so that src/ never has to depend on cli/ (the interface layer). This file
// re-exports it for existing cli/ consumers (cli/index.ts's --version flag).
export { getVersion } from "../src/version.js";
