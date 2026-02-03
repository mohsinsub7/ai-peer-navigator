
Final Deployable (AI Insights — Files API + Chunked Upload)
===========================================================

Functions (Netlify):
- files-upload-chunk.js      -> POST base64 chunk of original file to Blobs
- files-upload-finalize.js   -> POST manifest { dataKey, parts, mimeType, fileName } + profile
- analytics-run-background.js-> Background job: reconstructs file, uploads to Gemini Files API, requests JSON Mode dashboard
- analytics-result.js        -> GET ?jobId=... (polling)

Client files:
- client/file-chunker.js     -> Browser helper to stream File and send chunks
- web/instantinsights-ai.js  -> Example of starting the flow and polling completion

Env:
- GEMINI_API_KEY (or GOOGLE_API_KEY)
- GEMINI_MODEL = gemini-2.0-flash (or your choice)
- DEBUG_ANALYTICS=1 (optional)
- Node 20 runtime (package.json engines already set; you can also set AWS_LAMBDA_JS_RUNTIME=nodejs20.x)

Delete / stop calling (to prevent 404 / old path):
- netlify/functions/analytics-upload.js  (old 'send whole dataset JSON' endpoint)
- Any client code that fetches '/.netlify/functions/analytics-upload'

Keep:
- analytics-spec.js / analytics-utils.js are safe to keep if you want; not used by this flow.

Publish directory:
- Ensure 'client/' and 'web/' are inside your publish directory so the browser can import '/client/file-chunker.js' and '/web/instantinsights-ai.js'.

