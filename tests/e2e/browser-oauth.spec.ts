import { coordinatorFixture, expect } from "./helpers/coordinator-fixture.js";

/**
 * Scenario 1 (T39): browser OAuth flow.
 *
 *   1. Visit /auth/login → 302 to mock GitHub /login/oauth/authorize.
 *   2. Mock auto-approves → 302 back to /api/auth/oauth/callback?code+state.
 *   3. Callback exchanges code with mock, mints JWT, sets HttpOnly session
 *      cookie, 302 to /auth/success.
 *   4. Subsequent /api/auth/me returns the bootstrapped user.
 *
 * Three cases:
 *   - happy path: lands on /auth/success and /me returns admin user
 *   - not-in-allowlist: callback 403s (no redirect to success)
 *   - logout: clears session cookie; /me 401s afterwards
 */

const test = coordinatorFixture;

test.describe("browser OAuth flow", () => {
  test("happy path: login -> callback -> success -> /me", async ({
    page,
    coordinatorUrl,
  }) => {
    await page.goto(`${coordinatorUrl}/auth/login`);
    await expect(page).toHaveURL(/\/auth\/success/);
    await expect(page.locator("h1")).toContainText("signed in");

    // Session cookie set by the callback should authorize /api/auth/me.
    const meResponse = await page.request.get(`${coordinatorUrl}/api/auth/me`);
    expect(meResponse.status()).toBe(200);
    const me = await meResponse.json();
    expect(me.email).toBe("test@example.com");
    // First user provisioned in a fresh DB is auto-promoted to admin
    // (src/auth/oauth-finalize.ts bootstrap-admin check).
    expect(me.role).toBe("admin");
    expect(me.org.name).toBe("acme");
  });

  test("user not in any allowlisted org -> 403", async ({
    page,
    coordinatorUrl,
    mockGithub,
  }) => {
    mockGithub.setMembershipsResponse([{ login: "wrong-org" }]);

    // The /auth/login -> mock /authorize -> /api/auth/oauth/callback chain
    // ends at the callback because the callback returns 403 JSON (not a
    // redirect). We capture the callback's status off the navigation.
    const responsePromise = page.waitForResponse((r) =>
      r.url().includes("/api/auth/oauth/callback"),
    );
    await page.goto(`${coordinatorUrl}/auth/login`);
    const callbackResp = await responsePromise;
    expect(callbackResp.status()).toBe(403);

    // appError envelope is flat: { code, message, request_id } per
    // src/http/response-contract.ts. Not wrapped under `error`.
    const body = await callbackResp.json();
    expect(body.code).toBe("NOT_IN_ALLOWLIST");
  });

  test("logout clears session and /me returns 401", async ({
    page,
    coordinatorUrl,
  }) => {
    await page.goto(`${coordinatorUrl}/auth/login`);
    await expect(page).toHaveURL(/\/auth\/success/);

    const logoutResp = await page.request.post(`${coordinatorUrl}/api/auth/logout`);
    expect(logoutResp.status()).toBe(204);

    // Cookie cleared (Max-Age=0). The browser will not send it on the next
    // request; /me must reject with 401.
    const meResp = await page.request.get(`${coordinatorUrl}/api/auth/me`);
    expect(meResp.status()).toBe(401);
  });
});
