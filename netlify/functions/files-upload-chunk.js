// netlify/functions/files-upload-chunk.js
// FIXED: Store base64 as JSON instead of raw bytes
import { getStore } from "@netlify/blobs";

const H = { "content-type":"application/json", "access-control-allow-origin":"*" };

export default async function handler(req) {
  const startTime = Date.now();
  
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin":"*",
        "access-control-allow-methods":"POST, OPTIONS",
        "access-control-allow-headers":"content-type"
      }});
    }
    
    const raw = await req.text();
    console.log(`[CHUNK] Request size: ${raw.length} bytes`);
    
    if (raw.length > 6 * 1024 * 1024) {
      return new Response(JSON.stringify({ error:"Chunk too large; send ~512KB chunks." }), { status: 413, headers: H });
    }
    
    const { dataKey, partIndex, base64, mimeType, fileName } = JSON.parse(raw || "{}");
    
    if (!dataKey || typeof partIndex !== "number" || !base64) {
      console.error("[CHUNK] Missing required fields", { hasDataKey: !!dataKey, hasPartIndex: typeof partIndex === "number", hasBase64: !!base64 });
      return new Response(JSON.stringify({ error:"Missing dataKey, partIndex, or base64" }), { status: 400, headers: H });
    }
    
    const key = `${dataKey}-part-${String(partIndex).padStart(5,"0")}`;
    console.log(`[CHUNK] Processing part ${partIndex}`, { dataKey, key, mimeType, fileName });
    
    const buf = Buffer.from(base64, "base64");
    console.log(`[CHUNK] Decoded buffer size: ${buf.length} bytes`);
    
    const store = getStore("analytics-jobs");
    
    console.log(`[CHUNK] Writing to store: analytics-jobs, key: ${key} (as JSON)`);
    
    // CRITICAL FIX: Store base64 as JSON instead of raw bytes
    // JSON storage works reliably, bytes storage has SDK issues
    await store.setJSON(key, { 
      data: base64,
      size: buf.length,
      mimeType,
      fileName
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`[CHUNK] ✓ Part ${partIndex} stored as JSON in ${elapsed}ms`, { key, size: buf.length });
    
    return new Response(JSON.stringify({ 
      ok: true, 
      key, 
      size: buf.length, 
      mimeType, 
      fileName,
      partIndex,
      elapsedMs: elapsed
    }), { status: 200, headers: H });
    
  } catch (e) {
    console.error("[CHUNK] ERROR", { message: e.message, stack: e.stack });
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: H });
  }
}
