import { coordinatorFixture, expect } from "./helpers/coordinator-fixture.js";

/**
 * Scenario 3 (T39): refresh flow on 401.
 *
 * Per the V2 §B T39 scope memo, this scenario is reduced to pure HTTP — the
 * SDK integration (auto-refresh wiring) is deferred to T39b. We verify the
 * BACKEND contract the SDK depends on:
 *
 *   1. Obtain a real access/refresh pair via the device flow (Scenario 2 path).
 *   2. Call /api/auth/me with a garbage Bearer → 401 + WWW-Authenticate.
 *   3. POST /api/auth/oauth/token with grant_type=refresh_token → 200 with a
 *      new access_token (and rotated refresh_token).
 *   4. Call /api/auth/me with the new access token → 200.
 */

const test = coordinatorFixture;

async function obtainTokensViaDeviceFlow(
  coordinatorUrl: string,
  page: import("@playwright/test").Page,
): Promise<{ access_token: string; refresh_token: string }> {
  const initResp = await fetch(`${coordinatorUrl}/api/auth/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "client_id=test-client",
  });
  const init = (await initResp.json()) as { device_code: string; user_code: string };

  // Bootstrap admin login + approve form.
  await page.goto(`${coordinatorUrl}/auth/login`);
  await expect(page).toHaveURL(/\/auth\/success/);
  await page.goto(`${coordinatorUrl}/auth/device/confirm?user_code=${encodeURIComponent(init.user_code)}`);
  await page.locator('input[name="acknowledge"]').check();
  await page.locator('button[name="action"][value="approve"]').click();
  await expect(page).toHaveURL(/\/auth\/success/);

  const tokenResp = await fetch(`${coordinatorUrl}/api/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: init.device_code,
    }).toString(),
  });
  expect(tokenResp.status).toBe(200);
  return (await tokenResp.json()) as { access_token: string; refresh_token: string };
}

test("refresh grant: bad bearer 401 -> refresh -> new bearer 200", async ({
  page,
  coordinatorUrl,
}) => {
  const tokens = await obtainTokensViaDeviceFlow(coordinatorUrl, page);
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();

  // (1) Garbage Bearer -> 401 with WWW-Authenticate per RFC 6750.
  const badResp = await fetch(`${coordinatorUrl}/api/auth/me`, {
    headers: { Authorization: "Bearer not-a-real-jwt.signature.here" },
  });
  expect(badResp.status).toBe(401);
  expect(badResp.headers.get("www-authenticate")).toMatch(/Bearer/i);

  // (2) Refresh grant -> 200 with new tokens.
  const refreshResp = await fetch(`${coordinatorUrl}/api/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }).toString(),
  });
  expect(refreshResp.status).toBe(200);
  const refreshed = (await refreshResp.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  expect(refreshed.access_token).toBeTruthy();
  expect(refreshed.access_token).not.toBe(tokens.access_token);
  expect(refreshed.refresh_token).toBeTruthy();
  expect(refreshed.token_type).toBe("Bearer");

  // (3) New access token authorises /api/auth/me.
  const goodResp = await fetch(`${coordinatorUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${refreshed.access_token}` },
  });
  expect(goodResp.status).toBe(200);
  const me = (await goodResp.json()) as { email: string; role: string };
  expect(me.email).toBe("test@example.com");
  expect(me.role).toBe("admin");
});
