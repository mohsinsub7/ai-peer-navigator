
// web/instantinsights-ai.js (drop-in example; adjust import path if your publish dir differs)
import { chunkAndUploadFile } from '/client/file-chunker.js';

export async function runInsightsFromFile(file, profile){
  console.log('[Analytics] Starting background analysis', { name: file.name, size: file.size });
  const { manifestKey, profileKey } = await chunkAndUploadFile(file, profile);

  const start = await fetch('/.netlify/functions/analytics-run-background', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifestKey, profileKey })
  });
  if (!start.ok) throw new Error(`Start failed: ${await start.text()}`);
  const { jobId } = await start.json();

  while (true) {
    await new Promise(r => setTimeout(r, 1500));
    const r = await fetch(`/.netlify/functions/analytics-result?jobId=${jobId}`);
    if (!r.ok) continue;
    const out = await r.json();
    if (out.status === 'complete') return out.dashboard;
    if (out.status === 'error') throw new Error(out.error);
  }
}
