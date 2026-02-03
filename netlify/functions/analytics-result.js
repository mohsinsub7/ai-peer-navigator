
// netlify/functions/analytics-result.js
import { getStore } from "@netlify/blobs";
const H = { "content-type": "application/json", "access-control-allow-origin":"*" };

export default async function handler(req) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return new Response(JSON.stringify({ error:"Missing jobId" }), { status: 400, headers: H });
  const store = getStore("analytics-jobs");
  const data = await store.get(jobId, { type:"json" });
  if (!data) return new Response(JSON.stringify({ status:"not_found" }), { status: 404, headers: H });
  return new Response(JSON.stringify(data), { status: 200, headers: H });
}
