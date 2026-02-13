// netlify/functions/clinical-insights-processor.js
// Clinical Data Insights Processor with domain-specific AI prompting

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { getStore } from "@netlify/blobs";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };
const MODEL = process.env.AI_INSIGHTS_MODEL || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const APIKEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

function timestamp() {
  return new Date().toISOString();
}

const log = (m, v) => console.log(`[ClinicalAI ${timestamp()}] ${m}`, v ?? "");

function stripFences(s = "") {
  let cleaned = s.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```\s*$/i, '');
  }
  return cleaned.trim();
}

function normalizeSpec(x = {}) {
  if (!x.title && x.dashboardTitle) x.title = x.dashboardTitle;
  x.kpis = Array.isArray(x.kpis) ? x.kpis : [];
  x.charts = Array.isArray(x.charts) ? x.charts : [];
  x.insights = Array.isArray(x.insights) ? x.insights : (x.insights ? [x.insights] : []);
  x.title = x.title || "Clinical Data Insights Dashboard";
  return x;
}

// Helper: Read bytes with exponential backoff
async function readBytesWithRetry(store, key, maxRetries = 5) {
  let lastError = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const bytes = await store.get(key, { type: "bytes" });
      if (bytes && bytes.length) {
        log(`✓ Bytes read success (attempt ${i + 1})`, { key, size: bytes.length });
        return bytes;
      }
      lastError = new Error("empty-bytes");
    } catch (e) {
      lastError = e;
      log(`Bytes read failed (attempt ${i + 1}/${maxRetries})`, { key, error: e.message });
    }
    
    if (i < maxRetries - 1) {
      const baseWait = 500 * (i + 1);
      const jitter = Math.floor(Math.random() * 200);
      const wait = baseWait + jitter;
      log(`Waiting ${wait}ms before retry...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  
  throw lastError || new Error(`Failed to read bytes: ${key}`);
}

// Generate comprehensive clinical prompt based on detected domains
function generateClinicalPrompt(domains, profile) {
  const domainSet = new Set(domains || []);
  
  let basePrompt = `You are an expert clinical data analyst specializing in healthcare analytics. Analyze this clinical dataset and provide actionable insights.

**CRITICAL INSTRUCTIONS:**
1. Return ONLY valid JSON - no markdown, no explanations, no code fences
2. Focus on the detected clinical domains: ${domains.join(', ')}
3. Provide specific, actionable insights based on the actual data
4. Calculate accurate metrics from the data provided
5. Identify trends, outliers, and areas requiring attention

**DOMAIN-SPECIFIC ANALYSIS REQUIREMENTS:**
`;

  // Behavioral Health & Mental Health
  if (domainSet.has('Behavioral Health') || domainSet.has('Mental Health')) {
    basePrompt += `
**BEHAVIORAL & MENTAL HEALTH METRICS:**
- Session attendance rate (% of scheduled sessions attended)
- No-show rate and cancellation rate
- Average sessions per patient
- Treatment completion rate
- Patient engagement score
- Symptom improvement (if outcome measures present)
- Treatment modality distribution (CBT, DBT, medication, group therapy, etc.)
- Patient satisfaction scores (if available)
- Readmission rates within 30/90 days
- Crisis intervention frequency
- Therapist caseload and productivity
- Wait times for initial appointments

**KEY INSIGHTS TO IDENTIFY:**
- Patients at risk of dropout (high no-shows, low engagement)
- Most effective treatment modalities
- Demographic patterns in treatment outcomes
- Resource allocation opportunities
- Scheduling optimization suggestions
`;
  }

  // Substance Use Disorder
  if (domainSet.has('Substance Use Disorder')) {
    basePrompt += `
**SUBSTANCE USE DISORDER (SUD) METRICS:**
- Treatment retention rate (30-day, 90-day, 6-month)
- Medication-Assisted Treatment (MAT/MOUD) adherence rate
- Relapse rates by substance type
- Dropout rate and reasons (if documented)
- Days in treatment (average length of stay)
- Abstinence rates by time period
- Medication adherence (buprenorphine, methadone, naltrexone)
- Recovery support service utilization
- Peer support engagement
- Transition to aftercare success rate

**KEY INSIGHTS TO IDENTIFY:**
- Critical time windows for relapse prevention
- Effectiveness of MAT vs behavioral-only treatment
- Barriers to treatment retention
- Optimal treatment duration recommendations
- Co-occurring disorder patterns
- Geographic or demographic disparities
`;
  }

  // Social Determinants of Health (SDOH)
  if (domainSet.has('Social Determinants of Health')) {
    basePrompt += `
**SOCIAL DETERMINANTS OF HEALTH (SDOH) METRICS:**
- Housing stability distribution (stable, at-risk, homeless, transitional)
- Food insecurity prevalence
- Transportation barriers frequency
- Employment status distribution
- Insurance coverage gaps
- Z-code documentation rate (Z55-Z65 codes)
- Social support network adequacy
- Income level distribution
- Education level impact on outcomes
- Community resource referral rates

**KEY INSIGHTS TO IDENTIFY:**
- SDOH factors most strongly associated with poor outcomes
- Populations with highest unmet social needs
- Geographic clustering of social risk factors
- Impact of addressing SDOH on clinical outcomes
- Resource allocation priorities for social services
- Barriers to care related to SDOH
`;
  }

  // Quality Measures
  if (domainSet.has('Quality Measures')) {
    basePrompt += `
**QUALITY MEASURES & PERFORMANCE:**
- HEDIS measure performance rates
- Preventive screening completion rates
- Immunization coverage rates
- Care gap closure rates
- Clinical guideline adherence
- Patient safety indicators
- Star ratings impact metrics
- Follow-up after hospitalization rates
- Follow-up after ED visit for mental health/SUD
- Continuity of care metrics

**KEY INSIGHTS TO IDENTIFY:**
- Quality measures falling below benchmarks
- Opportunities for improvement
- High-performing vs low-performing areas
- Patient populations with care gaps
- Seasonal or temporal patterns in quality metrics
`;
  }

  // Clinical Billing & Revenue Cycle
  if (domainSet.has('Clinical Billing & RCM')) {
    basePrompt += `
**CLINICAL BILLING & REVENUE CYCLE METRICS:**
- Claim denial rate overall and by denial reason
- Authorization adherence rate
- Days in accounts receivable (A/R)
- Collection rate as % of charges
- Net collection rate
- Point-of-service collection rate
- Insurance claim processing time
- Prior authorization approval rate
- Revenue per encounter
- Cost per unit of service
- Claim scrubbing effectiveness
- Appeal success rate

**KEY INSIGHTS TO IDENTIFY:**
- Top denial reasons requiring attention
- Authorization bottlenecks
- Payer-specific performance issues
- Coding accuracy opportunities
- Revenue leakage sources
- Process improvement opportunities in RCM
`;
  }

  // Utilization Management
  if (domainSet.has('Utilization Management')) {
    basePrompt += `
**UTILIZATION MANAGEMENT METRICS:**
- Hospital admission rate
- Emergency department visit rate
- Readmission rate (30-day, 90-day)
- Average length of stay (ALOS)
- Observation stay rate
- Bed utilization rate
- Discharge disposition distribution
- Avoidable ED visits rate
- High utilizer identification (>3 ED visits or >2 admits in 6 months)
- Outpatient visit frequency

**KEY INSIGHTS TO IDENTIFY:**
- Patients at high risk for readmission
- Potentially avoidable utilization
- Care transitions requiring improvement
- Seasonal utilization patterns
- Discharge planning effectiveness
`;
  }

  // Pharmacy & Medication
  if (domainSet.has('Pharmacy & Medication')) {
    basePrompt += `
**PHARMACY & MEDICATION METRICS:**
- Medication adherence rate (PDC - Proportion of Days Covered)
- Medication error rate
- Generic substitution rate
- Medication reconciliation completion rate
- Polypharmacy prevalence (>5 medications)
- High-risk medication use in elderly
- Drug-drug interaction frequency
- Medication prior authorization approval rate
- Formulary compliance rate

**KEY INSIGHTS TO IDENTIFY:**
- Medication non-adherence patterns
- Populations at risk for medication errors
- Cost-saving opportunities (generic substitution)
- High-risk medication combinations
- Patients requiring medication therapy management
`;
  }

  // Patient Safety
  if (domainSet.has('Patient Safety')) {
    basePrompt += `
**PATIENT SAFETY METRICS:**
- Adverse event rate
- Medication error rate
- Fall rate (if applicable)
- Hospital-acquired infection rate
- Near-miss incident rate
- Patient safety incident reports by category
- Restraint/seclusion usage rate
- Suicide risk assessment completion rate
- Safety plan implementation rate

**KEY INSIGHTS TO IDENTIFY:**
- High-risk areas requiring immediate attention
- Trends in safety incidents over time
- Root causes of adverse events
- Prevention opportunities
- Training needs for staff
`;
  }

  // Demographics & Population Health
  if (domainSet.has('Demographics & Population')) {
    basePrompt += `
**DEMOGRAPHICS & POPULATION METRICS:**
- Age distribution and service utilization by age group
- Gender distribution and outcome differences
- Race/ethnicity distribution and health equity measures
- Primary language and interpretation needs
- Geographic distribution and access patterns
- Insurance type distribution
- Chronic disease prevalence by population segment
- Health literacy levels
- Vulnerable population identification

**KEY INSIGHTS TO IDENTIFY:**
- Health disparities by demographic group
- Underserved populations
- Culturally tailored intervention opportunities
- Access barriers for specific populations
- Population segmentation for targeted outreach
`;
  }

  // Provider Performance
  if (domainSet.has('Provider Performance')) {
    basePrompt += `
**PROVIDER PERFORMANCE METRICS:**
- Provider productivity (encounters per day/week)
- Panel size and complexity
- Patient satisfaction scores by provider
- Clinical outcome measures by provider
- No-show rates by provider
- Documentation completion timeliness
- Quality measure performance by provider
- Average visit duration
- Provider utilization rate

**KEY INSIGHTS TO IDENTIFY:**
- High-performing vs low-performing providers
- Caseload balancing opportunities
- Training and support needs
- Best practices to share across team
- Burnout risk indicators
`;
  }

  // Add fallback for generic clinical data
  if (domains.length === 0) {
    basePrompt += `
**GENERAL CLINICAL DATA ANALYSIS:**
Since no specific domains were detected, analyze the data comprehensively:
- Identify key performance indicators present in the data
- Calculate relevant rates, averages, and distributions
- Identify trends over time if temporal data is present
- Highlight outliers and areas of concern
- Provide population-level insights
- Recommend specific actions based on findings
`;
  }

  basePrompt += `

**OUTPUT FORMAT (MUST BE VALID JSON):**
{
  "title": "Clinical Data Insights Dashboard",
  "kpis": [
    {
      "label": "Descriptive KPI name",
      "value": numeric_value_only_no_dollar_signs_or_percent_symbols,
      "format": "number|percent|currency",
      "trend": "Optional trend description or comparison"
    }
  ],
  "charts": [
    {
      "type": "bar|line|pie|area",
      "title": "Clear, descriptive chart title",
      "config": {
        "labels": ["Category1", "Category2"],
        "data": [value1, value2],
        "xAxisLabel": "X-axis label (e.g., Month, Category)",
        "yAxisLabel": "Y-axis label (e.g., Count, Percentage)",
        "series": [{"name": "Series name", "data": [val1, val2]}]
      }
    }
  ],
  "insights": [
    "Specific, actionable insight based on the data",
    "Another insight with concrete recommendations",
    "Pattern or trend identified with clinical significance"
  ]
}

**CRITICAL CHART CREATION RULES:**
You MUST create AT LEAST 4 charts. Each chart MUST have real data from the dataset.

**REQUIRED CHART TYPES** (adapt based on data available):

1. **Categorical Distribution** (BAR chart)
   - Purpose: Show counts or totals by category
   - When: You have categorical data (service types, providers, diagnoses, etc.)
   - Example: "Services by Type", "Patients by Diagnosis", "Visits by Department"
   - Config must include: labels (category names), data (counts), xAxisLabel, yAxisLabel

2. **Time Trend** (LINE or AREA chart)
   - Purpose: Show changes over time
   - When: You have date/time data
   - Example: "Daily Admissions Trend", "Monthly Revenue", "Weekly Session Count"
   - Config must include: labels (dates), data (values), xAxisLabel ("Date/Month"), yAxisLabel (metric name)

3. **Composition/Proportion** (PIE chart)
   - Purpose: Show parts of a whole (percentages)
   - When: You want to show distribution as percentages
   - Example: "Service Mix", "Gender Distribution", "Payment Source Breakdown"
   - Config must include: labels (category names), data (counts or percentages)

4. **Comparison** (BAR chart)
   - Purpose: Compare metrics across categories
   - When: Comparing performance, costs, or outcomes
   - Example: "Average Cost by Service", "Sessions per Provider", "Recovery Rate by Treatment"
   - Config must include: labels (categories), data (values), xAxisLabel, yAxisLabel

**STEP-BY-STEP CHART CREATION:**
1. ANALYZE the data columns and identify:
   - Categorical columns (text values that repeat)
   - Numeric columns (counts, costs, durations)
   - Date/time columns
   
2. AGGREGATE the data:
   - Count rows by category
   - Sum numeric values
   - Calculate averages
   - Group by date periods

3. CREATE specific charts:
   - Chart 1: Count of [most common categorical field] (BAR)
   - Chart 2: Trend over time if dates exist (LINE)
   - Chart 3: Distribution of [another categorical field] (PIE)
   - Chart 4: Average/sum of [numeric field] by [category] (BAR)

**EXAMPLE FOR THERAPY SESSION DATA:**
If data contains: Client ID, Service Type, Practitioner, Date, Duration, Cost

Chart 1 (BAR): "Sessions by Service Type"
- labels: ["Individual Therapy 25min", "Individual Therapy 45min", "Group Therapy 60min"]
- data: [45, 78, 123] (counts)
- xAxisLabel: "Service Type"
- yAxisLabel: "Number of Sessions"

Chart 2 (LINE): "Daily Session Volume"
- labels: ["Sep 14", "Sep 15", "Sep 16", "Sep 17"]
- data: [23, 45, 38, 51] (count of sessions per day)
- xAxisLabel: "Date"
- yAxisLabel: "Sessions"

Chart 3 (PIE): "Service Duration Distribution"
- labels: ["25 minutes", "45 minutes", "60 minutes"]
- data: [15, 35, 50] (percentages or counts)

Chart 4 (BAR): "Sessions by Practitioner"
- labels: ["Smith, J", "Jones, M", "Lee, K"]
- data: [45, 67, 34] (session count per practitioner)
- xAxisLabel: "Practitioner"
- yAxisLabel: "Number of Sessions"

**REQUIREMENTS:**
- Provide 6-12 KPIs most relevant to the detected domains
- Create EXACTLY 4-8 charts that visualize key patterns (MANDATORY - DO NOT SKIP)
- Each chart MUST have actual data from the dataset (no empty charts)
- Generate 5-10 insights that are:
  * Specific and data-driven (reference actual numbers)
  * Actionable (suggest concrete next steps)
  * Clinically relevant (focus on patient outcomes and operational efficiency)
  * Prioritized by impact (most important insights first)

**CRITICAL FORMATTING RULES:**
- KPI values MUST be numeric only (no $, %, or other symbols)
- For currency: value should be the number (e.g., 42325.26, not "$42,325.26")
- For percentages: 
  * If the actual percentage is 4%, return value as 4 (not 0.04)
  * If data shows 0.04 as a decimal rate, convert to 4
  * Always return whole percentages (4, not 0.04)
- All chart data arrays MUST contain actual numeric values from the dataset
- Chart titles MUST be descriptive (not generic like "Chart 1")
- ALWAYS include xAxisLabel and yAxisLabel in chart config for bar/line/area charts
- Ensure all charts have proper labels array matching data array length
- MINIMUM 4 CHARTS REQUIRED - analyze the data and create meaningful visualizations

**IF YOU CANNOT CREATE CHARTS:**
- You are doing something wrong
- Re-read the data
- Look for categorical columns to count
- Look for numeric columns to sum/average
- Look for date columns to create time series
- Every dataset has chartable data - find it!

**DATA CONTEXT:**
${profile ? JSON.stringify(profile).slice(0, 500) : 'No profile available'}

Analyze the provided clinical data and return ONLY the JSON response with no additional text.`;

  return basePrompt;
}

export default async function handler(req, context) {
  const t0 = Date.now();
  const jobId = `clinical-${t0}-${Math.random().toString(36).slice(2, 8)}`;
  
  log("=".repeat(60));
  log("NEW CLINICAL INSIGHTS REQUEST", { jobId, timestamp: timestamp() });
  
  const storeName = "analytics-jobs";
  const store = getStore(storeName);
  log("Store initialized", { storeName });

  try {
    const body = await req.json();
    const { manifestKey, profileKey, domains, fileName } = body;

    log("Request parsed", { 
      manifestKey,
      profileKey,
      domains,
      fileName
    });

    if (!manifestKey) {
      log("ERROR: Missing manifestKey");
      return new Response(
        JSON.stringify({ error: "Missing required parameters" }),
        { status: 400, headers: H }
      );
    }

    // Save job metadata
    await store.setJSON(jobId, {
      status: "processing",
      manifestKey,
      profileKey,
      domains,
      fileName,
      startedAt: new Date().toISOString()
    });

    // Schedule background processing
    context.waitUntil(
      processInBackground(jobId, manifestKey, profileKey, domains, fileName, store)
    );

    log("Job scheduled", { jobId });
    return new Response(JSON.stringify({ jobId }), { status: 200, headers: H });

  } catch (error) {
    log("ERROR in handler", { error: error.message, stack: error.stack });
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: H }
    );
  }
}

async function processInBackground(jobId, manifestKey, profileKey, domains, fileName, store) {
  try {
    log("Background processing started", { jobId });

    // Read manifest
    const manifestStr = await store.get(manifestKey, { type: "text" });
    if (!manifestStr) {
      throw new Error("Manifest not found in Blobs");
    }
    const manifest = JSON.parse(manifestStr);
    log("Manifest loaded", { 
      parts: manifest.parts?.length,
      totalSize: manifest.totalSize,
      mimeType: manifest.mimeType
    });

    // Read profile
    let profile = null;
    if (profileKey) {
      const profileStr = await store.get(profileKey, { type: "text" });
      if (profileStr) {
        profile = JSON.parse(profileStr);
        log("Profile loaded", { 
          rows: profile.rowCount,
          columns: profile.columnCount
        });
      }
    }

    // Reconstruct file from chunks
    const chunks = [];
    for (const partIndex of manifest.parts) {
      // Construct the key like files-upload-chunk.js does
      const key = `${manifest.dataKey}-part-${String(partIndex).padStart(5, "0")}`;
      log(`Reading chunk ${partIndex}`, { key });
      
      // Read the JSON object (chunks are stored as JSON with base64 data)
      const chunkJson = await store.get(key, { type: "json" });
      if (!chunkJson || !chunkJson.data) {
        throw new Error(`Chunk ${partIndex} not found or invalid`);
      }
      
      // Decode base64 to bytes
      const chunkBytes = Buffer.from(chunkJson.data, "base64");
      log(`Chunk ${partIndex} decoded`, { size: chunkBytes.length });
      chunks.push(chunkBytes);
    }

    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const fileBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      fileBytes.set(chunk, offset);
      offset += chunk.length;
    }
    log("File reconstructed", { size: fileBytes.length });

    // Write to temp file
    const tmpPath = join(tmpdir(), `clinical-${jobId}-${fileName || 'data.csv'}`);
    await writeFile(tmpPath, fileBytes);
    log("Temp file written", { path: tmpPath });

    // Upload to Gemini Files API
    if (!APIKEY) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    const fileManager = new GoogleAIFileManager(APIKEY);
    log("Uploading to Gemini Files API...");
    
    const uploadResult = await fileManager.uploadFile(tmpPath, {
      mimeType: manifest.mimeType || "text/csv",
      displayName: fileName || "clinical-data.csv"
    });
    
    log("File uploaded to Gemini", { 
      uri: uploadResult.file.uri,
      name: uploadResult.file.name
    });

    // Wait for file processing
    let file = await fileManager.getFile(uploadResult.file.name);
    while (file.state === "PROCESSING") {
      log("Waiting for file processing...");
      await new Promise(r => setTimeout(r, 2000));
      file = await fileManager.getFile(uploadResult.file.name);
    }

    if (file.state === "FAILED") {
      throw new Error("Gemini file processing failed");
    }

    log("File ready for analysis", { state: file.state });

    // Generate clinical prompt
    const prompt = generateClinicalPrompt(domains, profile);
    log("Generated clinical prompt", { length: prompt.length });

    // Call Gemini API with JSON mode
    const genAI = new GoogleGenerativeAI(APIKEY);
    const model = genAI.getGenerativeModel({ 
      model: MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 1.0,
        topP: 0.95,
      }
    });

    log("Calling Gemini API for analysis...");
    const result = await model.generateContent([
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri
        }
      },
      { text: prompt }
    ]);

    const responseText = result.response.text();
    log("Received AI response", { length: responseText.length });

    // Parse and normalize response
    const cleaned = stripFences(responseText);
    const dashboard = normalizeSpec(JSON.parse(cleaned));
    
    log("Dashboard generated", { 
      kpis: dashboard.kpis?.length,
      charts: dashboard.charts?.length,
      insights: dashboard.insights?.length
    });

    // Save result
    await store.setJSON(jobId, {
      status: "complete",
      dashboard,
      completedAt: new Date().toISOString()
    });

    // Cleanup
    try {
      await unlink(tmpPath);
      log("Temp file deleted");
    } catch (e) {
      log("Failed to delete temp file", { error: e.message });
    }

    log("Processing complete", { jobId, duration: Date.now() - parseInt(jobId.split('-')[1]) });

  } catch (error) {
    log("ERROR in background processing", { 
      jobId,
      error: error.message,
      stack: error.stack
    });
    
    await store.setJSON(jobId, {
      status: "error",
      error: error.message,
      erroredAt: new Date().toISOString()
    });
  }
}
