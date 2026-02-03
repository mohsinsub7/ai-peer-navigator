// instantinsights-ai.js (drop-in patch)
async function runInsightsFromFile({ manifestKey, profileKey, dataKey, rows }) {
  console.log("[Analytics] Starting background analysis", { name: rows?.fileName, size: rows?.size });
  const waitMs = 2500;
  console.log(`[Analytics] Waiting for Blobs propagation (${waitMs/1000}s)...`);
  await new Promise(r => setTimeout(r, waitMs));

  const res = await fetch("/.netlify/functions/analytics-run-background", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifestKey, profileKey, dataKey })
  });

  if (!res.ok && res.status !== 202) {
    const text = await res.text();
    console.error("[Analytics] Background start failed", res.status, text.slice(0,300));
    throw new Error(`Start failed ${res.status}`);
  }

  console.log("[Analytics] Background job invoked", res.status);
  return true;
}
window.__runInsightsFromFile = runInsightsFromFile;
