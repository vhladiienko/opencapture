// Capture darkgrid through the real pipeline at fractional DPR, then scan the
// stitched output for uniform lighter/darker hairline rows anywhere across the
// width — the lezhinus seam signature (one +3 RGB row at every slice boundary).
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const PORT = 8999;
const BASE = `http://localhost:${PORT}`;
const DSF = Number(process.argv[2] ?? 1.25);

const server = spawn(process.execPath, [join(here, "static-server.mjs")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 400));

const context = await chromium.launchPersistentContext("/tmp/darkgrid-profile", {
  channel: "chromium",
  executablePath: "/home/vitalii/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  headless: true,
  viewport: null,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    "--window-size=2050,1150",
    `--force-device-scale-factor=${DSF}`,
  ],
});

let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });

const page = await context.newPage();
await page.goto(`${BASE}/fixed-hairline.html`);
await page.waitForFunction(() => document.getElementById("cv")?.height > 0);
await page.waitForTimeout(500);

const metrics = await page.evaluate(() => ({
  dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight,
  scrollH: document.documentElement.scrollHeight,
}));
console.log("METRICS:", JSON.stringify(metrics));

const tabInfo = await worker.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({});
  const found = tabs.find((t) => t.url === url);
  return { tabId: found?.id, windowId: found?.windowId };
}, page.url());

const result = await worker.evaluate(async ({ tabId, windowId }) => {
  // @ts-expect-error test-only
  return globalThis.__test.captureFullPage(tabId, windowId);
}, tabInfo);
console.log("report:", JSON.stringify(result.report).slice(0, 500));
result.imagesBase64.forEach((b64, i) => writeFileSync(`/tmp/darkgrid-seg-${i}.png`, Buffer.from(b64, "base64")));

await context.close();
server.kill();
