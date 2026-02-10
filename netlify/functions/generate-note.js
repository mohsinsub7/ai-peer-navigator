// netlify/functions/generate-note.js
// Clinical note generator (Gemini) with strict schema, PHI guardrails, and CORS.
// Returns structured sections for DAP, SOAP, or GIRP + a small meta block.

const TIMEOUT_MS = 12000;
const RETRIES = 2;
const MIN_TEXT_LEN = parseInt(process.env.MIN_TEXT_LEN || "20", 10);

export default async (req) => {
  const baseHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };

  // Health/diagnostics for quick checks
  if (req.method === "GET") {
    return new Response(
      JSON.stringify(
        {
          ok: true,
          message: "Function online. Use POST for generation.",
          context: process.env.CONTEXT || "unknown",
          ai_provider: process.env.AI_PROVIDER || "google",
          gemini_key_present: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
          gemini_model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          timestamp: new Date().toISOString()
        },
        null,
        2
      ),
      { status: 200, headers: baseHeaders }
    );
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...baseHeaders } });
  }

  if (req.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, baseHeaders);
  }

  // --- Parse & validate input ---
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad JSON" }, 400, baseHeaders);
  }

  const template = String(body.template || "").toLowerCase(); // 'dap' | 'soap' | 'girp'
  const redacted = String(body.redacted_text || "").slice(0, 8000);
  const codes = Array.isArray(body.codes) ? body.codes.slice(0, 12) : [];
  const tags = Array.isArray(body.tags) ? body.tags.slice(0, 24) : [];

  if (!["dap", "soap", "girp"].includes(template)) {
    return json({ error: "Invalid template" }, 400, baseHeaders);
  }
  if (!redacted || redacted.length < MIN_TEXT_LEN) {
    return json({ error: "Text too short after redaction", min_chars: MIN_TEXT_LEN }, 400, baseHeaders);
  }

  // quick PHI tripwires (block obvious non-redacted payloads)
  const phi = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,             // email
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,                      // dates
    /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/                       // SSN
  ];
  if (phi.some((r) => r.test(redacted))) {
    return json({ error: "Payload appears unredacted; blocked." }, 400, baseHeaders);
  }

  const PROVIDER = process.env.AI_PROVIDER || "google";
  const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  if (PROVIDER === "google" && !GEMINI_KEY) {
    return json(
      { error: "Missing GEMINI_API_KEY", hint: "Set site-level env var; apply to all deploy contexts." },
      500,
      baseHeaders
    );
  }

  try {
    // --- Generate sections with Gemini (or safe mock) ---
    let sections, meta;
    if (PROVIDER === "google" && GEMINI_KEY) {
      const out = await callGoogle(GEMINI_KEY, GEMINI_MODEL, template, redacted, codes, tags);
      sections = normalizeSections(template, out.sections || out);
      meta = sanitizeMeta(out.meta);
    } else {
      const mock = mockSections(template, redacted, codes, tags);
      sections = normalizeSections(template, mock.sections);
      meta = mock.meta;
    }

    // fill any missing keys with safe defaults
    const required = requiredKeys(template);
    for (const k of required) {
      if (!sections[k] || !String(sections[k]).trim()) sections[k] = "Not assessed/Not discussed.";
    }

    return json({ sections, meta, warnings: [] }, 200, baseHeaders);
  } catch (e) {
    const msg = String((e && e.message) || e);
    let status = 500,
      hint;
    if (/quota|rate|429/i.test(msg)) {
      status = 429;
      hint = "Provider rate limit/quota";
    }
    if (/unauthorized|forbidden|api key|403/i.test(msg)) {
      status = 403;
      hint = "Invalid/unauthorized API key";
    }
    return json({ error: "Generation failed", detail: msg, hint }, status, baseHeaders);
  }
};

// ---------- helpers ----------

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers });
}

function requiredKeys(t) {
  if (t === "dap") return ["data", "assessment", "plan"];
  if (t === "soap") return ["subjective", "objective", "assessment", "plan"];
  if (t === "girp") return ["goal", "intervention", "response", "plan"];
  return [];
}

function normalizeSections(template, raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const lc = {};
  for (const [k, v] of Object.entries(raw)) lc[String(k).toLowerCase().trim()] = v;

  const pick = (...names) => {
    for (const n of names) if (lc[n] != null) return String(lc[n]).trim();
    return "";
  };

  if (template === "dap") {
    return {
      data: pick("data", "d", "subjective data", "subjective", "s"),
      assessment: pick("assessment", "a", "analysis"),
      plan: pick("plan", "p", "next steps", "follow-up")
    };
  }
  if (template === "soap") {
    return {
      subjective: pick("subjective", "s", "data"),
      objective: pick("objective", "o"),
      assessment: pick("assessment", "a", "analysis"),
      plan: pick("plan", "p", "next steps", "follow-up")
    };
  }
  if (template === "girp") {
    return {
      goal: pick("goal", "goals", "g"),
      intervention: pick("intervention", "interventions", "i", "actions"),
      response: pick("response", "client response", "r", "outcome"),
      plan: pick("plan", "p", "next steps", "follow-up")
    };
  }
  return out;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  const safe = {};
  if (meta.risk && /^(None|Low|Moderate|High)$/i.test(meta.risk)) safe.risk = meta.risk;
  if (Array.isArray(meta.tags_used)) safe.tags_used = meta.tags_used.slice(0, 12);
  if (Array.isArray(meta.red_flags)) safe.red_flags = meta.red_flags.slice(0, 8);
  return safe;
}

async function callGoogle(key, model, template, text, codes, tags) {
  // ---- Clinical Prompt Pack (condensed) ----
  const system = `
You are a licensed behavioral health clinician writing brief, defensible progress notes.
STRICT RULES
- Use ONLY the provided TEXT, TAGS, and ICD-10 CODES. Do not invent data.
- If an element wasn’t assessed, write "Not assessed/Not discussed."
- Professional, nonjudgmental tone; no PHI; keep placeholders like [CLIENT_NAME].
- Do NOT include ICD-10 codes, diagnostic codes, or billing codes. Peer Specialists do not assign codes.
- Do NOT add details that were NOT explicitly in the provided TEXT. Only document what was actually discussed.
- 2–4 sentences per section; SMART, timebound plans.

TEMPLATES → JSON KEYS (return ONLY JSON with 'sections' and optional 'meta'):
- DAP:  { "data": "...", "assessment": "...", "plan": "..." }
- SOAP: { "subjective": "...", "objective": "...", "assessment": "...", "plan": "..." }
- GIRP: { "goal": "...", "intervention": "...", "response": "...", "plan": "..." }

CONTENT CHECKLIST
- DAP: Data merges subjective+objective; Assessment gives risk (None/Low/Moderate/High) + rationale; Plan is SMART with timeframe.
- SOAP: Subjective = client-reported concerns & functional impact; Objective = observable facts; Assessment references codes; Plan lists responsible party+timeframe; include safety if risk>None.
- GIRP: Goal is measurable; Intervention = actions performed; Response = client engagement/comprehension; Plan = next steps + follow-up interval.

SCHEMA
{
  "sections": { ...per template... },
  "meta": {
    "risk": "None|Low|Moderate|High",
    "tags_used": ["transportation", "..."],
    "red_flags": ["..."]
  }
}`;

  const user = `TEMPLATE=${template}
TEXT=${text}
CODES=${(codes || []).map((c) => `${c.code}: ${c.title}`).join("; ")}
TAGS=${(tags || []).join(", ")}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.1, top_p: 0.9, response_mime_type: "application/json" }
  };

  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Google ${r.status}: ${await r.text()}`);
      const data = await r.json();
      const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const parsed = JSON.parse(textOut);
      return parsed;
    } catch (e) {
      lastErr = e;
      if (i < RETRIES && /(?:429|5\d\d|network|timeout|aborted)/i.test(String(e))) {
        await new Promise((res) => setTimeout(res, 400 * (i + 1)));
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error("Unknown provider error");
}

function mockSections(template, text, codes, tags) {
  const list = (codes || []).map((c) => `${c.title} (${c.code})`).join(", ");
  const base = {
    meta: {
      risk: "Low",
      icd10_used: (codes || []).map((c) => c.code),
      tags_used: tags || [],
      red_flags: []
    }
  };
  if (template === "dap") {
    base.sections = {
      data: `Client reports: ${text}`,
      assessment: `Barriers likely impact adherence; codes: ${list || "None"}.`,
      plan: `Coordinate resources; follow up in 7 days; provide education and monitor resolution.`
    };
  } else if (template === "soap") {
    base.sections = {
      subjective: `${text}`,
      objective: `Engaged; oriented; cooperative. Services delivered: brief counseling, navigation.`,
      assessment: `Access barriers linked to ${list || "SDOH"}; risk Low.`,
      plan: `Arrange referrals; check status in 1 week; reinforce safety planning if needed.`
    };
  } else {
    base.sections = {
      goal: `Increase access and adherence by addressing identified barriers.`,
      intervention: `Provided navigation, psychoeducation, and referral support.`,
      response: `Client engaged and receptive; demonstrates understanding; identifies obstacles.`,
      plan: `Follow-up in 7 days; confirm referrals; track progress with checklist.`
    };
  }
  return base;
}
