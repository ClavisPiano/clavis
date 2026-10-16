import { expect, test, type Page, type Route } from "@playwright/test";

/*
 * Account UI (T4.4). The backend is a small in-test fake that follows the T4.2 response shapes and
 * verifies nothing cryptographically. The browser side is real: a CDP virtual authenticator
 * answers the WebAuthn prompts, so `@simplewebauthn/browser` runs for real. Chromium only.
 */

// Requests must reach page.route, not a service worker.
test.use({ serviceWorkers: "block" });

const RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `ABCD-EFGH-JKLM-${String(2000 + i)}`);

const b64url = (n: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");

interface Fake {
  signedIn: boolean;
  codesLeft: number;
  credentialIds: Set<string>;
  pushes: { events: { type?: string }[] }[];
  requests: string[];
}

async function installFakeBackend(page: Page): Promise<Fake> {
  const fake: Fake = {
    signedIn: false,
    codesLeft: RECOVERY_CODES.length,
    credentialIds: new Set(),
    pushes: [],
    requests: [],
  };
  const json = (route: Route, body: unknown, status = 200): Promise<void> =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    fake.requests.push(`${req.method()} ${path}`);
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    switch (path) {
      case "/api/me":
        return fake.signedIn
          ? json(route, {
              userId: "user-1",
              passkeys: fake.credentialIds.size,
              recoveryCodesLeft: fake.codesLeft,
            })
          : json(route, { error: "unauthorized" }, 401);
      case "/api/auth/register/options":
      case "/api/auth/passkeys/options":
        return json(route, {
          challengeId: b64url(8),
          options: {
            challenge: b64url(32),
            rp: { name: "Clavis", id: "localhost" },
            user: { id: b64url(16), name: "clavis-user", displayName: "Clavis" },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            timeout: 60000,
            attestation: "none",
            excludeCredentials: [],
            authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
          },
        });
      case "/api/auth/register/verify": {
        fake.credentialIds.add((body.response as { id: string }).id);
        fake.signedIn = true;
        return json(route, { userId: "user-1", recoveryCodes: RECOVERY_CODES });
      }
      case "/api/auth/passkeys/verify": {
        if (!fake.signedIn) return json(route, { error: "unauthorized" }, 401);
        fake.credentialIds.add((body.response as { id: string }).id);
        return json(route, { userId: "user-1", passkeys: fake.credentialIds.size });
      }
      case "/api/auth/login/options":
        return json(route, {
          challengeId: b64url(8),
          options: { challenge: b64url(32), rpId: "localhost", userVerification: "preferred" },
        });
      case "/api/auth/login/verify": {
        const id = (body.response as { id: string }).id;
        if (!fake.credentialIds.has(id)) return json(route, { error: "verification_failed" }, 401);
        fake.signedIn = true;
        return json(route, { userId: "user-1" });
      }
      case "/api/auth/recovery":
        if (body.code !== RECOVERY_CODES[0]) return json(route, { error: "invalid_code" }, 401);
        fake.signedIn = true;
        fake.codesLeft -= 1;
        return json(route, { userId: "user-1", recoveryCodesLeft: fake.codesLeft });
      case "/api/auth/logout":
        fake.signedIn = false;
        return json(route, { ok: true });
      case "/api/sync/push": {
        if (!fake.signedIn) return json(route, { error: "unauthorized" }, 401);
        const events = (body.events as { type?: string }[] | undefined) ?? [];
        fake.pushes.push({ events });
        return json(route, { accepted: events.length, duplicates: 0, lastSeq: events.length });
      }
      case "/api/sync/pull":
        if (!fake.signedIn) return json(route, { error: "unauthorized" }, 401);
        return json(route, { events: [], lastSeq: 0, hasMore: false });
      default:
        return json(route, { error: "not_found" }, 404);
    }
  });
  return fake;
}

async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== "chromium", "CDP virtual authenticators are Chromium only");
});

test("sign up, confirm recovery codes, sync, sign out, sign in with the passkey", async ({
  page,
}) => {
  const fake = await installFakeBackend(page);
  await addVirtualAuthenticator(page);

  await page.goto("/settings");
  const account = page.getByTestId("account-section");
  await expect(account.getByTestId("create-account")).toBeVisible();
  await expect(account).toContainText("Your practice stays on this device");
  await expect(account.getByTestId("sign-in")).toBeVisible();
  await expect(account.getByTestId("use-recovery")).toBeVisible();

  // Sign up.
  await account.getByTestId("create-account").click();
  const codes = page.getByTestId("recovery-codes");
  await expect(codes).toBeVisible();
  for (const code of RECOVERY_CODES) await expect(codes).toContainText(code);
  // The codes cannot be dismissed until the person confirms.
  await expect(page.getByTestId("codes-done")).toBeDisabled();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("codes-download").click(),
  ]);
  expect(download.suggestedFilename()).toBe("clavis-recovery-codes.txt");
  await page.getByTestId("codes-saved").check();
  await page.getByTestId("codes-done").click();
  await expect(codes).toHaveCount(0);

  // Signed in, and the local events were pushed to be claimed.
  await expect(page.getByTestId("account-summary")).toContainText("1 passkey, 10 recovery codes");
  await expect(page.getByTestId("sync-status")).toContainText("Synced.");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync-status", "idle");
  const pushed = fake.pushes.flatMap((p) => p.events);
  expect(pushed.length).toBeGreaterThan(0);
  expect(pushed.some((e) => e.type === "device.registered")).toBe(true);

  // Sign out keeps local data and says so.
  await expect(page.getByText("Signing out keeps your practice on this device")).toBeVisible();
  await page.getByTestId("sign-out").click();
  await expect(account.getByTestId("create-account")).toBeVisible();
  await expect(page.getByTestId("account-summary")).toHaveCount(0);
  expect(fake.requests).toContain("POST /api/auth/logout");

  // Sign in with the passkey: signed in state restored and a sync runs straight away.
  const pullsBefore = fake.requests.filter((r) => r === "GET /api/sync/pull").length;
  await account.getByTestId("sign-in").click();
  await expect(page.getByTestId("account-summary")).toContainText("1 passkey, 10 recovery codes");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync-status", "idle");
  await expect
    .poll(() => fake.requests.filter((r) => r === "GET /api/sync/pull").length)
    .toBeGreaterThan(pullsBefore);

  // A reload restores the session from /api/me.
  await page.reload();
  await expect(page.getByTestId("account-summary")).toContainText("1 passkey");
});

test("adding a passkey raises the count", async ({ page }) => {
  await installFakeBackend(page);
  await addVirtualAuthenticator(page);
  await page.goto("/settings");
  await page.getByTestId("create-account").click();
  await page.getByTestId("codes-saved").check();
  await page.getByTestId("codes-done").click();
  await expect(page.getByTestId("account-summary")).toContainText("1 passkey");
  await expect(page.getByText(/add a passkey on another device/i)).toBeVisible();
  await page.getByTestId("add-passkey").click();
  await expect(page.getByTestId("account-summary")).toContainText("2 passkeys");
});

test("recovery code sign in prompts to add a passkey on this device", async ({ page }) => {
  const fake = await installFakeBackend(page);
  fake.credentialIds.add("passkey-on-another-device");
  await addVirtualAuthenticator(page);
  await page.goto("/settings");
  await page.getByTestId("use-recovery").click();
  await page.getByTestId("recovery-input").fill("WRONG-CODE");
  await page.getByTestId("recovery-submit").click();
  await expect(page.getByTestId("account-error")).toContainText("not accepted");
  await page.getByTestId("recovery-input").fill(RECOVERY_CODES[0] ?? "");
  await page.getByTestId("recovery-submit").click();
  await expect(page.getByTestId("account-summary")).toContainText("9 recovery codes left");
  await expect(page.getByTestId("suggest-passkey")).toBeVisible();
  await page.getByTestId("add-passkey").click();
  await expect(page.getByTestId("account-summary")).toContainText("2 passkeys");
  await expect(page.getByTestId("suggest-passkey")).toHaveCount(0);
});

test("a browser without WebAuthn explains passkeys are not supported", async ({ page }) => {
  await installFakeBackend(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
  });
  await page.goto("/settings");
  await expect(page.getByTestId("passkeys-unsupported")).toContainText(
    "Passkeys are not supported on this browser",
  );
  await expect(page.getByTestId("create-account")).toBeDisabled();
  await expect(page.getByTestId("sign-in")).toBeDisabled();
});
