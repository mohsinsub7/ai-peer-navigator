
// client/file-chunker.js
export async function chunkAndUploadFile(file, profile, onProgress) {
  const CHUNK_BYTES = 512 * 1024; // ~512KB per request
  const reader = file.stream().getReader();
  let pending = [], total = 0, idx = 0;
  const dataKey = `file-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const parts = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending.push(value);
    total += value.byteLength;

    const buf = concatIfBig(pending, CHUNK_BYTES);
    if (buf) {
      await send(dataKey, idx++, buf, file.type, file.name);
      parts.push(idx-1);
      if (onProgress) onProgress(total / file.size);
    }
  }
  if (pending.length) {
    const buf = concat(pending);
    await send(dataKey, idx++, buf, file.type, file.name);
    parts.push(idx-1);
  }

  const res = await fetch('/.netlify/functions/files-upload-finalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataKey, parts, profile, mimeType: file.type, fileName: file.name })
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json(); // { manifestKey, profileKey }
}

function concatIfBig(chunks, threshold){
  const total = chunks.reduce((s,c)=> s+c.byteLength, 0);
  if (total < threshold) return null;
  const out = new Uint8Array(total);
  let off=0; for(const c of chunks){ out.set(c, off); off+=c.byteLength; }
  chunks.length = 0;
  return out;
}
function concat(chunks){
  const total = chunks.reduce((s,c)=> s+c.byteLength, 0);
  const out = new Uint8Array(total);
  let off=0; for(const c of chunks){ out.set(c, off); off+=c.byteLength; }
  return out;
}
async function send(dataKey, index, uint8, mimeType, fileName){
  const b64 = base64FromUint8(uint8);
  const r = await fetch('/.netlify/functions/files-upload-chunk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataKey, partIndex: index, base64: b64, mimeType, fileName })
  });
  if (!r.ok) throw new Error(await r.text());
}
function base64FromUint8(u8){
  let binary=""; for (let i=0;i<u8.byteLength;i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}
