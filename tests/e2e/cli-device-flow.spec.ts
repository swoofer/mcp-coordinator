import { coordinatorFixture, expect } from "./helpers/coordinator-fixture.js";

/**
 * Scenario 2 (T39): CLI device flow + browser approval.
 *
 *   1. CLI calls POST /api/auth/oauth/device_authorization → user_code + device_code.
 *   2. Browser signs in via /auth/login (becomes bootstrap admin).
 *   3. Browser visits /auth/device/confirm?user_code=XXXX-XXXX → consent page
 *      with CSRF token in cookie + form field.
 *   4. Browser submits the approve form → 302 /auth/success.
 *   5. CLI polls POST /api/auth/oauth/token with grant_type=device_code →
 *      200 with access_token + refresh_token.
 *
 * We approve BEFORE polling so the first poll returns 200 (last_polled_at
 * IS NULL → no slow_down delay). This keeps the test under 1s instead of
 * the 5s default polling interval.
 *
 * The "CLI" is a `fetch()` loop here — exercising a real subprocess isn't
 * the point; the wire-level interaction is.
 */

const test = coordinatorFixture;

test("device flow: init -> browser approve -> CLI poll -> tokens", async ({
  page,
  coordinatorUrl,
}) => {
  // (1) CLI initialises the device flow.
  const initResp = await fetch(`${coordinatorUrl}/api/auth/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "client_id=test-client",
  });
  expect(initResp.status).toBe(200);
  const init = (await initResp.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  expect(init.device_code).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(init.user_code).toMatch(/^[A-Z0-9-]+$/);

  // (2) Browser logs in (auto-becomes admin in fresh DB).
  await page.goto(`${coordinatorUrl}/auth/login`);
  await expect(page).toHaveURL(/\/auth\/success/);

  // (3) Visit the confirm page. This sets __Host-coordinator_csrf (non-HttpOnly)
  // and renders a form with the same value in a hidden _csrf field. Locator
  // grabs the value Playwright sees on the rendered page so the double-submit
  // pair matches exactly.
  await page.goto(`${coordinatorUrl}/auth/device/confirm?user_code=${encodeURIComponent(init.user_code)}`);
  await expect(page.locator("h1")).toContainText("Confirm sign-in");

  // (4) Tick acknowledge then submit. The form's `action` button has
  // value="approve"; clicking the submit element posts the form with that
  // value (CSRF + user_code travel as hidden inputs).
  await page.locator('input[name="acknowledge"]').check();
  await page.locator('button[name="action"][value="approve"]').click();
  await expect(page).toHaveURL(/\/auth\/success/);

  // (5) CLI poll. last_polled_at is still NULL (we haven't polled yet),
  // so this single request returns 200 with the token pair.
  const tokenResp = await fetch(`${coordinatorUrl}/api/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: init.device_code,
    }).toString(),
  });
  expect(tokenResp.status).toBe(200);
  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  expect(tokens.token_type).toBe("Bearer");
  expect(tokens.expires_in).toBeGreaterThan(0);
});
