
// netlify/functions/blobs-smoke-test.js
import { getStore } from "@netlify/blobs";
export default async () => {
  const store = getStore("analytics-jobs");
  const key = "ping"; const v = { ok:true, ts: Date.now() };
  await store.setJSON(key, v);
  const roundTrip = await store.get(key, { type:"json" });
  return new Response(JSON.stringify({ store:"analytics-jobs", exists: !!roundTrip }), { headers: { "content-type": "application/json" } });
};
