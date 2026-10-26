// Loop F: headed, real-display DPR. Capture the text+grid page through the
// real pipeline, then analyze: (a) grid-column row mismatches = geometric
// seam shift; (b) text-column tone discontinuities at each expected seam =
// raster/AA difference between slices.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const dpr = process.argv[2] ?? ""; // "", "1", "1.25", "2" ...
const PORT = 8999;
const BASE = `http://localhost:${PORT}`;
const PAGE_H = 9000;

const server = spawn(process.execPath, [join(here, "static-server.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 400));

const args = [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--window-size=1100,900`];
if (dpr) args.push(`--force-device-scale-factor=${dpr}`);

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: process.env.HEADLESS === "1",
  viewport: null,
  args,
});

let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });

const page = await context.newPage();
await page.goto(`${BASE}/textgrid.html`);
await page.waitForFunction(() => document.querySelector("canvas")?.height > 0);
await page.waitForTimeout(500);
const metrics = await page.evaluate(() => ({ dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight }));
console.log("METRICS:", JSON.stringify(metrics));
await page.bringToFront();

const t0 = Date.now();
const tabInfo = await worker.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({});
  const found = tabs.find((t) => t.url === url);
  if (!found?.id) throw new Error(`no tab for ${url}`);
  return { tabId: found.id, windowId: found.windowId };
}, page.url());
const result = await worker.evaluate(async ({ tabId, windowId }) => {
  // @ts-expect-error test-only
  return globalThis.__test.captureFullPage(tabId, windowId);
}, tabInfo);
console.log(`captured in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, JSON.stringify(result.report));

const analysis = await page.evaluate(async ({ b64, gridRows, dpr, innerH }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const expected = (row) => 200 + ((row * 13) % 40);
  // (a) grid column: x 10..150 — geometric shifts / wrong rows
  let badGrid = 0, firstBad = null;
  const rowMean = (r, x0, x1) => {
    const px = ctx.getImageData(x0, r, x1 - x0, 1).data;
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 16) { sum += px[i]; n++; }
    return sum / n;
  };
  for (let r = 0; r < Math.min(img.height, gridRows); r++) {
    const m = rowMean(r, 10, 150);
    if (Math.abs(m - expected(r)) > 1.5) {
      badGrid++;
      firstBad ??= { row: r, mean: +m.toFixed(1), expected: expected(r) };
    }
  }
  // (b) text column tone profile: x 260..540. A seam shows as a jump in the
  // local mean vs the neighbors 3 rows away.
  const seams = [];
  const stepDev = Math.round(innerH * dpr);
  for (let s = stepDev; s < img.height - 4; s += stepDev) {
    const above = (rowMean(s - 4, 260, 540) + rowMean(s - 3, 260, 540) + rowMean(s - 2, 260, 540)) / 3;
    const below = (rowMean(s + 2, 260, 540) + rowMean(s + 3, 260, 540) + rowMean(s + 4, 260, 540)) / 3;
    seams.push({ seam: s, jump: +(below - above).toFixed(2) });
  }
  return { w: img.width, h: img.height, badGrid, firstBad, seams };
}, { b64: result.imagesBase64[0], gridRows: Math.round(PAGE_H * (metrics.dpr || 1)), dpr: metrics.dpr, innerH: metrics.innerH });

console.log("ANALYSIS:", JSON.stringify(analysis, null, 1).slice(0, 1200));

await context.close();
server.kill();
