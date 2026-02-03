// netlify/functions/debug-list-keys.js
import { getStore } from "@netlify/blobs";

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const prefix = url.searchParams.get("prefix") || "";
    const limit = parseInt(url.searchParams.get("limit") || "50");
    
    const store = getStore("analytics-jobs");
    
    console.log("[DEBUG-LIST] Listing keys with prefix:", prefix);
    
    const { blobs } = await store.list({ prefix, limit });
    
    const keys = blobs.map(b => ({
      key: b.key,
      size: b.size,
      etag: b.etag
    }));
    
    console.log("[DEBUG-LIST] Found", keys.length, "keys");
    
    return new Response(
      JSON.stringify({ 
        ok: true,
        store: "analytics-jobs",
        count: keys.length,
        keys,
        searchPrefix: prefix,
        limit
      }),
      { status: 200, headers: H }
    );
  } catch (error) {
    console.error("[DEBUG-LIST] Error:", error);
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: error.message,
        stack: error.stack
      }),
      { status: 500, headers: H }
    );
  }
}
