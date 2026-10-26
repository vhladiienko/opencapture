// Loop G: ground-truth diff. The stitched output around each seam must be
// pixel-identical to a direct single-frame capture of the same page region
// (same compositor, text rasterization is page-anchored at integer scroll).
// Any row that differs = a per-slice rendering artifact = the visible line.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const PORT = 8999;
const BASE = `http://localhost:${PORT}`;
const PAGE_H = 9000;

const server = spawn(process.execPath, [join(here, "static-server.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 400));

const dpr = process.argv[2] ?? "";
const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: process.env.HEADLESS === "1",
  viewport: null,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--window-size=1100,900`,
    ...(dpr ? [`--force-device-scale-factor=${dpr}`] : []),
  ],
});

let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });

const page = await context.newPage();
await page.goto(`${BASE}/textgrid.html`);
await page.waitForFunction(() => document.querySelector("canvas")?.height > 0);
await page.waitForTimeout(500);
const metrics = await page.evaluate(() => ({ dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight }));
await page.bringToFront();

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
console.log("report:", JSON.stringify(result.report));

const cdp = await context.newCDPSession(page);
const scratch = await context.newPage();

// For each seam: direct-capture a window around it (scroll so the seam sits
// mid-viewport), then diff against the stitched output rows.
const stepDev = Math.round(metrics.innerH * metrics.dpr);
for (const seam of [1, 2, 3, 5, 7].map((k) => Math.round(metrics.innerH * metrics.dpr) * k)) {
  await page.evaluate((y) => window.scrollTo(0, y), (seam - 200) / metrics.dpr);
  await new Promise((r) => setTimeout(r, 250));
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });

  const diff = await scratch.evaluate(async ({ b64Out, b64Direct, seam, offset }) => {
    const load = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { ctx, w: img.width, h: img.height };
    };
    const out = await load("data:image/png;base64," + b64Out);
    const dir = await load("data:image/png;base64," + b64Direct);
    // direct capture row r (viewport coords) = page row seam - offset + r
    const rows = [];
    for (let r = 0; r < 160; r++) {
      const pageRow = seam - offset + r;
      const m = (ctx2, x0, x1) => {
        const px = ctx2.getImageData(x0, r === undefined ? 0 : 0, 0, 0), noop = px; // placeholder
        return noop;
      };
      void m;
      const meanAt = (c, y, x0, x1) => {
        const px = c.getImageData(x0, y, x1 - x0, 1).data;
        let sum = 0, n = 0;
        for (let i = 0; i < px.length; i += 12) { sum += px[i]; n++; }
        return sum / n;
      };
      const a = meanAt(out.ctx, pageRow, 260, 540);
      const b = meanAt(dir.ctx, r, 260, 540);
      rows.push({ pageRow, out: +a.toFixed(1), direct: +b.toFixed(1), d: +(a - b).toFixed(1) });
    }
    const bad = rows.filter((x) => Math.abs(x.d) > 2);
    return { badCount: bad.length, sample: rows.slice(0, 40) };
  }, { b64Out: result.imagesBase64[0], b64Direct: data, seam, offset: 200 });

  console.log(`seam ${seam}: differing rows(>|d|>2): ${diff.badCount}`);
  if (diff.badCount > 0) {
    for (const x of diff.sample.slice(0, 24)) console.log(`   ${JSON.stringify(x)}`);
  }
}

await context.close();
server.kill();
