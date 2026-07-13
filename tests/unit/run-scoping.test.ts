// tests/unit/run-scoping.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-run-scoping";
let consultation: Consultation;
let registry: AgentRegistry;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  seedTestOrgs(getDb(), ["default"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  consultation = new Consultation();
  registry.register("default", "a1", "Agent A", ["src/auth"]);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function announce(subject: string, run_id?: string | null) {
  return consultation.announceWork("default", {
    agent_id: "a1",
    subject,
    target_modules: [],
    target_files: [],
    keep_open: true,
    run_id,
  });
}

// Régression #32 — sur un coordinateur partagé et persistant (où /api/reset est
// 403 par design), les threads d'un run AVORTÉ restaient visibles aux agents du
// run suivant : un lead a consulté un thread éventé. Les agents s'auto-guérissaient
// en résolvant les orphelins, mais le bruit était réel.
describe("scoping par run (#32)", () => {
  it("persiste le run_id à l'announce", () => {
    const thread = announce("tâche du run 1", "run-1");
    expect(thread.run_id).toBe("run-1");
  });

  it("un announce sans run_id reste possible — rien ne casse pour l'existant", () => {
    const thread = announce("session humaine");
    expect(thread.run_id).toBeNull();
  });

  it("un run ne voit PAS les threads d'un autre run", () => {
    announce("tâche du run avorté", "run-1");
    announce("tâche du run courant", "run-2");

    const visible = consultation.listThreads("default", { run_id: "run-2" });

    expect(visible.map((t) => t.subject)).toEqual(["tâche du run courant"]);
  });

  it("un run VOIT quand même les threads sans run_id — sinon on piétinerait une session humaine", () => {
    // C'est le point délicat : filtrer en égalité stricte rendrait invisibles les
    // threads d'un humain travaillant le même repo, et les agents lui marcheraient
    // dessus. On masque les autres RUNS, pas les autres SESSIONS.
    announce("session humaine sur src/auth", null);
    announce("tâche du run courant", "run-2");
    announce("tâche d'un run mort", "run-1");

    const visible = consultation.listThreads("default", { run_id: "run-2" }).map((t) => t.subject);

    expect(visible).toContain("session humaine sur src/auth");
    expect(visible).toContain("tâche du run courant");
    expect(visible).not.toContain("tâche d'un run mort");
  });

  it("sans filtre run_id, on voit tout — comportement historique inchangé", () => {
    announce("run 1", "run-1");
    announce("run 2", "run-2");
    announce("sans run", null);

    expect(consultation.listThreads("default", {})).toHaveLength(3);
  });

  it("le filtre run_id se combine avec les autres filtres", () => {
    announce("ouvert, run-2", "run-2");
    const resolved = announce("résolu, run-2", "run-2");
    consultation.proposeResolution("default", resolved.id, "a1", "fini");

    const open = consultation.listThreads("default", { run_id: "run-2", status: "open" });
    expect(open.map((t) => t.subject)).toEqual(["ouvert, run-2"]);
  });
});
