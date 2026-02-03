// netlify/functions/analytics-upload.js
// Simple upload function that stores profile and dataset in Blobs
// Returns keys for background function to retrieve them

import { getStore } from "@netlify/blobs";

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    const { profile, fullDataset } = await req.json();

    if (!profile || !fullDataset) {
      return new Response(
        JSON.stringify({ error: "Missing profile or fullDataset" }),
        { status: 400, headers: H }
      );
    }

    const store = getStore("analytics-jobs");
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    
    // Store both profile and dataset
    const profileKey = `profile-${ts}-${rand}`;
    const dataKey = `dataset-${ts}-${rand}`;
    
    await store.setJSON(profileKey, profile);
    await store.setJSON(dataKey, fullDataset);

    console.log(`[Upload] Stored ${fullDataset.length} rows at ${dataKey}`);

    return new Response(
      JSON.stringify({ profileKey, dataKey }),
      { status: 200, headers: H }
    );

  } catch (err) {
    console.error("[Upload] Error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: H }
    );
  }
}
