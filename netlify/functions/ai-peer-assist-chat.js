// netlify/functions/ai-peer-assist-chat.js
import { GoogleAuth } from "google-auth-library";

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };

// Vertex AI Configuration
const PROJECT_ID = "gen-lang-client-0731412858";
const LOCATION = "global";
const ENGINE_ID = "ai-peer-assist-multi-ds"; // Multi-data-store engine (PDFs + structured agency data)

// ── GEMINI GENERATION CONFIG ──
const GENERATION_CONFIG = {
  temperature: 0.3,
  topK: 20,
  topP: 0.8,
  maxOutputTokens: 2048,
};

const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }, // Lower threshold — clinical content can trigger false positives
];

// ── CRISIS DETECTION ──
const CRISIS_PATTERNS = [
  /\b(suicid|kill (my|him|her|them)self|want(s)? to die|end (my|their|his|her) life)\b/i,
  /\b(self[- ]?harm|cutting|self[- ]?injur|hurting (my|him|her|them)self)\b/i,
  /\b(overdos|od[''']?d|took too (many|much)|od on|found (him|her|them) unresponsive)\b/i,
  /\b(domestic violence|ipv|intimate partner|abus(e|ing|ive) (partner|spouse|husband|wife|boyfriend|girlfriend))\b/i,
  /\b(weapon|gun|knife|firearm|threat(en|ening)? (to kill|with|harm))\b/i,
  /\b(homicid|kill (someone|him|her|them|a person))\b/i,
  /\b(not safe|unsafe at home|afraid.*(partner|husband|wife|boyfriend|girlfriend))\b/i,
];

const CRISIS_RESPONSE = `
### 🚨 CRISIS DETECTED — IMMEDIATE ACTION REQUIRED

**This situation requires immediate professional intervention. As a Peer Navigator, your priority is safety.**

---

### ✅ ACTION STEPS (Do These NOW)

1. **Stay calm and present** — do not leave the client alone if they are in immediate danger
2. **Assess immediate safety** — "Are you safe right now?" / "Is anyone in danger right now?"
3. **Call the appropriate crisis line:**

---

### 📍 CRISIS RESOURCES

• **988 Suicide & Crisis Lifeline**: Call or text **988** (24/7, free, confidential)
• **911**: For immediate life-threatening emergencies
• **NYC Safe Horizon Hotline**: **1-800-621-HOPE (4673)** — domestic violence, abuse, human trafficking
• **NYC Well**: **1-888-NYC-WELL (692-9355)** — free mental health support, 24/7, 200+ languages
• **National Domestic Violence Hotline**: **1-800-799-7233** (24/7)
• **Crisis Text Line**: Text **HELLO** to **741741**
• **SAMHSA National Helpline**: **1-800-662-4357** — substance use & mental health referrals (24/7)
• **Poison Control (overdose)**: **1-800-222-1222**

---

### ⚠️ BOUNDARIES REMINDER
• You are NOT a clinician — do not attempt to provide therapy or medical intervention
• Your role: **ensure safety, connect to professionals, stay present, document**
• If client is in immediate physical danger, call **911** first
• Do NOT promise confidentiality if someone's life is at risk

---

### 📝 DOCUMENTATION TIP
Document this as a **critical incident**. Note the time, what the client said (exact quotes), what actions you took, and who you contacted. Use your agency's incident report form in addition to your session note.

---

*⚠️ Disclaimer: This is not clinical advice. For any medical or psychiatric emergency, contact 911 or go to the nearest emergency room.*`;

function detectCrisis(message, history) {
  const allText = [message, ...(history || []).slice(-4).map(h => h.text || '')].join(' ');
  return CRISIS_PATTERNS.some(p => p.test(allText));
}

// ── NOTE GENERATION DETECTION ──
const NOTE_REQUEST_PATTERNS = [
  /\b(create|make|generate|write|give me|produce|draft|build)\b.*\b(note|soap|dap|girp|birp|chart|documentation|clinical note)\b/i,
  /\b(soap|dap|girp|birp)\b.*\b(note|format|template)\b/i,
  /\b(convert|turn)\b.*\b(into|to|this)\b.*\b(note|soap|dap|girp|birp)\b/i,
  /\bnote for (me|the chart|my chart|documentation)\b/i,
  /\b(document this|chart this|put this in the chart|for the chart)\b/i,
  /\b(soap|dap|girp|birp)\b\s*(note)?\s*(for me|please|now)?\s*$/i,
];

function isNoteRequest(message) {
  return NOTE_REQUEST_PATTERNS.some(p => p.test(message));
}

function detectNoteFormat(message) {
  const msg = message.toLowerCase();
  if (/\bsoap\b/.test(msg)) return 'SOAP';
  if (/\bdap\b/.test(msg)) return 'DAP';
  if (/\bgirp\b/.test(msg)) return 'GIRP';
  if (/\bbirp\b/.test(msg)) return 'BIRP';
  return 'BIRP';
}

// ── LOCATION EXTRACTION ──
// Scans current message and conversation history for zip codes and borough names
const NYC_BOROUGHS = {
  'manhattan': 'MANHATTAN',
  'brooklyn': 'BROOKLYN',
  'bronx': 'BRONX',
  'the bronx': 'BRONX',
  'queens': 'QUEENS',
  'staten island': 'STATEN ISLAND',
};

// NYC zip code ranges by borough for context enrichment
const ZIP_TO_BOROUGH = (zip) => {
  const z = parseInt(zip);
  if (z >= 10001 && z <= 10282) return 'MANHATTAN';
  if (z >= 10301 && z <= 10314) return 'STATEN ISLAND';
  if (z >= 10451 && z <= 10475) return 'BRONX';
  if (z >= 11004 && z <= 11109) return 'QUEENS';
  if (z >= 11201 && z <= 11256) return 'BROOKLYN';
  if (z >= 11351 && z <= 11697) return 'QUEENS';
  return null;
};

function extractLocation(message, history) {
  const allText = [
    message,
    ...(history || []).map(h => h.text || '')
  ].join(' ');

  // Extract zip codes (NYC zips: 10xxx, 11xxx)
  const zipMatches = allText.match(/\b(1[01]\d{3})\b/g);
  const zipcode = zipMatches ? zipMatches[zipMatches.length - 1] : null; // Use the most recent zip

  // Extract borough names
  let borough = null;
  const lowerText = allText.toLowerCase();
  for (const [key, value] of Object.entries(NYC_BOROUGHS)) {
    if (lowerText.includes(key)) {
      borough = value;
      break;
    }
  }

  // If we have a zip but no borough, infer borough from zip
  if (zipcode && !borough) {
    borough = ZIP_TO_BOROUGH(zipcode);
  }

  console.log("[LOCATION] Extracted:", { zipcode, borough });
  return { zipcode, borough };
}

// ── RESOURCE NEED DETECTION ──
// Detects if the query is asking for location-dependent resources
const RESOURCE_KEYWORDS = [
  /\b(food|hungry|eat|meal|pantry|soup kitchen|food bank|feeding|snap|wic)\b/i,
  /\b(shelter|homeless|housing|bed|sleep|evict|rent)\b/i,
  /\b(treatment|rehab|detox|methadone|buprenorphine|suboxone|naltrexone|moud|mat|otp|substance|drug|alcohol|cocaine|heroin|fentanyl|opioid)\b/i,
  /\b(mental health|therapist|counselor|psychiatrist|crisis|suicidal|anxiety|depression|bipolar)\b/i,
  /\b(medicaid|medicare|insurance|benefits|ssi|ssdi|snap|tanf|welfare)\b/i,
  /\b(clinic|hospital|doctor|medical|health center|urgent care)\b/i,
  /\b(hiv|aids|testing|sti|std|hepatitis)\b/i,
  /\b(resource|referral|where can|find|locate|nearby|near me|close to)\b/i,
];

function needsLocationResources(message, history) {
  // Check current message AND conversation history for resource needs
  const allText = [message, ...(history || []).map(h => h.text || '')].join(' ');
  return RESOURCE_KEYWORDS.some(p => p.test(allText));
}

// ── SYSTEM PROMPT ──
const SYSTEM_INSTRUCTIONS = `You are an AI Peer Support Assistant designed to help Peer Navigators/Specialists during their client visits. Your responses must be SCANNABLE, ACTIONABLE, and FIELD-READY.

## CONVERSATION CONTEXT:
You are having a multi-turn conversation with a Peer Navigator. You REMEMBER everything said previously in this session. When the navigator refers to "this", "the client", "them", or previous topics, use the full conversation history to understand what they mean.

## LOCATION AWARENESS (CRITICAL):
- When a client needs location-dependent resources (food, shelter, treatment, benefits offices, clinics), you MUST check if you know the client's zip code or neighborhood from the conversation.
- If NO location has been provided yet and the navigator is asking for resources, your FIRST action step must be: "Ask your client for their zip code or neighborhood so I can pull specific resources near them."
- Say something like: "I want to give you the exact names and addresses of places nearby. What zip code or neighborhood is your client in?"
- Once you have the location (from this message or earlier in conversation), provide SPECIFIC resources from the search results below with exact names, addresses, and phone numbers.
- NEVER use placeholder text like [Name], [Address], or [Phone Number]. If you have real data from the search results, USE IT. If you don't have a specific resource, say "Call 311 for the nearest [service type]" instead of inventing placeholders.

## USING SEARCH RESULTS:
When search results are provided below your prompt, they contain REAL agency data from a curated NYC agency directory (1,016 verified agencies with 98% phone coverage). These are real organizations with real addresses and phone numbers. You MUST:
1. Present them by name with full address, phone number, and hours of operation
2. ALWAYS include the phone number — almost every agency has one. If a phone IS missing, suggest "Call 311 or visit in person"
3. Include the Program type and Site/Office name when available — this helps navigators identify the right location
4. Prioritize results closest to the client's zip code/borough
5. If no search results match the need, say so honestly and suggest calling 311 or 211

## HARM REDUCTION APPROACH (CRITICAL):
You operate from a harm reduction framework. This means:
- Meet clients WHERE THEY ARE — do NOT require sobriety/abstinence as a precondition for services
- Acknowledge that substance use exists on a spectrum; any reduction in harm is positive progress
- When discussing substance use, provide information about ALL options including:
  • **Syringe service programs** (SSPs) — for safer injection supplies, wound care, naloxone
  • **Naloxone (Narcan)** distribution sites — encourage all clients at risk to carry naloxone
  • **MOUD/MAT options**: methadone, buprenorphine (Suboxone), naltrexone (Vivitrol) — explain each
  • **Fentanyl test strips** — to detect fentanyl contamination in drug supply
  • **Safer use practices** — never use alone, start with a small amount, don't mix substances
- NEVER use stigmatizing language: say "person who uses drugs" not "addict" or "junkie"; "substance use disorder" not "substance abuse"; "positive toxicology" not "dirty urine"
- Acknowledge relapse as part of recovery, not failure
- If a client is actively using, focus on keeping them ALIVE and connected to care

## TRAUMA-INFORMED CARE:
- Assume that most clients have experienced trauma (ACEs, community violence, incarceration, homelessness, IPV)
- Prioritize **safety, trustworthiness, choice, collaboration, and empowerment** in all interactions
- Avoid re-traumatization: do NOT push clients to disclose trauma details
- If a client appears triggered or dysregulated, suggest grounding techniques:
  • 5-4-3-2-1 sensory grounding (name 5 things you see, 4 you hear, etc.)
  • Box breathing (inhale 4s, hold 4s, exhale 4s, hold 4s)
  • "Let's take a pause — you're safe here"
- Frame questions as invitations, not demands: "Would you be open to..." vs "You need to..."

## CULTURAL COMPETENCY:
- Recognize that clients come from diverse cultural, racial, ethnic, religious, and socioeconomic backgrounds
- Be aware that systemic racism, poverty, immigration status, and discrimination are barriers to care
- Respect cultural healing practices alongside Western medicine
- For immigrant/undocumented clients: many services do NOT require documentation or immigration status checks — highlight this when relevant
- For clients with limited English: mention NYC Well (1-888-692-9355) supports 200+ languages
- Be aware of community-specific issues: mass incarceration impact on Black communities, opioid crisis in rural/suburban areas, meth use in LGBTQ+ community, etc.

## LGBTQ+ AFFIRMING CARE:
- Use chosen names and pronouns (if known from conversation)
- Recognize unique barriers: family rejection, discrimination in shelters, lack of affirming providers
- Know that LGBTQ+ individuals, especially trans people of color, face disproportionate rates of homelessness, violence, and substance use
- Recommend LGBTQ+-affirming resources when relevant (e.g., Ali Forney Center for LGBTQ+ youth, Callen-Lorde Community Health Center)

## MOTIVATIONAL INTERVIEWING REFERENCE:
When the navigator needs to discuss behavior change with a client, suggest MI techniques:
- **OARS**: Open questions, Affirmations, Reflections, Summaries
- **Decisional Balance**: "What are the good things about [behavior]? What concerns you about it?"
- **Change Talk**: Listen for and reinforce language about desire, ability, reasons, and need for change
- **Rolling with Resistance**: Don't argue or confront — reflect and redirect
- Use the **readiness ruler**: "On a scale of 1-10, how ready are you to make this change?"

## RESPONSE FORMAT RULES (CRITICAL):

Always structure responses using these sections as needed:

### 🎯 QUICK ASSESSMENT
Brief 1-2 sentence summary of the situation and priority level.

### 💬 WHAT TO SAY
Exact phrases the Peer Navigator can use with the client. Use bullet points.

### ✅ ACTION STEPS
Numbered list of specific, actionable steps to take RIGHT NOW. Keep each step concise.

### 📍 RESOURCES
Specific resources with names, addresses, phone numbers when available. Format as a clean list.

### ⚠️ BOUNDARIES REMINDER
Brief reminder of what the Peer Navigator should NOT do (if relevant).

### 📝 DOCUMENTATION TIP
How to document this interaction (BIRP/SOAP format hint).

---

## FORMATTING RULES:
- Use **bold** for key terms and actions
- Use bullet points (•) for lists
- Use numbered lists (1. 2. 3.) for sequential steps
- Keep sections SHORT - 2-5 bullet points max per section
- Skip sections that aren't relevant to the question
- Use horizontal rules (---) to separate major sections
- For crisis situations, put the most urgent action FIRST

## TONE:
- Direct and practical (they're in the field!)
- Supportive but professional
- Strengths-based: highlight what the client IS doing well
- Assume they know peer support basics - give them specifics

## CITATIONS & SOURCES (MANDATORY — EVERY RESPONSE):
You MUST include a "Sources" section at the END of EVERY response. This is non-negotiable.

### When using GUIDELINE/PDF content:
- Cite the source document name inline (e.g., "According to the *Certified Peer Counselor Training Manual*...")
- Explain HOW the guideline informed your response (e.g., "This approach is recommended because...")
- This helps Peer Navigators understand the evidence basis for the guidance

### When recommending AGENCY RESOURCES:
- State which agency directory records you used
- Include the category/program type

### Sources section format (ALWAYS include at the end):
**Sources:**
- *[Guideline document name]* — [what it informed]
- NYC Agency Directory — [category/program type of recommended resources]

Example:
**Sources:**
- *Certified Peer Counselor Training Manual* — motivational interviewing approach
- *SAMHSA Recovery Support Toolkit* — harm reduction framework
- NYC Agency Directory — substance use treatment programs in Queens

## IMPORTANT:
- You are NOT a clinician - never diagnose or prescribe
- For medical emergencies: Direct to 911 or crisis services immediately
- Always end crisis-related responses with a brief disclaimer
- When unsure, recommend the navigator consult their supervisor`;

const NOTE_GENERATION_INSTRUCTIONS = `You are a clinical documentation assistant for Peer Navigators/Specialists. The Peer Navigator has been having a conversation with you about their client visit. Now they are asking you to generate a clinical note based on the ENTIRE conversation history.

## YOUR TASK:
Review the FULL conversation above. Extract all clinically relevant information the navigator mentioned about:
- Client presentation (mood, behavior, appearance, statements)
- Barriers identified (housing, food, transportation, substance use, mental health, etc.)
- Interventions provided (what the peer navigator did: active listening, resource navigation, motivational interviewing, etc.)
- Client response to interventions
- Resources provided or referrals made
- Follow-up plan

## CRITICAL RULES:
1. ONLY use information from the conversation. Do NOT invent details.
2. Use person-first language ("person experiencing homelessness" not "homeless person")
3. Be OBJECTIVE - describe behaviors, not interpretations ("client was pacing and speaking loudly" not "client was angry")
4. Stay in your lane - you are a PEER SPECIALIST, not a clinician. Do NOT diagnose.
5. Use [CLIENT_NAME] as placeholder for the client name.
6. Include relevant ICD-10 Z-codes for documented social determinants when applicable.
7. The note should be COPY-PASTE READY for the chart - no extra commentary or guidance.

## FORMAT: %%FORMAT%%

%%FORMAT_TEMPLATE%%

## OUTPUT:
Return ONLY the clinical note. No preamble, no "Here's your note:", no additional commentary. Just the note itself, ready to paste into the chart.`;

const FORMAT_TEMPLATES = {
  SOAP: `SOAP (Subjective/Objective/Assessment/Plan)

**S - Subjective:** What the client reported/stated. Direct quotes when possible. Include presenting concerns, barriers, and self-reported symptoms.

**O - Objective:** Observable facts. Client's appearance, behavior, affect, engagement level. Services/resources accessed. Measurable data.

**A - Assessment:** Peer specialist's assessment of the situation. Barriers identified with ICD-10 Z-codes. Progress toward goals. Risk level (low/moderate/high).

**P - Plan:** Specific next steps. Follow-up date/time. Referrals made. Resources to be contacted. Client's agreed-upon actions.`,

  DAP: `DAP (Data/Assessment/Plan)

**D - Data:** All relevant information gathered during the session. Client statements, behaviors observed, barriers discussed, interventions used, resources provided.

**A - Assessment:** Peer specialist's assessment of client progress, barriers (with ICD-10 Z-codes), engagement level, and risk factors.

**P - Plan:** Concrete next steps, follow-up timeline, referrals, and client commitments.`,

  GIRP: `GIRP (Goal/Intervention/Response/Plan)

**G - Goal:** The client's stated goal(s) for this session or overall care plan goal being addressed.

**I - Intervention:** What the peer specialist DID during the session. Specific techniques used (active listening, motivational interviewing, resource navigation, etc.)

**R - Response:** How the client responded to the interventions. Engagement level, statements made, emotional response, actions taken.

**P - Plan:** Next steps, follow-up date, referrals, resources to access, and client commitments.`,

  BIRP: `BIRP (Behavior/Intervention/Response/Plan)

**B - Behavior:** Client's observable behavior during the session. Appearance, affect, mood, engagement, statements made. Be descriptive and objective.

**I - Intervention:** Specific interventions the peer specialist used. Include: active listening, emotional support, psychoeducation, resource navigation, motivational engagement, crisis de-escalation, etc.

**R - Response:** Client's response to each intervention. Did they engage? Accept referrals? Express willingness to follow up?

**P - Plan:** Specific follow-up actions, referral tracking, next appointment, resources to connect with, and goals for next session.`
};

// ── AUTH ──
async function getAccessToken() {
  console.log("[AUTH] Getting OAuth2 access token...");

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/generative-language"
    ]
  });

  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  console.log("[AUTH] ✓ Access token obtained");
  return token;
}

// ── RESOURCE CATEGORY DETECTION ──
// When the user asks a broad question like "how can I assist him", we detect
// what resource categories to search for based on conversation context
// Categories aligned with agencylist.xlsx: Food, Substance Use Treatment, Housing,
// Peer/Family Support, Cash/Benefits, Employment, DV, Immigration/Legal, Health Coverage
const RESOURCE_CATEGORIES = [
  { keywords: /\b(food|hungry|eat|meal|pantry|soup kitchen|food bank|feeding|snap|wic|nutrition)\b/i, searchTerms: ["food pantry", "soup kitchen", "SNAP food assistance"] },
  { keywords: /\b(shelter|homeless|housing|bed|sleep|evict|rent|unhoused|unsheltered|homebase)\b/i, searchTerms: ["housing shelter", "Homebase housing", "drop-in center"] },
  { keywords: /\b(treatment|rehab|detox|methadone|buprenorphine|suboxone|naltrexone|moud|mat|otp|substance|drug|alcohol|cocaine|heroin|fentanyl|opioid|addiction|recovery)\b/i, searchTerms: ["substance use treatment", "outpatient opioid treatment", "residential treatment"] },
  { keywords: /\b(peer|family support|peer specialist|peer navigator|peer counselor|recovery coach)\b/i, searchTerms: ["peer support", "family support", "peer-run organization"] },
  { keywords: /\b(mental health|therapist|counselor|psychiatrist|crisis|anxiety|depression|bipolar|psycholog)\b/i, searchTerms: ["mental health clinic", "counseling services", "psychiatric services"] },
  { keywords: /\b(cash|benefits|ssi|ssdi|tanf|welfare|public assistance|medicaid|medicare|insurance|health coverage)\b/i, searchTerms: ["cash assistance benefits", "Medicaid health coverage", "public assistance"] },
  { keywords: /\b(job|employ|work|career|resume|training|vocational)\b/i, searchTerms: ["employment vocational", "job training", "workforce development"] },
  { keywords: /\b(domestic violence|dv|ipv|intimate partner|abuse|safe house|safe horizon)\b/i, searchTerms: ["domestic violence", "safe house shelter", "DV services"] },
  { keywords: /\b(legal|lawyer|court|immigration|asylum|eviction|undocumented)\b/i, searchTerms: ["immigration legal", "legal aid", "eviction prevention"] },
  { keywords: /\b(clinic|hospital|doctor|medical|health center|urgent care|primary care|hiv|aids|testing|sti|std|hepatitis)\b/i, searchTerms: ["health center clinic", "HIV testing", "community health"] },
  { keywords: /\b(assist|help|support|resource|service|refer|need)\b/i, searchTerms: ["community services", "social services", "peer support"] },
];

function detectResourceCategories(message, history) {
  const allText = [message, ...(history || []).map(h => h.text || '')].join(' ');
  const matched = [];

  for (const cat of RESOURCE_CATEGORIES) {
    if (cat.keywords.test(allText)) {
      matched.push(...cat.searchTerms);
    }
  }

  // If nothing specific matched but query seems resource-oriented, provide broad categories
  if (matched.length === 0) {
    return ["community services", "social services"];
  }

  // Deduplicate and limit to 4 most relevant
  return [...new Set(matched)].slice(0, 4);
}

// ── VERTEX AI SEARCH (with multi-strategy location search) ──
const SEARCH_URL = `https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_serving_config:search`;

async function singleSearch(query, accessToken, filter = null) {
  const requestBody = {
    query,
    pageSize: 10,
    contentSearchSpec: {
      snippetSpec: {},
      extractiveContentSpec: { maxExtractiveAnswerCount: 3 }
    }
  };
  if (filter) requestBody.filter = filter;

  try {
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn("[SEARCH] Query failed", { query: query.substring(0, 60), filter, status: response.status, error: errorText.substring(0, 200) });
      return [];
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.warn("[SEARCH] Network error", { query: query.substring(0, 60), message: error?.message });
    return [];
  }
}

async function searchVertexAI(query, accessToken, location, history) {
  const { zipcode, borough } = location || {};

  console.log("[SEARCH] Starting multi-strategy search...", { query: query.substring(0, 80), zipcode, borough });

  // STRATEGY: Run multiple searches in parallel for better coverage
  const searches = [];

  // Detect what categories of resources the conversation needs
  const categories = detectResourceCategories(query, history);
  console.log("[SEARCH] Detected resource categories:", categories);

  // --- Strategy 0: ALWAYS search guidelines (unfiltered) ---
  // This will hit the PDF data store with peer support guidelines, clinical toolkits, etc.
  // These results provide evidence-based practices and citations
  searches.push(
    singleSearch(query, accessToken)
      .then(r => { console.log(`[SEARCH] guidelines+semantic query: ${r.length} results`); return r; })
  );
  // Also search with the first detected category for more specific guideline hits
  if (categories.length > 0 && categories[0] !== query) {
    searches.push(
      singleSearch(`peer support best practices ${categories[0]}`, accessToken)
        .then(r => { console.log(`[SEARCH] guideline "${categories[0]}": ${r.length} results`); return r; })
    );
  }

  // --- Strategy 1: Filtered search by zip code ---
  // Data has been cleaned — zip codes are now standard 5-digit format (no .0 suffix)
  if (zipcode) {
    for (const searchTerm of categories.slice(0, 3)) {
      searches.push(
        singleSearch(searchTerm, accessToken, `zipcode: ANY("${zipcode}")`)
          .then(r => { console.log(`[SEARCH] zip ${zipcode} + "${searchTerm}": ${r.length} results`); return r; })
      );
    }
  }

  // --- Strategy 2: Borough-level filtered search ---
  if (borough) {
    for (const searchTerm of categories.slice(0, 2)) {
      searches.push(
        singleSearch(`${searchTerm} ${borough}`, accessToken, `borough: ANY("${borough}")`)
          .then(r => { console.log(`[SEARCH] borough ${borough} + "${searchTerm}": ${r.length} results`); return r; })
      );
    }
  }

  // --- Strategy 3: Semantic search with location context (no filter) ---
  // This catches results across both data stores without filter restrictions
  if (zipcode) {
    for (const searchTerm of categories.slice(0, 2)) {
      searches.push(
        singleSearch(`${searchTerm} near ${zipcode} ${borough || ''}`, accessToken)
          .then(r => { console.log(`[SEARCH] semantic "${searchTerm}" + zip: ${r.length} results`); return r; })
      );
    }
  } else if (borough) {
    searches.push(
      singleSearch(`${query} in ${borough}`, accessToken)
        .then(r => { console.log(`[SEARCH] semantic borough query: ${r.length} results`); return r; })
    );
  }

  // Run all searches in parallel
  const allResultSets = await Promise.all(searches);

  // Merge and deduplicate by document id
  const seen = new Set();
  const merged = [];
  for (const resultSet of allResultSets) {
    for (const result of resultSet) {
      const docId = result.document?.id || result.id || JSON.stringify(result.document?.structData?.name || Math.random());
      if (!seen.has(docId)) {
        seen.add(docId);
        merged.push(result);
      }
    }
  }

  console.log("[SEARCH] ✓ Merged results:", {
    totalSearches: searches.length,
    uniqueResults: merged.length
  });

  // Sort: prioritize results matching the target zip code
  if (zipcode) {
    merged.sort((a, b) => {
      const aZip = String(a.document?.structData?.zipcode || '');
      const bZip = String(b.document?.structData?.zipcode || '');
      const aMatch = aZip === zipcode ? 1 : 0;
      const bMatch = bZip === zipcode ? 1 : 0;
      return bMatch - aMatch; // Exact zip matches first
    });
  }

  // Return top 20 most relevant (after dedup and sorting)
  // This ensures we have both guideline PDFs and structured agency data
  return merged.slice(0, 20);
}

// ── BUILD RICH RESOURCE CONTEXT ──
// Extracts ALL structured fields from search results and formats them
// so Gemini has real data to reference (not truncated content blobs)
function buildResourceContext(searchResults, location) {
  if (!searchResults || searchResults.length === 0) return "";

  const resources = [];
  const guidelineSnippets = [];
  const { zipcode: targetZip, borough: targetBorough } = location || {};

  for (const result of searchResults) {
    const sd = result.document?.structData;
    const derivedData = result.document?.derivedStructData || {};
    const docName = result.document?.name || "";

    // ── Handle PDF/Guideline results (no structData) ──
    if (!sd || docName.includes('peer-assist-guidelines')) {
      const snippets = derivedData.snippets || [];
      const extractiveAnswers = derivedData.extractive_answers || [];
      const title = derivedData.title || "";
      const link = derivedData.link || "";

      // Extract the source PDF name from the GCS link
      const sourceName = link ? link.split('/').pop().replace('.pdf', '').replace(/_/g, ' ') : title;

      let content = '';
      // Prefer extractive answers (more complete), fall back to snippets
      if (extractiveAnswers.length > 0) {
        content = extractiveAnswers.map(ea => ea.content || '').join('\n');
      } else if (snippets.length > 0 && snippets[0].snippet_status === 'SUCCESS') {
        content = snippets.map(s => (s.snippet || '').replace(/<\/?b>/g, '')).join('\n');
      }

      if (content && content.length > 20) {
        guidelineSnippets.push({
          source: sourceName || 'Peer Support Guidelines',
          content: content.substring(0, 500),
          link: link
        });
      }
      // If this was a PDF-only result, skip the structured data processing below
      if (!sd) continue;
    }

    // ── Handle Structured Agency Directory results ──
    // New agencylist schema: name, program, site, address, borough, zipcode, phone, hours, notes, category
    const name = sd.name || "";
    const program = sd.program || "";
    const site = sd.site || "";
    const address = sd.address || "";
    const zipcode = String(sd.zipcode || "").trim();
    const borough = sd.borough || "";
    const phone = sd.phone || "";
    const hours = sd.hours || "";
    const notes = sd.notes || "";
    const category = sd.category || "";

    const displayName = name || site || program;
    if (!displayName) continue; // Skip records with no identifiable name

    const resource = { name: displayName };
    if (program) resource.program = program;
    if (site && site !== displayName) resource.site = site;
    if (address) resource.address = address;
    if (zipcode) resource.zipcode = zipcode;
    if (borough) resource.borough = borough;
    if (phone) resource.phone = phone;
    if (hours) resource.hours = hours;
    if (notes) resource.notes = notes;
    if (category) resource.category = category;

    // Distance indicator for sorting
    if (targetZip && zipcode === targetZip) {
      resource._exactZipMatch = true;
    } else if (targetBorough && borough.toUpperCase() === targetBorough.toUpperCase()) {
      resource._boroughMatch = true;
    }

    resources.push(resource);
  }

  let context = '';

  // ── Guideline/PDF knowledge section ──
  if (guidelineSnippets.length > 0) {
    context += `\n\n═══ PEER SUPPORT GUIDELINES & EVIDENCE-BASED PRACTICES ═══\n`;
    context += `(Information from official guideline documents. CITE the source when using this information.)\n\n`;
    guidelineSnippets.forEach((g, i) => {
      context += `📖 Source: "${g.source}"\n`;
      context += `${g.content}\n\n`;
    });
    context += `═══ END OF GUIDELINES ═══\n`;
    context += `CITATION INSTRUCTIONS: When referencing guideline content above, cite the source document name (e.g., "According to the Health Services guidelines..." or "Per the Peer Specialist Training Manual...").\n\n`;
  }

  // ── Agency directory section ──
  if (resources.length > 0) {
    // Sort: exact zip matches first, then same borough, then others
    resources.sort((a, b) => {
      if (a._exactZipMatch && !b._exactZipMatch) return -1;
      if (!a._exactZipMatch && b._exactZipMatch) return 1;
      if (a._boroughMatch && !b._boroughMatch) return -1;
      if (!a._boroughMatch && b._boroughMatch) return 1;
      return 0;
    });

    context += `\n═══ VERIFIED RESOURCES FROM NYC AGENCY DIRECTORY (1,016 agencies) ═══\n`;
    context += `(These are REAL agencies with verified addresses and phone numbers. Present them with full details. Do NOT use placeholders.)\n`;
    if (targetZip) context += `Client's zip code: ${targetZip}`;
    if (targetBorough) context += ` (${targetBorough})`;
    if (targetZip || targetBorough) context += ` — prioritize resources closest to client.\n`;
    context += `\n`;

    resources.forEach((r, i) => {
      const locationTag = r._exactZipMatch ? ' ★ IN CLIENT ZIP' : (r._boroughMatch ? ' ● SAME BOROUGH' : '');
      context += `${i + 1}. **${r.name}**${locationTag}\n`;
      if (r.program) context += `   Program: ${r.program}\n`;
      if (r.site) context += `   Site: ${r.site}\n`;
      if (r.category) context += `   Category: ${r.category.replace(/_/g, ' ')}\n`;
      if (r.address) context += `   Address: ${r.address}\n`;
      if (r.phone) context += `   📞 Phone: ${r.phone}\n`;
      else context += `   Phone: Not listed — call 311 for info\n`;
      if (r.hours) context += `   🕐 Hours: ${r.hours}\n`;
      if (r.notes) context += `   Notes: ${r.notes}\n`;
      context += `\n`;
    });

    context += `═══ END OF VERIFIED RESOURCES ═══\n`;
    context += `RESOURCE INSTRUCTIONS: \n`;
    context += `1. Present resources marked "★ IN CLIENT ZIP" FIRST — they are closest to the client.\n`;
    context += `2. Then resources marked "● SAME BOROUGH" as secondary options.\n`;
    context += `3. ALWAYS include the phone number prominently — most resources have verified phone numbers.\n`;
    context += `4. Include hours of operation when available.\n`;
    context += `5. Do NOT invent, hallucinate, or add placeholder resource details.\n`;
    context += `6. If none of the resources match what the client needs, say so honestly and suggest calling 311 or NYC Well (1-888-692-9355).\n`;
  }

  if (!context) return "";
  return context;
}

// ── RETRY HELPER ──
async function withRetry(fn, label, maxRetries = 2) {
  const delays = [1000, 3000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = delays[attempt] || 3000;
        console.warn(`[RETRY] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms...`, { message: error?.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`[RETRY] ${label} all ${maxRetries + 1} attempts failed`);
        throw error;
      }
    }
  }
}

// ── GENERATIVE AI CALL (with generation config, safety settings, and retry) ──
async function callVertexAIGenerative(contents, systemPrompt, accessToken) {
  console.log("[GENERATIVE] Calling Vertex AI with multi-turn history...", {
    turns: contents.length
  });

  const url = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/google/models/gemini-2.0-flash:generateContent`;

  return withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        contents: contents,
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: GENERATION_CONFIG,
        safetySettings: SAFETY_SETTINGS,
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[GENERATIVE] API Error", { status: response.status, error: errorText });
      throw new Error(`Generative API error: ${response.status}`);
    }

    const data = await response.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!generatedText) {
      const blockReason = data.candidates?.[0]?.finishReason;
      console.warn("[GENERATIVE] Empty response", { blockReason, candidates: JSON.stringify(data.candidates).substring(0, 300) });
      if (blockReason === 'SAFETY') {
        return "I want to help with this situation, but I need to be careful with my response. Could you rephrase your question? If this is a crisis situation, please call **988** (Suicide & Crisis Lifeline) or **911** for immediate help.";
      }
    }

    console.log("[GENERATIVE] ✓ Response generated", { length: generatedText.length });
    return generatedText;
  }, "Gemini generation");
}

// ── MAIN HANDLER ──
export default async function handler(req) {
  console.log("[AI-PEER-ASSIST] Request received", { method: req.method });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: H
    });
  }

  try {
    const body = await req.json();
    const { message, history } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: H
      });
    }

    console.log("[AI-PEER-ASSIST] User message:", message.substring(0, 100));
    console.log("[AI-PEER-ASSIST] History turns:", (history || []).length);

    // Get OAuth2 access token
    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (authError) {
      console.error("[AI-PEER-ASSIST] Authentication failed", { message: authError?.message });
      return new Response(
        JSON.stringify({ error: "Authentication failed", message: authError?.message }),
        { status: 500, headers: H }
      );
    }

    // ── Detect CRISIS situations first (highest priority) ──
    const isCrisis = detectCrisis(message, history);
    if (isCrisis) {
      console.log("[AI-PEER-ASSIST] ⚠️ CRISIS DETECTED — returning crisis protocol");
      return new Response(JSON.stringify({
        response: CRISIS_RESPONSE,
        mode: 'crisis',
        noteFormat: null
      }), {
        status: 200,
        headers: H
      });
    }

    // ── Detect if this is a note generation request ──
    const wantsNote = isNoteRequest(message);
    const noteFormat = wantsNote ? detectNoteFormat(message) : null;

    console.log("[AI-PEER-ASSIST] Note request?", wantsNote, noteFormat);

    // ── Extract location from conversation ──
    const location = extractLocation(message, history);

    // ── Build multi-turn contents array ──
    const contents = [];

    // Add conversation history (limit to last 30 turns)
    const trimmedHistory = (history || []).slice(-30);

    for (const turn of trimmedHistory) {
      if (turn.role === "user") {
        contents.push({ role: "user", parts: [{ text: turn.text }] });
      } else if (turn.role === "model") {
        contents.push({ role: "model", parts: [{ text: turn.text }] });
      }
    }

    // ── Choose system prompt based on mode ──
    let systemPrompt;

    if (wantsNote) {
      // NOTE GENERATION MODE
      const template = FORMAT_TEMPLATES[noteFormat] || FORMAT_TEMPLATES.BIRP;
      systemPrompt = NOTE_GENERATION_INSTRUCTIONS
        .replace('%%FORMAT%%', noteFormat)
        .replace('%%FORMAT_TEMPLATE%%', template);

      contents.push({
        role: "user",
        parts: [{ text: `Generate a ${noteFormat} clinical note based on everything we discussed in this session. ${message}` }]
      });

      console.log(`[AI-PEER-ASSIST] Generating ${noteFormat} note from conversation`);
    } else {
      // GUIDANCE MODE — search for grounded resources
      let searchContext = "";
      const wantsResources = needsLocationResources(message, history);

      try {
        // ALWAYS search — guidelines (PDFs) are useful for ANY peer support question
        // Pass location if we have it for local resource matching; pass null to still get guideline hits
        const searchLocation = (location.zipcode || location.borough) ? location : null;
        const searchResults = await searchVertexAI(message, accessToken, searchLocation, history);

        if (searchResults.length > 0) {
          // Use the rich resource context builder
          searchContext = buildResourceContext(searchResults, location);

          console.log("[AI-PEER-ASSIST] Built resource context", {
            resourceCount: searchResults.length,
            contextLength: searchContext.length,
            hasLocation: !!(location.zipcode || location.borough)
          });
        }
      } catch (searchError) {
        console.warn("[AI-PEER-ASSIST] Search failed, proceeding with general knowledge", {
          message: searchError?.message
        });
      }

      systemPrompt = SYSTEM_INSTRUCTIONS;

      // Build the user prompt with search context
      let userPrompt = message;
      if (searchContext) {
        userPrompt = `${message}\n${searchContext}`;
      }

      // If the navigator is asking for resources but no location is known, add a hint
      if (wantsResources && !location.zipcode && !location.borough && !searchContext) {
        userPrompt += `\n\n[SYSTEM NOTE: No client location (zip code or borough) has been provided yet in this conversation. Ask the navigator for the client's zip code before providing specific resources.]`;
      }

      contents.push({ role: "user", parts: [{ text: userPrompt }] });
    }

    // ── Generate response (with retry) ──
    let response;
    try {
      response = await callVertexAIGenerative(contents, systemPrompt, accessToken);
    } catch (genError) {
      console.error("[AI-PEER-ASSIST] Generation failed after retries", { message: genError?.message });
      // Graceful degradation — provide a helpful message instead of an error
      response = `I'm having trouble connecting to my knowledge base right now. Here's what I can tell you:

### ✅ ACTION STEPS
1. **Try again in a moment** — this is usually a temporary issue
2. If you need **immediate crisis help**: Call **988** (Suicide & Crisis Lifeline) or **911**
3. For NYC resources: Call **311** or **NYC Well at 1-888-692-9355**
4. For substance use help: **SAMHSA Helpline 1-800-662-4357** (24/7, free)

*I apologize for the inconvenience. Please try your question again.*`;
    }

    console.log("[AI-PEER-ASSIST] ✓ Response generated", {
      length: response.length,
      mode: wantsNote ? `note:${noteFormat}` : 'guidance',
      locationUsed: !!(location.zipcode || location.borough)
    });

    return new Response(JSON.stringify({
      response,
      mode: wantsNote ? 'note' : 'guidance',
      noteFormat: noteFormat
    }), {
      status: 200,
      headers: H
    });
  } catch (error) {
    console.error("[AI-PEER-ASSIST] ERROR", {
      message: error?.message,
      stack: error?.stack
    });

    return new Response(
      JSON.stringify({
        error: "Failed to generate response",
        message: error?.message
      }),
      { status: 500, headers: H }
    );
  }
}
