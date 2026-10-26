import { chromium, expect, test } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the seam artifact on fractional device scales.
//
// At a device pixel ratio whose viewport does not map to whole device rows
// (here 1.25 with the headless window's 634px-tall content area), the old
// scroll plan stepped by the raw viewport height, so each step was 792.5
// device rows. The browser snaps every frame to a whole device row, one row
// off from the row the stitcher computes, and because slices are chained
// bottom-to-top every seam after the first carried a shifted band — on real
// pages a faint 2px dark/light line where two captures were glued.
//
// The probe page encodes each absolute device row as its own gray level, so
// the stitched output must reproduce value(row) = 40 + ((row*13) % 176) at
// every row exactly. Any duplicated, dropped, or shifted row fails here.
//
// This spec launches its own context (not ./fixtures) because the scale is
// a window-level property: fixtures' default launch runs at dpr 1, where the
// bug cannot reproduce.

const here = dirname(fileURLToPath(import.meta.url));
const extensionDist = process.env.DIST_OVERRIDE ?? join(here, "..", "dist");
const BASE_URL = "http://localhost:8934";
const PAGE_W = 800;
const PAGE_H = 2400;
const VP_W = 1000;
const VP_H = 720;
const DSF = 1.25;

test("full-page capture is row-exact at a fractional device pixel ratio", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionDist}`,
      `--load-extension=${extensionDist}`,
      `--force-device-scale-factor=${DSF}`,
      `--window-size=${VP_W},${VP_H}`,
    ],
  });

  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 20_000 });

    const page = await context.newPage();
    await page.goto(`${BASE_URL}/devgrid.html`);
    await page.waitForFunction(() => (document.querySelector("canvas")?.height ?? 0) > 0);

    const tab = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const found = tabs.find((t) => t.url === url);
      if (!found?.id) throw new Error(`no tab found for ${url}`);
      return { tabId: found.id, windowId: found.windowId };
    }, page.url());

    const result = await worker.evaluate(async ({ tabId, windowId }) => {
      // @ts-expect-error test-only global, see background/index.ts
      return globalThis.__test.captureFullPage(tabId, windowId);
    }, tab);

    expect(result.report.dpr).toBe(DSF);
    expect(result.report.slice_count).toBeGreaterThan(1);
    expect(result.report.output_width_px).toBe(Math.round(VP_W * DSF));
    expect(result.imagesBase64.length).toBe(1);

    const scan = await page.evaluate(async ({ b64, gridRows }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const expected = (row: number) => (row < gridRows ? 40 + ((row * 13) % 176) : 255);
      let badCount = 0;
      let firstBad: { row: number; mean: number; expected: number } | null = null;
      for (let r = 0; r < img.height; r++) {
        const px = ctx.getImageData(10, r, 400, 1).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < px.length; i += 28) {
          sum += px[i]!;
          n++;
        }
        const mean = sum / n;
        if (Math.abs(mean - expected(r)) > 1.5) {
          badCount++;
          firstBad ??= { row: r, mean: +mean.toFixed(1), expected: expected(r) };
        }
      }
      return { w: img.width, h: img.height, badCount, firstBad };
    }, { b64: result.imagesBase64[0]!, gridRows: Math.round(PAGE_H * DSF) });

    expect(scan.w).toBe(Math.round(VP_W * DSF));
    expect(scan.firstBad, `bad rows: ${scan.badCount}`).toBeNull();
    expect(scan.badCount).toBe(0);
  } finally {
    await context.close();
  }
});
