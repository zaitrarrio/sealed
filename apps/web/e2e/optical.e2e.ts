/**
 * Optical receive in a real browser: Chromium's fake camera plays a raw Y4M of Facet frames produced by core's
 * FacetSender for the reverse key code the receiver page displays. Exercises the capture page, the decode worker
 * (MediaStreamTrackProcessor → OffscreenCanvas → FacetReceiver), the Air-gap check code, unwrap with the
 * browser's non-extractable device key, and saving the exact bytes. Also a Broadcast receive, unsigned.
 */
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { SoftwareAgreementKey, airgapSas, createReverseKeyOffer, parseCode, prepareAirgapStream, prepareBenchmarkStream, prepareBroadcastStream } from "@sealed/core";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeQrY4m } from "./qr-y4m";
import { writeFacetY4m } from "./y4m";

const APP = process.env["SEALED_E2E_APP_URL"] ?? "http://localhost:5173";
const W = 1280;
const H = 720;
const CODE_PX = 696; // 116 cells × 6 px (spec §7.2 minimum display size)

let dir: string;
let video: string;
let browser: Browser;

function sha256(b: Buffer | Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

async function saveDownload(page: Page, testId: string): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).click()]);
  return readFileSync((await download.path())!);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sealed-optical-"));
  video = join(dir, "camera.y4m");
  // Chromium opens the file when getUserMedia starts, so a placeholder is enough at launch.
  writeFileSync(video, `YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
  });
});

test.afterAll(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Air-gap receive: reverse key code → Facet stream on the camera → check code → exact bytes", async () => {
  const context = await browser.newContext({ baseURL: APP, acceptDownloads: true, permissions: ["camera"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto("/offline/receive");
  const code = (await page.getByTestId("reverse-key-code").getAttribute("data-code"))!;
  const rk = parseCode(code);
  if (rk.kind !== "reverse-key") throw new Error("expected a reverse key code");

  const payload = randomBytes(30_000);
  const { sender, sas } = await prepareAirgapStream({ files: [{ path: "airgap.bin", mediaType: "application/octet-stream", size: payload.length, data: new Uint8Array(payload) }], reverseKey: rk, senderLabel: "Optical sender", tier: 1 });
  const frames = writeFacetY4m(video, sender, { width: W, height: H, codePx: CODE_PX, frames: 400, fps: 10 });
  expect(frames).toBeGreaterThan(10);
  expect(airgapSas(rk.nonce, sender.streamId, rk.receiverPublicKey, sender.descriptor.senderPublicKey!)).toBe(sas);

  await page.getByTestId("start-capture").click();
  await expect(page.getByTestId("airgap-receiver-sas")).toHaveText(sas, { timeout: 60_000 });
  await expect(page.getByTestId("airgap-done")).toBeVisible({ timeout: 120_000 });
  const got = await saveDownload(page, "save-0");
  expect(sha256(got)).toBe(sha256(payload));
  await context.close();
});

test("Broadcast receive: looping open stream decodes and is labeled unsigned", async () => {
  const context = await browser.newContext({ baseURL: APP, acceptDownloads: true, permissions: ["camera"] });
  const page = await context.newPage();
  const payload = randomBytes(12_000);
  const { sender } = await prepareBroadcastStream({ files: [{ path: "map.bin", mediaType: "application/octet-stream", size: payload.length, data: new Uint8Array(payload) }], tier: 0 });
  writeFacetY4m(video, sender, { width: W, height: H, codePx: CODE_PX, frames: 300, fps: 10 });
  await page.goto("/broadcast/receive");
  await expect(page.getByTestId("broadcast-done")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Unsigned broadcast")).toBeVisible();
  const got = await saveDownload(page, "save-0");
  expect(sha256(got)).toBe(sha256(payload));
  await context.close();
});

test("Benchmark: filming a test stream reports progress and verifies the bytes", async () => {
  const context = await browser.newContext({ baseURL: APP, permissions: ["camera"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  const { sender, size } = await prepareBenchmarkStream({ size: 16 * 1024, tier: 0, seed: 77 });
  writeFacetY4m(video, sender, { width: W, height: H, codePx: CODE_PX, frames: 300, fps: 10 });
  await page.goto("/bench");
  await page.getByTestId("bench-film").click();
  const report = page.getByTestId("bench-report");
  await expect(report).toHaveAttribute("data-stage", "verified", { timeout: 120_000 });
  await expect(report).toContainText(`payload         ${(size / 1024).toFixed(1)} KB`);
  await expect(report).toContainText("verified        yes");
  await context.close();
});

test("Air-gap send: the app scans a reverse key code, shows the check code and streams frames a receiver decodes", async () => {
  const context = await browser.newContext({ baseURL: APP, acceptDownloads: true, viewport: { width: 1280, height: 720 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  const coreUrl = `/@fs${new URL("../../../packages/core/src/index.ts", import.meta.url).pathname}`;
  // The receiver: a software key generated here, recreated inside the page for decoding.
  const rxKey = new SoftwareAgreementKey();
  const offer = createReverseKeyOffer(APP, { agreement: rxKey }, "Test receiver", 1);
  const rk = offer.code;
  const rxSecret = Buffer.from(rxKey.secretKey).toString("hex");
  const rxNonce = Buffer.from(offer.nonce).toString("hex");

  await page.goto("/offline/send");
  await page.getByTestId("paste-code").fill(rk);
  await page.getByRole("button", { name: "Use this code" }).click();
  const payload = randomBytes(20_000);
  // Filming the key code and choosing files is all it takes: encryption and streaming start by themselves.
  await page.getByTestId("file-input").setInputFiles({ name: "sent.bin", mimeType: "application/octet-stream", buffer: payload });
  const sas = (await page.getByTestId("airgap-sender-sas").textContent())!.trim();
  expect(sas).toMatch(/^\d{3} \d{3}$/);

  // Install the in-page receiver before the stream starts: it samples the canvas once per animation frame.
  await page.evaluate(async ({ url, secret, nonce }) => {
    const core = await import(/* @vite-ignore */ url);
    const w = window as unknown as { __rx: { key: unknown; nonce: Uint8Array; done?: Promise<unknown> } };
    w.__rx = { key: new core.SoftwareAgreementKey(core.fromHex(secret)), nonce: core.fromHex(nonce) };
    const receiver = new core.FacetReceiver();
    w.__rx.done = new Promise((resolve, reject) => {
      let last = -1;
      const tick = () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="facet-canvas"]');
        if (canvas && canvas.width > 0) {
          const ctx = canvas.getContext("2d")!;
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let h = 0;
          for (let i = 0; i < img.data.length; i += 997) h = (h * 31 + img.data[i]!) | 0;
          if (h !== last) {
            last = h;
            const p = receiver.push({ width: img.width, height: img.height, data: img.data }, performance.now());
            if (p.complete) {
              const sasOut = core.airgapReceiverSas(receiver, w.__rx.nonce, (w.__rx.key as { publicKey: Uint8Array }).publicKey);
              core
                .openOpticalEnvelope(receiver, { device: { agreement: w.__rx.key, signing: w.__rx.key } })
                .then(async (opened: { files: { entry: { path: string }; data: Uint8Array }[] }) => {
                  const f = opened.files[0]!;
                  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(f.data)));
                  resolve({ sas: sasOut, path: f.entry.path, sha: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") });
                }, reject);
              return;
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, { url: coreUrl, secret: rxSecret, nonce: rxNonce });

  await expect(page.getByTestId("facet-canvas")).toBeVisible();
  const result = (await page.evaluate(() => (window as unknown as { __rx: { done: Promise<unknown> } }).__rx.done)) as { sas: string; path: string; sha: string };
  expect(result.sas).toBe(sas);
  expect(result.path).toBe("sent.bin");
  expect(result.sha).toBe(sha256(payload));
  await page.getByTestId("stop-stream").click();
  await context.close();
});

test("reduced motion: the stream waits behind a flashing-content confirmation", async () => {
  const context = await browser.newContext({ baseURL: APP, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/broadcast");
  await page.getByTestId("file-input").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByTestId("broadcast-ack").check();
  await page.getByTestId("start-broadcast").click();
  await expect(page.getByRole("alertdialog")).toContainText("This screen will flash");
  await expect(page.getByTestId("facet-canvas")).toHaveCount(0);
  await page.getByTestId("confirm-flashing").click();
  await expect(page.getByTestId("facet-canvas")).toBeVisible();
  await context.close();
});

test("add a device: new browser shows its code, existing device approves via the camera scanner, new browser joins", async () => {
  // Existing device with an identity (no passkey needed for chain operations).
  const existing = await browser.newContext({ baseURL: APP, permissions: ["camera"] });
  const ep = await existing.newPage();
  await ep.goto("/welcome");
  await ep.getByTestId("device-label").fill("Desk computer");
  await ep.getByTestId("create-identity").click();
  await ep.getByTestId("confirm-create").click();
  await ep.getByRole("button", { name: "Later" }).click();
  await ep.getByRole("button", { name: "Skip for now" }).click();
  await ep.getByTestId("finish-onboarding").click();

  // New browser: "Add this browser to my identity" shows a new-device code and its check code.
  const fresh = await browser.newContext({ baseURL: APP });
  const np = await fresh.newPage();
  await np.goto("/welcome");
  await np.getByTestId("device-label").fill("Travel laptop");
  await np.getByRole("button", { name: "Add this browser to my identity" }).click();
  const addCode = (await np.getByTestId("add-device-code").getAttribute("data-code"))!;
  const newSas = (await np.getByTestId("add-device-sas").textContent())!.trim();

  // The existing device scans it with its camera (the fake camera shows the QR) and sees the same check code.
  writeQrY4m(video, addCode);
  await ep.goto("/devices/add");
  await expect(ep.getByTestId("add-device-confirm-sas")).toHaveText(newSas, { timeout: 30_000 });
  await ep.getByTestId("approve-device").click();
  const joinCode = (await ep.getByTestId("join-pairing-code").getAttribute("data-code"))!;

  // The new browser scans the existing device's pairing code (paste path) and joins.
  await np.getByTestId("join-approved").click();
  await np.getByTestId("paste-code").fill(joinCode);
  await np.getByRole("button", { name: "Use this code" }).click();
  await expect(np.getByRole("heading", { name: "Add a passkey" })).toBeVisible();
  await np.goto("/devices");
  await expect(np.getByTestId("device-row")).toHaveCount(2);
  await expect(np.getByText("this browser")).toBeVisible();
  await existing.close();
  await fresh.close();
});
