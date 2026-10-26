// Loop H: high browser zoom reproduction. Headed Chrome, keyboard zoom
// (Ctrl+=) like a real user, then capture devgrid/textgrid through the real
// pipeline and scan every output row.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const zoomPresses = Number(process.argv[2] ?? 6); // 6 x Ctrl+= = 300%
const page_ = process.argv[3] ?? "devgrid.html";
const PORT = 8999;
const BASE = `http://localhost:${PORT}`;
const PAGE_H = page_ === "devgrid.html" ? 2400 : 9000;

const server = spawn(process.execPath, [join(here, "static-server.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 400));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--window-size=1100,900`,
    ...(zoomPresses ? [`--force-device-scale-factor=${zoomPresses}`] : []),
  ],
});

let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });

const page = await context.newPage();
await page.goto(`${BASE}/${page_}`);
await page.waitForFunction(() => document.querySelector("canvas")?.height > 0);
await page.bringToFront();
await page.waitForTimeout(300);

await page.waitForTimeout(300);
const metrics = await page.evaluate(() => ({
  dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight,
  scrollH: document.documentElement.scrollHeight,
  canvasBacking: (() => { const c = document.querySelector("canvas"); return c ? c.width + "x" + c.height : "none"; })(),
}));
console.log(`zoomPresses=${zoomPresses} METRICS:`, JSON.stringify(metrics));
await page.bringToFront();

const tabInfo = await worker.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({});
    const found = tabs.find((t) => t.url === url);
  if (!found?.id) throw new Error(`no tab for ${url}; open: ` + JSON.stringify(tabs.map((t) => t.url)));
  return { tabId: found.id, windowId: found.windowId };
}, page.url());

const result = await worker.evaluate(async ({ tabId, windowId }) => {
  // @ts-expect-error test-only
  return globalThis.__test.captureFullPage(tabId, windowId);
}, tabInfo);
console.log("report:", JSON.stringify(result.report));

const scratch = await context.newPage();
const scan = await scratch.evaluate(async ({ b64, gridRows, dpr }) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const base = GRID_BASE, span = GRID_SPAN;
  const expected = (row) => (row < gridRows ? base + ((row * 13) % span) : 255);
  let bad = 0;
  let first = null;
  for (let r = 0; r < img.height; r++) {
    const px = ctx.getImageData(10, r, Math.min(400, img.width - 10), 1).data;
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 16) { sum += px[i]; n++; }
    if (Math.abs(sum / n - expected(r)) > 1.5) {
      bad++;
      first ??= { row: r, mean: +(sum / n).toFixed(1), expected: expected(r) };
    }
  }
  return { w: img.width, h: img.height, bad, first };
}, { b64: result.imagesBase64[0], gridRows: Math.round(PAGE_H * metrics.dpr), GRID_BASE: page_ === "devgrid.html" ? 40 : 200, GRID_SPAN: page_ === "devgrid.html" ? 176 : 40 });
console.log("SCAN:", JSON.stringify(scan));

await context.close();
server.kill();
