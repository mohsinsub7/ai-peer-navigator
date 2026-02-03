// netlify/functions/analytics-utils.mjs
import { getStore } from "@netlify/blobs";

export const STORE_NAME = "analytics-jobs";
export const store = getStore(STORE_NAME);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.max(0, Math.floor(ms + Math.random() * 120));

export async function readJsonWithRetry(key, tries = 5) {
  let err = null;
  for (let i = 0; i < tries; i++) {
    try {
      const j = await store.get(key, { type: "json" });
      if (j) return j;
      err = new Error("JSON null");
    } catch (e) {
      err = e;
    }
    await sleep(jitter(150 * (2 ** i))); // 150,300,600,1200,2400
  }
  try {
    const raw = await store.get(key, { type: "bytes" });
    console.error("[BG] JSON read failed; bytes length:", raw?.length ?? null);
  } catch {}
  throw err || new Error(`JSON read failed for ${key}`);
}

export async function readBytesWithRetry(key, tries = 5) {
  let err = null;
  for (let i = 0; i < tries; i++) {
    try {
      const b = await store.get(key, { type: "bytes" });
      if (b && b.length) return b;
      err = new Error("empty-bytes");
    } catch (e) {
      err = e;
    }
    const wait = jitter(500 * (i + 1)); // 0.5s..2.5s (+ jitter) per attempt
    console.log(`[BG] Bytes read failed (attempt ${i+1}/${tries})`, { key, error: err?.message });
    console.log("[BG] Waiting", wait, "ms before retry...");
    await sleep(wait);
  }
  throw err || new Error(`Bytes read failed for ${key}`);
}
