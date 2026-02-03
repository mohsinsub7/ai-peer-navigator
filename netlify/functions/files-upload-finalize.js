// netlify/functions/files-upload-finalize.js
import { getStore } from "@netlify/blobs";

const H = { "content-type":"application/json", "access-control-allow-origin":"*" };

export default async function handler(req) {
  const startTime = Date.now();
  
  try {
    const { dataKey, parts, profile, mimeType, fileName } = await req.json();
    
    console.log("[FINALIZE] Request received", { 
      dataKey, 
      partCount: parts?.length, 
      hasProfile: !!profile,
      mimeType,
      fileName 
    });
    
    if (!dataKey || !Array.isArray(parts) || parts.length === 0) {
      console.error("[FINALIZE] Invalid request", { hasDataKey: !!dataKey, partsIsArray: Array.isArray(parts), partsLength: parts?.length });
      return new Response(JSON.stringify({ error:"Missing dataKey or parts[]" }), { status: 400, headers: H });
    }
    
    const store = getStore("analytics-jobs");
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const manifestKey = `file-manifest-${ts}-${rand}`;
    const profileKey = `profile-${ts}-${rand}`;
    
    console.log("[FINALIZE] Generated keys", { manifestKey, profileKey });
    
    const manifestData = { dataKey, parts, mimeType, fileName };
    console.log("[FINALIZE] Writing manifest to store: analytics-jobs", { key: manifestKey, data: manifestData });
    
    await store.setJSON(manifestKey, manifestData);
    console.log("[FINALIZE] ✓ Manifest written successfully");
    
    if (profile) {
      console.log("[FINALIZE] Writing profile", { key: profileKey, hasData: !!profile });
      await store.setJSON(profileKey, profile);
      console.log("[FINALIZE] ✓ Profile written successfully");
    } else {
      console.log("[FINALIZE] No profile to write");
    }
    
    // Verify the manifest was written correctly
    console.log("[FINALIZE] Verifying manifest write...");
    try {
      const verification = await store.get(manifestKey, { type: "json" });
      console.log("[FINALIZE] ✓ Manifest verified", { hasDataKey: !!verification.dataKey, partCount: verification.parts?.length });
    } catch (verifyError) {
      console.error("[FINALIZE] ⚠️ Manifest verification failed", verifyError.message);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`[FINALIZE] Complete in ${elapsed}ms`, { manifestKey, profileKey });
    
    return new Response(JSON.stringify({ 
      manifestKey, 
      profileKey,
      partCount: parts.length,
      elapsedMs: elapsed
    }), { status: 200, headers: H });
    
  } catch (e) {
    console.error("[FINALIZE] ERROR", { message: e.message, stack: e.stack });
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: H });
  }
}
