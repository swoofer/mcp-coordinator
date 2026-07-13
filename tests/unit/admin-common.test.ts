// T09 — unit tests for dashboard/public/admin-common.js.
//
// DOM polyfill decision: package.json devDeps include neither jsdom nor
// happy-dom (verified at T09 implementation time). Rather than add a heavy
// transitive dependency, we hand-roll a minimal `document`/`window`/
// `navigator` stub on globalThis BEFORE importing the module under test.
//
// The stub implements exactly the surface admin-common.js touches:
//   - document.cookie (string getter)
//   - document.createElement → minimal Element-like nodes
//   - document.body.appendChild
//   - window.location (mutable href/pathname/search)
//   - navigator.clipboard.writeText (no-op spy)
//   - globalThis.fetch (per-test mockable)
//   - globalThis.setTimeout (real timers; tests await microtasks)
//
// Anything richer (querySelector, layout, events bubbling) is intentionally
// out of scope — those branches don't exist in admin-common.js.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------
// Minimal DOM stub. Installed before `import await` of the module under
// test so that the module's top-level `typeof document` check sees us.
// ---------------------------------------------------------------------

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  children: FakeNode[];
  attributes: Record<string, string>;
  type?: string;
  colSpan?: number;
  listeners: Record<string, Array<() => void>>;
  appendChild(child: FakeNode): FakeNode;
  replaceChildren(): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, handler: () => void): void;
  classList: { add(name: string): void };
  // For renderTable empty-state branch — `td.colSpan = N` must be settable.
}

function makeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    className: "",
    textContent: "",
    children: [],
    attributes: {},
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren() {
      this.children = [];
    },
    remove() {
      // Body keeps a flat children list; locate-and-splice.
      const idx = (globalThis as any).document.body.children.indexOf(this);
      if (idx >= 0) (globalThis as any).document.body.children.splice(idx, 1);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, handler) {
      (this.listeners[name] ||= []).push(handler);
    },
    classList: {
      add(name: string) {
        node.className = (node.className + " " + name).trim();
      },
    },
  };
  return node;
}

let cookieStore = "";
let locationHref = "";
const installedBody = makeNode("body");

(globalThis as any).document = {
  get cookie() {
    return cookieStore;
  },
  set cookie(v: string) {
    cookieStore = v;
  },
  createElement: (tag: string) => makeNode(tag),
  body: installedBody,
};

(globalThis as any).window = {
  location: {
    href: "",
    pathname: "/dashboard/admin.html",
    search: "",
  },
};
// Mirror location on globalThis so `window.location.href = ...` works AND
// admin-common.js reading `window.location.pathname` resolves.
Object.defineProperty((globalThis as any).window.location, "href", {
  get() {
    return locationHref;
  },
  set(v: string) {
    locationHref = v;
  },
});

// Node 22 ships a read-only `navigator` getter on globalThis. We replace
// the descriptor wholesale so admin-common.js's clipboard.writeText() path
// is exercisable.
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
  configurable: true,
  writable: true,
});

// fetch is set per-test via vi.stubGlobal.

// ---------------------------------------------------------------------
// Now we can safely import the module under test. Top-level `import` is
// hoisted, so we use dynamic import to guarantee the stubs above are in
// place first.
// ---------------------------------------------------------------------

// @ts-expect-error — runtime shape only.
const mod = await import("../../dashboard/public/admin-common.js");
const {
  readCsrfToken,
  redirectToLogin,
  fetchJSON,
  mapStatusToString,
  renderTable,
  showToast,
  formatTimestamp,
  FetchError,
} = mod as {
  readCsrfToken: () => string | null;
  redirectToLogin: () => void;
  fetchJSON: (url: string, options?: RequestInit) => Promise<unknown>;
  mapStatusToString: (status: number) => string;
  renderTable: (
    tbody: FakeNode,
    rows: unknown[],
    columns: Array<{
      render?: (row: unknown) => string;
      cellBuilder?: (td: FakeNode, row: unknown) => void;
    }>,
  ) => void;
  showToast: (
    text: string,
    kind?: "success" | "error",
    opts?: { request_id?: string | null },
  ) => void;
  formatTimestamp: (iso: string) => string;
  FetchError: new (
    status: number,
    code: string | null,
    msg: string,
    reqId: string | null,
  ) => Error & {
    status: number;
    code: string | null;
    request_id: string | null;
  };
};

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("admin-common.js — readCsrfToken", () => {
  beforeEach(() => {
    cookieStore = "";
  });

  it("returns null when no cookies at all", () => {
    expect(readCsrfToken()).toBeNull();
  });

  it("returns the value when the CSRF cookie is present", () => {
    cookieStore = "__Host-coordinator_csrf=abc123";
    expect(readCsrfToken()).toBe("abc123");
  });

  it("parses correctly with multiple cookies surrounding the target", () => {
    cookieStore = "foo=bar; __Host-coordinator_csrf=tok-xyz; baz=qux";
    expect(readCsrfToken()).toBe("tok-xyz");
  });

  it("returns null when the CSRF cookie is absent but others are set", () => {
    cookieStore = "foo=bar; baz=qux";
    expect(readCsrfToken()).toBeNull();
  });

  it("tolerates missing space after ';' (RFC-violating but seen)", () => {
    cookieStore = "foo=bar;__Host-coordinator_csrf=v2";
    expect(readCsrfToken()).toBe("v2");
  });

  it("ignores malformed cookie segments without '='", () => {
    cookieStore = "broken; __Host-coordinator_csrf=ok";
    expect(readCsrfToken()).toBe("ok");
  });
});

describe("admin-common.js — redirectToLogin", () => {
  it("sets window.location.href with return_to encoded", () => {
    (globalThis as any).window.location.pathname = "/dashboard/admin-orgs.html";
    (globalThis as any).window.location.search = "?org=42";
    redirectToLogin();
    expect(locationHref).toBe(
      "/auth/login?return_to=" + encodeURIComponent("/dashboard/admin-orgs.html?org=42"),
    );
  });
});

describe("admin-common.js — mapStatusToString", () => {
  it("returns the FORBIDDEN string for 403", () => {
    expect(mapStatusToString(403)).toMatch(/Permission denied/);
  });
  it("returns the NOT_FOUND string for 404", () => {
    expect(mapStatusToString(404)).toMatch(/not found/i);
  });
  it("returns the RATE_LIMITED string for 429", () => {
    expect(mapStatusToString(429)).toMatch(/Too many requests/);
  });
  it("returns the GENERIC string for 500", () => {
    expect(mapStatusToString(500)).toMatch(/Something went wrong/);
  });
  it("returns the GENERIC fallback for an unrecognized status", () => {
    expect(mapStatusToString(418)).toMatch(/Something went wrong/);
  });
});

describe("admin-common.js — fetchJSON", () => {
  beforeEach(() => {
    cookieStore = "";
    locationHref = "";
    vi.unstubAllGlobals();
  });

  it("performs a GET with credentials: include and parses JSON", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([
        ["Content-Type", "application/json"],
        ["X-Request-Id", "rid-1"],
      ]),
      json: async () => ({ hello: "world" }),
    });
    vi.stubGlobal("fetch", fakeFetch);

    const body = await fetchJSON("/api/x");
    expect(body).toEqual({ hello: "world" });
    expect(fakeFetch).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("redirects to login when the CSRF cookie is missing on a POST", async () => {
    const fakeFetch = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);

    await expect(fetchJSON("/api/x", { method: "POST" })).rejects.toMatchObject({
      status: 401,
      code: "NO_CSRF",
    });
    expect(locationHref).toContain("/auth/login?return_to=");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("attaches X-CSRF-Token + Content-Type on POST with body", async () => {
    cookieStore = "__Host-coordinator_csrf=csrf-tok";
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["Content-Type", "application/json"]]),
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fakeFetch);

    await fetchJSON("/api/x", { method: "POST", body: JSON.stringify({ a: 1 }) });

    const [, init] = fakeFetch.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf-tok");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("does not overwrite a caller-supplied Content-Type", async () => {
    cookieStore = "__Host-coordinator_csrf=t";
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["Content-Type", "application/json"]]),
      json: async () => null,
    });
    vi.stubGlobal("fetch", fakeFetch);

    await fetchJSON("/api/x", {
      method: "PUT",
      body: "raw",
      headers: { "Content-Type": "text/plain" },
    });
    const headers = fakeFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get("Content-Type")).toBe("text/plain");
  });

  it("redirects on 401 and throws FetchError(401)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Map([["X-Request-Id", "rid-401"]]),
    });
    vi.stubGlobal("fetch", fakeFetch);

    await expect(fetchJSON("/api/x")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      request_id: "rid-401",
    });
    expect(locationHref).toContain("/auth/login");
  });

  it("throws FetchError with body.code + body.message on 4xx JSON error", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Map([
        ["Content-Type", "application/json"],
        ["X-Request-Id", "rid-409"],
      ]),
      json: async () => ({ code: "ORG_NAME_TAKEN", message: "Duplicate" }),
    });
    vi.stubGlobal("fetch", fakeFetch);

    await expect(fetchJSON("/api/x")).rejects.toMatchObject({
      status: 409,
      code: "ORG_NAME_TAKEN",
      message: "Duplicate",
      request_id: "rid-409",
    });
  });

  it("falls back to mapStatusToString when the error body is not JSON", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Map([["Content-Type", "text/html"]]),
    });
    vi.stubGlobal("fetch", fakeFetch);

    await expect(fetchJSON("/api/x")).rejects.toMatchObject({
      status: 500,
      code: null,
    });
  });

  it("tolerates JSON parse failure on an error response", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Map([["Content-Type", "application/json"]]),
      json: async () => {
        throw new Error("bad json");
      },
    });
    vi.stubGlobal("fetch", fakeFetch);
    await expect(fetchJSON("/api/x")).rejects.toMatchObject({ status: 502 });
  });

  it("returns null body when the success response is not JSON", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Map([["Content-Type", "text/plain"]]),
    });
    vi.stubGlobal("fetch", fakeFetch);
    const body = await fetchJSON("/api/x");
    expect(body).toBeNull();
  });
});

describe("admin-common.js — renderTable (V3 PATCH 15)", () => {
  it("renders one tr per row with textContent only", () => {
    const tbody = makeNode("tbody");
    renderTable(tbody, [{ name: "alpha" }, { name: "beta" }], [{ render: (r: any) => r.name }]);
    expect(tbody.children).toHaveLength(2);
    expect(tbody.children[0].children[0].textContent).toBe("alpha");
    expect(tbody.children[1].children[0].textContent).toBe("beta");
  });

  it("clears prior children before re-rendering", () => {
    const tbody = makeNode("tbody");
    tbody.children.push(makeNode("tr"), makeNode("tr"));
    renderTable(tbody, [{ x: 1 }], [{ render: (r: any) => String(r.x) }]);
    expect(tbody.children).toHaveLength(1);
  });

  it("invokes cellBuilder for interactive columns", () => {
    const tbody = makeNode("tbody");
    const builder = vi.fn((td: FakeNode) => {
      td.textContent = "built";
    });
    renderTable(tbody, [{ id: 1 }], [{ cellBuilder: builder }]);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(tbody.children[0].children[0].textContent).toBe("built");
  });

  it("emits an empty-state row when rows is empty", () => {
    const tbody = makeNode("tbody");
    renderTable(tbody, [], [{ render: () => "" }, { render: () => "" }]);
    expect(tbody.children).toHaveLength(1);
    const td = tbody.children[0].children[0];
    expect(td.colSpan).toBe(2);
    expect(td.className).toBe("empty-state");
  });

  it("defaults to colSpan=1 when columns is empty", () => {
    const tbody = makeNode("tbody");
    renderTable(tbody, [], []);
    expect(tbody.children[0].children[0].colSpan).toBe(1);
  });

  it("emits empty string when a column has neither render nor cellBuilder", () => {
    const tbody = makeNode("tbody");
    renderTable(tbody, [{ x: 1 }], [{} as any]);
    expect(tbody.children[0].children[0].textContent).toBe("");
  });
});

describe("admin-common.js — showToast (V3 PATCH 16)", () => {
  beforeEach(() => {
    installedBody.children = [];
  });

  it("appends a success toast and schedules removal", () => {
    showToast("Saved");
    expect(installedBody.children).toHaveLength(1);
    expect(installedBody.children[0].className).toContain("toast-success");
    expect(installedBody.children[0].attributes.role).toBe("status");
  });

  it("renders an error toast with the alert role", () => {
    showToast("Boom", "error");
    expect(installedBody.children[0].className).toContain("toast-error");
    expect(installedBody.children[0].attributes.role).toBe("alert");
  });

  it("includes a copy-id button when an error carries a request_id", () => {
    showToast("Boom", "error", { request_id: "rid-99" });
    const toast = installedBody.children[0];
    // Children: [msg, idLine, copyBtn]
    expect(toast.children).toHaveLength(3);
    expect(toast.children[1].textContent).toBe("request_id: rid-99");
    expect(toast.children[2].textContent).toBe("Copy id");
  });

  it("invokes navigator.clipboard.writeText when the copy button is clicked", () => {
    const writeText = (globalThis as any).navigator.clipboard.writeText;
    writeText.mockClear();
    showToast("Boom", "error", { request_id: "rid-clip" });
    const copyBtn = installedBody.children[0].children[2];
    copyBtn.listeners.click[0]();
    expect(writeText).toHaveBeenCalledWith("rid-clip");
    expect(copyBtn.textContent).toBe("Copied");
  });

  it("handles a click when clipboard API is unavailable", () => {
    const originalNav = (globalThis as any).navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      showToast("Boom", "error", { request_id: "rid-noclip" });
      const copyBtn = installedBody.children[0].children[2];
      // Should not throw.
      copyBtn.listeners.click[0]();
      expect(copyBtn.textContent).toBe("Copied");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNav,
        configurable: true,
        writable: true,
      });
    }
  });

  it("skips the copy block for success toasts even with a request_id", () => {
    showToast("Saved", "success", { request_id: "rid-ignored" });
    expect(installedBody.children[0].children).toHaveLength(1);
  });

  it("skips the copy block for errors with empty request_id", () => {
    showToast("Boom", "error", { request_id: "" });
    expect(installedBody.children[0].children).toHaveLength(1);
  });
});

describe("admin-common.js — formatTimestamp", () => {
  it("formats a SQLite-style timestamp", () => {
    const out = formatTimestamp("2026-05-19 10:30:00");
    // Locale output varies — assert non-empty and not the raw string.
    expect(out).not.toBe("");
    expect(out).not.toBe("2026-05-19 10:30:00");
  });

  it("returns the input unchanged for an unparseable string", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("returns empty string for empty input", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("returns empty string for non-string input", () => {
    // @ts-expect-error — exercising the typeof guard.
    expect(formatTimestamp(null)).toBe("");
  });

  it("passes already-ISO strings through Date parsing", () => {
    const out = formatTimestamp("2026-05-19T10:30:00Z");
    expect(out).not.toBe("");
    expect(out).not.toBe("2026-05-19T10:30:00Z");
  });
});

describe("admin-common.js — FetchError", () => {
  it("stores status / code / message / request_id", () => {
    const e = new FetchError(409, "DUPE", "Dupe row", "rid-1");
    expect(e.status).toBe(409);
    expect(e.code).toBe("DUPE");
    expect(e.message).toBe("Dupe row");
    expect(e.request_id).toBe("rid-1");
    expect(e.name).toBe("FetchError");
  });
});
