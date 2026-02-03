// netlify/functions/debug-get-manifest.mjs
import { getStore } from "@netlify/blobs";
const store = getStore("analytics-jobs");

export default async (req) => {
  const url = new URL(req.url);
  const k = url.searchParams.get("k");
  if (!k) return new Response(JSON.stringify({ ok:false, error:"missing k"}), { headers:{ "content-type":"application/json"}});
  try {
    const j = await store.get(k, { type: "json" });
    return new Response(JSON.stringify({ ok:true, json:j }), { headers:{ "content-type":"application/json" }});
  } catch (e) {
    const b = await store.get(k, { type:"bytes" });
    return new Response(JSON.stringify({ ok:false, error:e.message, bytes:b?.length ?? null }), { headers:{ "content-type":"application/json" }});
  }
};
