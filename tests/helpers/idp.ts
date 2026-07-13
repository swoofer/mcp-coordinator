import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer, type SetupServer } from "msw/node";

export type { SetupServer } from "msw/node";

/**
 * Default endpoints match GitHub.com. Tests can override via authBaseUrl
 * (token endpoint host) and apiBaseUrl (user/emails/orgs host) when
 * exercising GHES code paths.
 */
const DEFAULT_AUTH_BASE = "https://github.com";
const DEFAULT_API_BASE = "https://api.github.com";

export type IdpEndpoint = "token" | "user" | "emails" | "orgs";

interface ResponseSpec {
  body: JsonBodyType;
  status: number;
}

interface FailureSpec {
  remaining: number;
  status: number;
}

/**
 * Minimal msw facade for GitHub IdP mocking. Tests build up a handler set
 * via the fluent methods, then call apply(server) to install them on a
 * shared SetupServer.
 *
 * Per V2 §B T38: full chained API (e.g. `.delay(ms)`) is documented as TODO
 * pending T16/T17/T19c needs; current surface covers happy-path + N-failure
 * scenarios used by foreseeable integration tests.
 */
export interface MockIdpHandlers {
  respondTokenWith(body: object, status?: number): MockIdpHandlers;
  respondUserWith(body: object, status?: number): MockIdpHandlers;
  respondEmailsWith(body: object, status?: number): MockIdpHandlers;
  respondOrgsWith(body: object, status?: number): MockIdpHandlers;
  failNextN(endpoint: IdpEndpoint, n: number, status: number): MockIdpHandlers;
  apply(server: SetupServer): void;
}

function defaultsFor(endpoint: IdpEndpoint): ResponseSpec {
  switch (endpoint) {
    case "token":
      return { body: { access_token: "tok-default", token_type: "bearer" }, status: 200 };
    case "user":
      return {
        body: { id: 1, login: "default-user", email: "default@example.com", name: "Default" },
        status: 200,
      };
    case "emails":
      return {
        body: [{ email: "default@example.com", primary: true, verified: true }],
        status: 200,
      };
    case "orgs":
      return { body: [], status: 200 };
  }
}

export function createMockIdp(
  opts: { authBaseUrl?: string; apiBaseUrl?: string } = {},
): MockIdpHandlers {
  const authBase = opts.authBaseUrl ?? DEFAULT_AUTH_BASE;
  const apiBase = opts.apiBaseUrl ?? DEFAULT_API_BASE;

  const responses: Record<IdpEndpoint, ResponseSpec> = {
    token: defaultsFor("token"),
    user: defaultsFor("user"),
    emails: defaultsFor("emails"),
    orgs: defaultsFor("orgs"),
  };
  const failures: Record<IdpEndpoint, FailureSpec | null> = {
    token: null,
    user: null,
    emails: null,
    orgs: null,
  };

  function consumeFailure(endpoint: IdpEndpoint): ResponseSpec | null {
    const f = failures[endpoint];
    if (!f) return null;
    f.remaining -= 1;
    if (f.remaining <= 0) failures[endpoint] = null;
    return { body: { error: `simulated_${f.status}` }, status: f.status };
  }

  const facade: MockIdpHandlers = {
    respondTokenWith(body, status = 200) {
      responses.token = { body, status };
      return facade;
    },
    respondUserWith(body, status = 200) {
      responses.user = { body, status };
      return facade;
    },
    respondEmailsWith(body, status = 200) {
      responses.emails = { body, status };
      return facade;
    },
    respondOrgsWith(body, status = 200) {
      responses.orgs = { body, status };
      return facade;
    },
    failNextN(endpoint, n, status) {
      failures[endpoint] = { remaining: n, status };
      return facade;
    },
    apply(server: SetupServer) {
      server.use(
        http.post(`${authBase}/login/oauth/access_token`, () => {
          const fail = consumeFailure("token");
          if (fail) return HttpResponse.json(fail.body, { status: fail.status });
          return HttpResponse.json(responses.token.body, { status: responses.token.status });
        }),
        http.get(`${apiBase}/user`, () => {
          const fail = consumeFailure("user");
          if (fail) return HttpResponse.json(fail.body, { status: fail.status });
          return HttpResponse.json(responses.user.body, { status: responses.user.status });
        }),
        http.get(`${apiBase}/user/emails`, () => {
          const fail = consumeFailure("emails");
          if (fail) return HttpResponse.json(fail.body, { status: fail.status });
          return HttpResponse.json(responses.emails.body, { status: responses.emails.status });
        }),
        http.get(`${apiBase}/user/orgs`, () => {
          const fail = consumeFailure("orgs");
          if (fail) return HttpResponse.json(fail.body, { status: fail.status });
          return HttpResponse.json(responses.orgs.body, { status: responses.orgs.status });
        }),
      );
    },
  };
  return facade;
}

/**
 * Returns a fresh msw server. Caller is responsible for listen/reset/close
 * lifecycle inside the describe block (matches tests/unit/github-provider.test.ts
 * pattern). Returning the bare server keeps the helper lifecycle-agnostic.
 */
export function setupGitHubMsw(): SetupServer {
  return setupServer();
}
