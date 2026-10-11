/**
 * End-to-end: two browser contexts (A and B) against a real relay (wrangler dev) and the Vite app.
 * Passkeys work headlessly through Chrome DevTools' virtual authenticator (CDP WebAuthn domain).
 *
 *   1. Onboarding on both: identity, passkey, prekeys.
 *   2. Direct share A → B: B opens the claim link, both show the same check code, A approves with its passkey,
 *      B downloads and the saved bytes equal the original exactly.
 *   3. Pairing A ↔ B with matching check codes, then a Paired send A → B through the mailbox (B offline),
 *      opened from B's inbox with exact bytes.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const APP = process.env["SEALED_E2E_APP_URL"] ?? "http://localhost:5173";

async function virtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function newDevice(browser: import("@playwright/test").Browser, label: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: APP, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[${label}] pageerror:`, e.message));
  await virtualAuthenticator(context, page);
  return { context, page };
}

async function onboard(page: Page, label: string): Promise<void> {
  await page.goto("/welcome");
  await page.getByTestId("device-label").fill(label);
  await page.getByTestId("create-identity").click();
  await page.getByTestId("confirm-create").click();
  await page.getByTestId("register-passkey").click();
  // Paper key step: create one to exercise the flow, confirm it was written down.
  await expect(page.getByTestId("create-paper-key")).toBeVisible();
  await page.getByTestId("create-paper-key").click();
  await expect(page.getByTestId("paper-key")).toBeVisible();
  await page.getByLabel("I have printed or written it down").check();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("finish-onboarding").click();
  await expect(page.getByTestId("action-share")).toBeVisible();
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function saveDownload(page: Page, testId: string): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).click()]);
  const path = await download.path();
  if (!path) throw new Error("download has no path");
  return readFileSync(path);
}

test.describe.serial("Sealed web client against a local relay", () => {
  let A: { context: BrowserContext; page: Page };
  let B: { context: BrowserContext; page: Page };

  test.beforeAll(async ({ browser }) => {
    A = await newDevice(browser, "A");
    B = await newDevice(browser, "B");
  });

  test.afterAll(async () => {
    await A?.context.close();
    await B?.context.close();
  });

  test("onboarding creates identities with passkeys and prekeys on both devices", async () => {
    await onboard(A.page, "Alice laptop");
    await onboard(B.page, "Bob phone");
    for (const { page } of [A, B]) {
      await page.goto("/devices");
      await expect(page.getByTestId("device-row")).toHaveCount(1);
      await expect(page.getByText(/one-time prekeys on the relay/)).toBeVisible();
    }
  });

  test("Direct share: B claims, check codes match, A approves with a passkey, B gets the exact bytes", async () => {
    const payload = randomBytes(2 * 1024 * 1024 + 12345);
    await A.page.goto("/share");
    await A.page.getByTestId("file-input").setInputFiles({ name: "report.bin", mimeType: "application/octet-stream", buffer: payload });
    await A.page.getByTestId("start-share").click();
    const code = await A.page.getByTestId("share-code").getAttribute("data-code");
    expect(code).toMatch(/\/c\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{22}$/);
    await expect(A.page.getByText("Encrypted and uploaded")).toBeVisible();

    // B opens the link as a phone camera app would.
    await B.page.goto(code!);
    const receiverSas = (await B.page.getByTestId("receiver-sas").textContent())?.trim();
    expect(receiverSas).toMatch(/^\d{3} \d{3}$/);
    // The fragment (claim secret) is removed from the address bar once read.
    expect(new URL(B.page.url()).hash).toBe("");

    const row = A.page.getByTestId("claim-row");
    await expect(row).toContainText("Bob phone");
    await expect(row).toContainText("browser key");
    const senderSas = (await A.page.getByTestId("sender-sas").textContent())?.trim();
    expect(senderSas).toBe(receiverSas);

    await A.page.getByTestId("approve").click();
    await expect(B.page.getByTestId("claim-done")).toBeVisible();
    const received = await saveDownload(B.page, "save-0");
    expect(received.length).toBe(payload.length);
    expect(sha256(received)).toBe(sha256(payload));
    await expect(A.page.locator('[data-claim-status="downloaded"]')).toHaveCount(1);
  });

  test("a replayed claim link is refused", async () => {
    // Open a new share and claim it from B, then try the same link from a third, fresh context.
    await A.page.goto("/share");
    await A.page.getByTestId("file-input").setInputFiles({ name: "once.txt", mimeType: "text/plain", buffer: Buffer.from("one claim only") });
    await A.page.getByTestId("start-share").click();
    const code = (await A.page.getByTestId("share-code").getAttribute("data-code"))!;
    await B.page.goto(code);
    await expect(B.page.getByTestId("receiver-sas")).toBeVisible();
    const third = await B.context.browser()!.newContext({ baseURL: APP });
    const p = await third.newPage();
    await p.goto(code);
    await expect(p.getByTestId("claim-ended")).toContainText("Someone already scanned this code");
    await third.close();
    // A denies B's pending claim; B sees the denial.
    await A.page.getByTestId("deny").click();
    await expect(B.page.getByTestId("claim-ended")).toContainText("The sender declined");
  });

  test("pairing: both scan each other, check codes match, contacts saved", async () => {
    await A.page.goto("/pair");
    await B.page.goto("/pair");
    const codeA = (await A.page.getByTestId("pairing-code").getAttribute("data-code"))!;
    const codeB = (await B.page.getByTestId("pairing-code").getAttribute("data-code"))!;
    // "Scan" through the paste field (same handler as the camera).
    for (const [page, other] of [
      [A.page, codeB],
      [B.page, codeA],
    ] as const) {
      await page.getByTestId("pair-scan-tab").click();
      await page.getByTestId("paste-code").fill(other);
      await page.getByRole("button", { name: "Use this code" }).click();
    }
    const sasA = (await A.page.getByTestId("pair-sas").textContent())?.trim();
    const sasB = (await B.page.getByTestId("pair-sas").textContent())?.trim();
    expect(sasA).toMatch(/^\d{3} \d{3}$/);
    expect(sasA).toBe(sasB);
    await A.page.getByTestId("contact-name").fill("Bob");
    await A.page.getByTestId("confirm-pair").click();
    await B.page.getByTestId("contact-name").fill("Alice");
    await B.page.getByTestId("confirm-pair").click();
    await expect(A.page.getByTestId("contact-row")).toContainText("Bob");
    await expect(B.page.getByTestId("contact-row")).toContainText("Alice");
  });

  test("Paired send via mailbox: B offline, A sends, B opens it from the inbox with exact bytes", async () => {
    // Take B offline (no presence socket) so delivery is stored, not live.
    await B.page.goto("about:blank");
    const payload = randomBytes(1_500_000);
    const small = Buffer.from("second file in the same delivery");
    await A.page.goto("/contacts");
    await A.page.getByTestId("send-to-contact").click();
    await A.page.getByTestId("file-input").setInputFiles([
      { name: "photo.raw", mimeType: "application/octet-stream", buffer: payload },
      { name: "note.txt", mimeType: "text/plain", buffer: small },
    ]);
    await A.page.getByTestId("send-contact").click();
    await expect(A.page.getByTestId("send-contact-done")).toContainText("inbox");

    await B.page.goto("/inbox");
    const item = B.page.getByTestId("inbox-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Alice");
    await B.page.getByTestId("open-inbox-item").click();
    await expect(B.page.getByTestId("inbox-opened")).toBeVisible();
    const first = await saveDownload(B.page, "save-0");
    const second = await saveDownload(B.page, "save-1");
    expect(sha256(first)).toBe(sha256(payload));
    expect(second.toString()).toBe(small.toString());
    // Opening acknowledges the delivery: a refresh leaves the inbox empty.
    await B.page.getByRole("button", { name: "Refresh" }).click();
    await expect(B.page.getByTestId("inbox-item")).toHaveCount(0);
  });

  test("Paired send live: B online, transfer runs over WebRTC and arrives in B's inbox", async () => {
    await B.page.goto("/inbox");
    await expect(B.page.getByText("Connected — new deliveries appear here automatically.")).toBeVisible();
    const payload = randomBytes(600_000);
    await A.page.goto("/contacts");
    // Wait for presence to report B online.
    await expect(A.page.getByTestId("contact-row")).toContainText("1 online");
    await A.page.getByTestId("send-to-contact").click();
    await A.page.getByTestId("file-input").setInputFiles({ name: "live.bin", mimeType: "application/octet-stream", buffer: payload });
    await A.page.getByTestId("send-contact").click();
    await expect(A.page.getByTestId("send-contact-done")).toContainText("Delivered directly");
    const live = B.page.getByTestId("live-item");
    await expect(live).toContainText("received");
    const got = await saveDownload(B.page, "save-0");
    expect(sha256(got)).toBe(sha256(payload));
    // Nothing was stored on the relay for a live transfer.
    await B.page.getByRole("button", { name: "Refresh" }).click();
    await expect(B.page.getByTestId("inbox-item")).toHaveCount(0);
  });

  test("Paired live falls back to stored delivery when WebRTC cannot connect", async () => {
    // B stays online (presence says 1 device), but B's page cannot create peer connections, so no answer comes.
    await B.page.addInitScript(() => {
      Object.defineProperty(window, "RTCPeerConnection", { value: undefined, configurable: true });
    });
    await B.page.goto("/inbox");
    await expect(B.page.getByText("Connected — new deliveries appear here automatically.")).toBeVisible();
    const payload = randomBytes(300_000);
    await A.page.goto("/contacts");
    await expect(A.page.getByTestId("contact-row")).toContainText("1 online");
    await A.page.getByTestId("send-to-contact").click();
    await A.page.getByTestId("file-input").setInputFiles({ name: "fallback.bin", mimeType: "application/octet-stream", buffer: payload });
    const started = Date.now();
    await A.page.getByTestId("send-contact").click();
    await expect(A.page.getByText(/Switching to stored delivery/)).toBeVisible({ timeout: 40_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
    await expect(A.page.getByTestId("send-contact-done")).toContainText("inbox");
    // The mailbox nudge on B's presence socket refreshes the inbox without a manual refresh.
    await expect(B.page.getByTestId("inbox-item")).toHaveCount(1);
    await B.page.getByTestId("open-inbox-item").click();
    const got = await saveDownload(B.page, "save-0");
    expect(sha256(got)).toBe(sha256(payload));
  });

  test("Room: two devices join with their own check codes, batch approval approves both, one is revoked", async ({ browser }) => {
    const payload = randomBytes(200_000);
    await A.page.goto("/share");
    await A.page.getByTestId("file-input").setInputFiles({ name: "slides.bin", mimeType: "application/octet-stream", buffer: payload });
    await A.page.getByTestId("room-toggle").check();
    await A.page.getByLabel("Approve in batches").check();
    await A.page.getByTestId("start-share").click();
    const code = (await A.page.getByTestId("share-code").getAttribute("data-code"))!;
    await expect(A.page.getByText("Encrypted and uploaded")).toBeVisible();

    const r1 = await browser.newContext({ baseURL: APP, acceptDownloads: true });
    const r2 = await browser.newContext({ baseURL: APP, acceptDownloads: true });
    const p1 = await r1.newPage();
    const p2 = await r2.newPage();
    await p1.goto(code);
    await p2.goto(code);
    await expect(p1.getByTestId("receiver-sas")).toBeVisible();
    await expect(p2.getByTestId("receiver-sas")).toBeVisible();
    await expect(A.page.getByTestId("claim-row")).toHaveCount(2);
    // Each joined device has its own check code (bound to its own key).
    const sas = await A.page.getByTestId("sender-sas").allTextContents();
    const mine = [(await p1.getByTestId("receiver-sas").textContent())!.trim(), (await p2.getByTestId("receiver-sas").textContent())!.trim()];
    expect(sas.map((x) => x.trim()).sort()).toEqual([...mine].sort());

    await A.page.getByTestId("approve-all").click();
    await expect(p1.getByTestId("claim-done")).toBeVisible();
    await expect(p2.getByTestId("claim-done")).toBeVisible();
    expect(sha256(await saveDownload(p1, "save-0"))).toBe(sha256(payload));
    expect(sha256(await saveDownload(p2, "save-0"))).toBe(sha256(payload));
    await expect(A.page.locator('[data-claim-status="downloaded"]')).toHaveCount(2);
    await A.page.getByRole("button", { name: "Revoke" }).first().click();
    await expect(A.page.locator('[data-claim-status="revoked"]')).toHaveCount(1);
    await r1.close();
    await r2.close();
  });
});

test("a code made by another Sealed client origin asks to trust it, then routes; Settings lists it", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: APP });
  const page = await context.newPage();
  const b64u = (b: Buffer) => b.toString("base64url");
  const foreign = `https://phone-origin.example/c/${b64u(randomBytes(16))}#${b64u(randomBytes(16))}`;
  await page.goto("/receive");
  await page.getByTestId("paste-code").fill(foreign);
  await page.getByRole("button", { name: "Use this code" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("https://phone-origin.example");
  await page.getByTestId("trust-origin").click();
  // Routed to the claim screen; the transfer does not exist on this relay, so the claim ends cleanly.
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByTestId("claim-ended")).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("list", { name: "Trusted origins" })).toContainText("https://phone-origin.example");
  await context.close();
});
