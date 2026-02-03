// netlify/functions/analytics-run-background.mjs
import { store, STORE_NAME, readJsonWithRetry, readBytesWithRetry } from "./analytics-utils.mjs";

export default async (req) => {
  const t0 = Date.now();
  console.log("[BG] ============================================================");
  console.log("[BG]", new Date().toISOString(), "NEW REQUEST");

  let body = {};
  try { body = await req.json(); } catch {}

  const jobId = body.jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const manifestKey = body.manifestKey;
  const profileKey  = body.profileKey;
  const dataKey     = body.dataKey;

  console.log("[BG] Store initialized", { storeName: STORE_NAME });
  console.log("[BG] Request parsed", {
    format: manifestKey ? "NEW (chunked)" : "OLD (single key)",
    manifestKey, profileKey, dataKey
  });
  console.log("[BG] Job started", { jobId });

  try { await store.setJSON(jobId, { status: "started", ts: Date.now() }); } catch {}

  try {
    let bytes;
    if (manifestKey) {
      console.log("[BG] STARTING NEW FORMAT PROCESSING", { manifestKey });
      console.log("[BG] STEP 1: Retrieving manifest from store", { storeName: STORE_NAME, manifestKey });
      const manifest = await readJsonWithRetry(manifestKey, 5);
      console.log("[BG] ✓ Manifest retrieved successfully", {
        dataKey: manifest?.dataKey,
        partCount: manifest?.parts?.length ?? null,
        mimeType: manifest?.mimeType,
        fileName: manifest?.fileName
      });

      if (!manifest?.dataKey || !Array.isArray(manifest?.parts)) {
        throw new Error("Manifest missing dataKey or parts[]");
      }

      if (profileKey) {
        console.log("[BG] STEP 2: Retrieving profile", { profileKey });
        try {
          const profile = await readJsonWithRetry(profileKey, 4);
          console.log("[BG] ✓ Profile retrieved", { hasColumns: !!profile?.columns });
        } catch (e) {
          console.warn("[BG] Profile read failed (non-fatal)", e?.message);
        }
      }

      console.log("[BG] STEP 3: Reconstructing file from parts", { partCount: manifest.parts.length, storeName: STORE_NAME });

      const parts = [];
      for (const idx of manifest.parts) {
        const key = `${manifest.dataKey}-part-${String(idx).padStart(5, "0")}`;
        console.log("[BG] Retrieving part", { index: idx, key });
        const b = await readBytesWithRetry(key, 5);
        parts.push(b);
      }
      const total = parts.reduce((acc, cur) => acc + cur.length, 0);
      bytes = Buffer.concat(parts.map((u) => Buffer.from(u)));
      console.log("[BG] ✓ Reconstructed bytes", { partCount: parts.length, total });
    } else {
      if (!dataKey) throw new Error("Request must include manifestKey or dataKey");
      console.log("[BG] STARTING OLD FORMAT PROCESSING", { dataKey });
      bytes = await readBytesWithRetry(dataKey, 6);
      console.log("[BG] ✓ Retrieved single blob", { size: bytes.length });
    }

    console.log("[BG] Ready to hand off to AI pipeline", { size: bytes.length });

    try { await store.setJSON(jobId, { status: "ok", size: bytes.length, ts: Date.now() }); } catch {}
    console.log("[BG] Completed OK in", Date.now() - t0, "ms");
    return new Response("", { status: 202 });
  } catch (err) {
    console.error("[BG] FATAL ERROR", { message: err?.message, stack: String(err?.stack || err) , jobId, elapsedMs: Date.now() - t0 });
    try { await store.setJSON(jobId, { status: "error", error: String(err?.message || err), ts: Date.now() }); } catch {}
    return new Response("", { status: 202 });
  }
};
