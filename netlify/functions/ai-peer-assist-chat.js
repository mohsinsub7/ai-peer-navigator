// netlify/functions/ai-peer-assist-chat.js
import { GoogleAuth } from "google-auth-library";

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };

// Vertex AI Configuration
const PROJECT_ID = "gen-lang-client-0731412858";
const LOCATION = "global";
const ENGINE_ID = "ai-peer-assist-multi-ds"; // Multi-data-store engine (PDFs + structured agency data)

// ── GEMINI GENERATION CONFIG ──
// Low temperature + narrow sampling for HIGH-FIDELITY mode:
// Clinical peer navigation requires deterministic, data-faithful responses.
// Addresses, phone numbers, and screening scores must be exact — no creativity.
const GENERATION_CONFIG = {
  temperature: 0.1,
  topK: 10,
  topP: 0.7,
  maxOutputTokens: 8192,
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

// ── REFERRAL EMAIL DETECTION ──
const REFERRAL_EMAIL_PATTERNS = [
  /\b(referral|refer)\b.*\b(email|letter|form|write-up)\b/i,
  /\b(write|draft|create|send|make|compose)\b.*\b(referral|refer)\b/i,
  /\b(email|write to)\b.*\b(agency|program|clinic|provider|center|service)\b/i,
  /\breferral for\b/i,
  /\b(warm handoff|referral letter|referral email)\b/i,
];

function isReferralEmailRequest(message) {
  return REFERRAL_EMAIL_PATTERNS.some(p => p.test(message));
}

const REFERRAL_EMAIL_INSTRUCTIONS = `You are an AI assistant helping a Peer Navigator draft a professional clinical referral email. Generate a COMPLETE, ready-to-send referral email based on the conversation context.

You must generate the email in the EXACT format below. Fill in every field with information from the conversation. Use placeholders in brackets ONLY where real data would be PHI.

---

**Subject:** Referral Request — [Service Category] Services for [CLIENT INITIALS or "Client"]

Dear [Agency/Program Name] Intake Coordinator,

I am writing to refer a client to your program for [specific services needed]. I am a Certified Peer Specialist/Peer Navigator providing community-based support services through [ORGANIZATION NAME].

**I. REFERRAL INFORMATION**

| Field | Details |
|-------|---------|
| **Date of Referral** | [Today's date] |
| **Referring Provider** | [PEER NAVIGATOR NAME], Certified Peer Specialist |
| **Organization** | [ORGANIZATION NAME] |
| **Phone** | [PHONE NUMBER] |
| **Email** | [EMAIL ADDRESS] |
| **Client Identifier** | [CLIENT INITIALS] |
| **Client Borough/Zip** | [Borough and zip code from conversation, or "To be provided at intake"] |

**II. REASON FOR REFERRAL**

[2-3 sentences summarizing the presenting concern based on what the navigator discussed in the conversation. Focus on observable needs and stated goals — NOT diagnoses. Use language like "client is seeking," "client reports needing," "client expressed interest in." Do NOT include PHI.]

**III. SERVICES REQUESTED**

[Bullet list of specific services the client needs based on the conversation. Examples:
- Outpatient mental health counseling
- Psychiatric evaluation and medication management
- Substance use treatment (IOP/outpatient)
- Individual/group therapy
- Case management
- Housing assistance/placement
- Benefits enrollment
- Vocational/employment support]

**IV. SCREENING RESULTS** (if applicable)

[If any screening was completed during this session, include:
- Screening tool administered (e.g., PHQ-9, AUDIT, GAD-7)
- Total score and severity level
- Key clinical flags (e.g., endorsed suicidal ideation, positive PTSD screen)
If no screening was done, write: "No standardized screening administered during this session. Referral is based on clinical observation and client self-report."]

**V. RELEVANT HISTORY & CONTEXT**

[1-3 sentences of relevant background that would help the receiving agency prepare for intake. Stay general — do NOT include specific dates, names, addresses, or other PHI. Focus on: what the client is currently experiencing, what supports are already in place, any barriers to care (transportation, language, insurance status), and strengths/protective factors.]

**VI. URGENCY LEVEL**

[Select one based on conversation context:
- **Routine** — Client is stable; intake within standard timeframe is appropriate
- **Urgent** — Client has escalating symptoms or deteriorating situation; expedited intake requested within 48-72 hours
- **Emergent** — Immediate safety concern; crisis services may be needed alongside this referral]

**VII. INSURANCE/COVERAGE**

[If mentioned in conversation, note insurance type (Medicaid, Medicare, private, uninsured). If not discussed, write: "Insurance status to be confirmed at intake."]

I am available to provide additional collateral information and to support the client through the referral and intake process. I am also happy to coordinate a warm handoff call at the agency's convenience.

Thank you for your partnership in this client's care and recovery.

Respectfully,

[PEER NAVIGATOR NAME], CPS
Peer Navigator / Certified Peer Specialist
[ORGANIZATION NAME]
[PHONE NUMBER]
[EMAIL ADDRESS]
[SUPERVISOR NAME & CREDENTIALS — if applicable]

---

## RULES:
- NEVER include real client names, DOB, SSN, addresses, or any PHI. Use [CLIENT INITIALS], [PEER NAVIGATOR NAME], etc.
- DO include screening results if any were completed (tool name, score, severity, flags)
- DO reference specific services the agency offers from the search results if available
- Determine urgency level from conversation context (default to Routine if unclear)
- Keep the tone professional, clinically appropriate, warm, and recovery-oriented
- Always include the Subject line
- If no specific agency was mentioned, use [AGENCY NAME] placeholder and list nearby agencies from search results
- If the conversation included discussion of multiple needs, list ALL relevant services under Section III
- Use person-first, strengths-based, trauma-informed language throughout`;

// ── SCREENING FORM ENGINE ──
// Complete behavioral health screening form definitions with questions, scoring, and interpretation

const SCREENING_FORMS = {
  "PHQ-4": {
    name: "PHQ-4 (Patient Health Questionnaire-4)",
    description: "Ultra-brief depression & anxiety screening",
    timeframe: "Over the last 2 weeks",
    questions: [
      "Feeling nervous, anxious or on edge",
      "Not being able to stop or control worrying",
      "Little interest or pleasure in doing things",
      "Feeling down, depressed, or hopeless"
    ],
    responseOptions: [
      { label: "Not at all", value: 0 },
      { label: "Several days", value: 1 },
      { label: "More than half the days", value: 2 },
      { label: "Nearly every day", value: 3 }
    ],
    maxScore: 12,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      const anxiety = responses[0] + responses[1];
      const depression = responses[2] + responses[3];
      let severity = "None";
      if (total >= 9) severity = "Severe";
      else if (total >= 6) severity = "Moderate";
      else if (total >= 3) severity = "Mild";
      return {
        total, severity,
        subscales: {
          anxiety: { score: anxiety, positive: anxiety >= 3 },
          depression: { score: depression, positive: depression >= 3 }
        },
        recommendation: anxiety >= 3 ? "Consider GAD-7 for anxiety assessment. " : "" +
          depression >= 3 ? "Consider PHQ-9 for depression assessment." : total < 3 ? "No further screening indicated at this time." : "Monitor and re-screen as needed."
      };
    }
  },
  "PHQ-9": {
    name: "PHQ-9 (Patient Health Questionnaire-9)",
    description: "Depression severity screening",
    timeframe: "Over the last 2 weeks",
    questions: [
      "Little interest or pleasure in doing things",
      "Feeling down, depressed, or hopeless",
      "Trouble falling or staying asleep, or sleeping too much",
      "Feeling tired or having little energy",
      "Poor appetite or overeating",
      "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
      "Trouble concentrating on things, such as reading the newspaper or watching television",
      "Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
      "Thoughts that you would be better off dead or of hurting yourself in some way"
    ],
    responseOptions: [
      { label: "Not at all", value: 0 },
      { label: "Several days", value: 1 },
      { label: "More than half the days", value: 2 },
      { label: "Nearly every day", value: 3 }
    ],
    functionalImpairment: "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?",
    functionalOptions: ["Not difficult at all", "Somewhat difficult", "Very difficult", "Extremely difficult"],
    maxScore: 27,
    criticalItem: 8, // Q9 (0-indexed) - suicidal ideation
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      let severity, recommendation;
      if (total >= 20) { severity = "Severe depression"; recommendation = "Immediate referral to mental health professional. Consider safety assessment (Q9). Active treatment strongly recommended."; }
      else if (total >= 15) { severity = "Moderately severe depression"; recommendation = "Referral to mental health professional recommended. Consider medication evaluation."; }
      else if (total >= 10) { severity = "Moderate depression"; recommendation = "Treatment plan should be discussed. Consider counseling referral and follow-up in 2-4 weeks."; }
      else if (total >= 5) { severity = "Mild depression"; recommendation = "Monitor symptoms. Discuss with client. Re-screen in 2-4 weeks. Consider supportive services."; }
      else { severity = "Minimal depression"; recommendation = "No immediate intervention needed. Continue regular check-ins."; }
      const q9Flag = responses[8] > 0;
      if (q9Flag) recommendation = "⚠️ CLIENT ENDORSED SUICIDAL IDEATION (Q9). Conduct safety assessment immediately. " + recommendation;
      return { total, severity, recommendation, suicidalIdeation: q9Flag };
    }
  },
  "GAD-7": {
    name: "GAD-7 (Generalized Anxiety Disorder-7)",
    description: "Anxiety severity screening",
    timeframe: "Over the last 2 weeks",
    questions: [
      "Feeling nervous, anxious or on edge",
      "Not being able to stop or control worrying",
      "Worrying too much about different things",
      "Trouble relaxing",
      "Being so restless that it is hard to sit still",
      "Becoming easily annoyed or irritable",
      "Feeling afraid as if something awful might happen"
    ],
    responseOptions: [
      { label: "Not at all", value: 0 },
      { label: "Several days", value: 1 },
      { label: "More than half the days", value: 2 },
      { label: "Nearly every day", value: 3 }
    ],
    maxScore: 21,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      let severity, recommendation;
      if (total >= 15) { severity = "Severe anxiety"; recommendation = "Referral to mental health professional strongly recommended. Consider medication evaluation."; }
      else if (total >= 10) { severity = "Moderate anxiety"; recommendation = "Discuss treatment options. Consider counseling referral. Re-screen in 2-4 weeks."; }
      else if (total >= 5) { severity = "Mild anxiety"; recommendation = "Monitor symptoms. Discuss coping strategies. Re-screen as needed."; }
      else { severity = "Minimal anxiety"; recommendation = "No intervention needed. Continue regular check-ins."; }
      return { total, severity, recommendation };
    }
  },
  "PC-PTSD-5": {
    name: "PC-PTSD-5 (Primary Care PTSD Screen)",
    description: "PTSD screening for trauma exposure",
    timeframe: "In the past month",
    screeningQuestion: "Sometimes things happen to people that are unusually or especially frightening, horrible, or traumatic. For example: a serious accident or fire, a physical or sexual assault or abuse, an earthquake or flood, a war, seeing someone be killed or seriously injured, having a loved one die through homicide or suicide. Have you ever experienced this kind of event?",
    questions: [
      "Had nightmares about the event(s) or thought about the event(s) when you did not want to?",
      "Tried hard not to think about the event(s) or went out of your way to avoid situations that reminded you of the event(s)?",
      "Been constantly on guard, watchful, or easily startled?",
      "Felt numb or detached from people, activities, or your surroundings?",
      "Felt guilty or unable to stop blaming yourself or others for the event(s) or any problems the event(s) may have caused?"
    ],
    responseOptions: [
      { label: "No", value: 0 },
      { label: "Yes", value: 1 }
    ],
    maxScore: 5,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      const positive = total >= 3;
      return {
        total, severity: positive ? "Positive screen for PTSD" : "Negative screen",
        recommendation: positive
          ? "Positive PTSD screen (≥3). Referral for comprehensive trauma assessment recommended. Consider PCL-5 for detailed evaluation."
          : "Negative PTSD screen. No further trauma assessment needed at this time unless clinical judgment indicates otherwise."
      };
    }
  },
  "PCL-5": {
    name: "PCL-5 (PTSD Checklist for DSM-5)",
    description: "Comprehensive 20-item PTSD symptom severity assessment. Use after positive PC-PTSD-5 screen.",
    timeframe: "In the past month, how much have you been bothered by:",
    questions: [
      "Repeated, disturbing, and unwanted memories of the stressful experience?",
      "Repeated, disturbing dreams of the stressful experience?",
      "Suddenly feeling or acting as if the stressful experience were actually happening again (as if you were actually back there reliving it)?",
      "Feeling very upset when something reminded you of the stressful experience?",
      "Having strong physical reactions when something reminded you of the stressful experience (e.g., heart pounding, trouble breathing, sweating)?",
      "Avoiding memories, thoughts, or feelings related to the stressful experience?",
      "Avoiding external reminders of the stressful experience (e.g., people, places, conversations, activities, objects, or situations)?",
      "Trouble remembering important parts of the stressful experience?",
      "Having strong negative beliefs about yourself, other people, or the world (e.g., having thoughts such as: I am bad, there is something seriously wrong with me, no one can be trusted, the world is completely dangerous)?",
      "Blaming yourself or someone else for the stressful experience or what happened after it?",
      "Having strong negative feelings such as fear, horror, anger, guilt, or shame?",
      "Loss of interest in activities that you used to enjoy?",
      "Feeling distant or cut off from other people?",
      "Trouble experiencing positive feelings (e.g., being unable to feel happiness or have loving feelings for people close to you)?",
      "Irritable behavior, angry outbursts, or acting aggressively?",
      "Taking too many risks or doing things that could cause you harm?",
      "Being 'superalert' or watchful or on guard?",
      "Feeling jumpy or easily startled?",
      "Having difficulty concentrating?",
      "Trouble falling or staying asleep?"
    ],
    responseOptions: [
      { label: "Not at all", value: 0 },
      { label: "A little bit", value: 1 },
      { label: "Moderately", value: 2 },
      { label: "Quite a bit", value: 3 },
      { label: "Extremely", value: 4 }
    ],
    maxScore: 80,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      const clusterB = responses.slice(0, 5).reduce((s, r) => s + r, 0);
      const clusterC = responses.slice(5, 7).reduce((s, r) => s + r, 0);
      const clusterD = responses.slice(7, 14).reduce((s, r) => s + r, 0);
      const clusterE = responses.slice(14, 20).reduce((s, r) => s + r, 0);
      const bCount = responses.slice(0, 5).filter(r => r >= 2).length;
      const cCount = responses.slice(5, 7).filter(r => r >= 2).length;
      const dCount = responses.slice(7, 14).filter(r => r >= 2).length;
      const eCount = responses.slice(14, 20).filter(r => r >= 2).length;
      const provisionalDx = bCount >= 1 && cCount >= 1 && dCount >= 2 && eCount >= 2;
      let severity, recommendation;
      if (total >= 31) {
        severity = "Probable PTSD (above clinical cutoff of 31)";
        recommendation = provisionalDx
          ? "Score ≥31 AND meets DSM-5 cluster criteria. Referral to trauma-specialized clinician for comprehensive assessment. Consider CPT, PE, or EMDR."
          : "Score ≥31 but does NOT meet full DSM-5 cluster criteria. Clinical interview recommended. Monitor symptoms.";
      } else if (total >= 20) {
        severity = "Moderate PTSD symptoms (below cutoff)";
        recommendation = "Subthreshold symptoms. Monitor over time. Consider trauma-focused support and re-screen in 4-6 weeks.";
      } else {
        severity = "Minimal/low PTSD symptoms";
        recommendation = "Low symptom severity. Continue supportive peer services. Re-screen if symptoms emerge or worsen.";
      }
      return {
        total, severity, recommendation,
        clusters: { intrusion: clusterB, avoidance: clusterC, negativeCognition: clusterD, arousal: clusterE },
        provisionalDiagnosis: provisionalDx
      };
    }
  },
  "AUDIT": {
    name: "AUDIT (Alcohol Use Disorders Identification Test)",
    description: "Alcohol use risk screening",
    timeframe: "Past year",
    questions: [
      "How often do you have a drink containing alcohol?",
      "How many drinks containing alcohol do you have on a typical day when you are drinking?",
      "How often do you have six or more drinks on one occasion?",
      "How often during the last year have you found that you were not able to stop drinking once you had started?",
      "How often during the last year have you failed to do what was normally expected from you because of drinking?",
      "How often during the last year have you needed a first drink in the morning to get yourself going after a heavy drinking session?",
      "How often during the last year have you had a feeling of guilt or remorse after drinking?",
      "How often during the last year have you been unable to remember what happened the night before because you had been drinking?",
      "Have you or someone else been injured as a result of your drinking?",
      "Has a relative or friend or a doctor or another health worker been concerned about your drinking or suggested you cut down?"
    ],
    responseOptions: [
      // Q1: frequency
      [{ label: "Never", value: 0 }, { label: "Monthly or less", value: 1 }, { label: "2-4 times a month", value: 2 }, { label: "2-3 times a week", value: 3 }, { label: "4+ times a week", value: 4 }],
      // Q2: quantity
      [{ label: "1 or 2", value: 0 }, { label: "3 or 4", value: 1 }, { label: "5 or 6", value: 2 }, { label: "7, 8, or 9", value: 3 }, { label: "10 or more", value: 4 }],
      // Q3-8: frequency
      ...Array(6).fill([{ label: "Never", value: 0 }, { label: "Less than monthly", value: 1 }, { label: "Monthly", value: 2 }, { label: "Weekly", value: 3 }, { label: "Daily or almost daily", value: 4 }]),
      // Q9-10: yes/no with scoring
      [{ label: "No", value: 0 }, { label: "Yes, but not in the last year", value: 2 }, { label: "Yes, during the last year", value: 4 }],
      [{ label: "No", value: 0 }, { label: "Yes, but not in the last year", value: 2 }, { label: "Yes, during the last year", value: 4 }]
    ],
    variableOptions: true, // Each question has different response options
    maxScore: 40,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      let zone, severity, recommendation;
      if (total >= 20) { zone = "IV"; severity = "Probable alcohol dependence"; recommendation = "Referral to specialist for diagnostic evaluation and treatment. Consider MOUD options if appropriate."; }
      else if (total >= 16) { zone = "III"; severity = "Harmful use / possible dependence"; recommendation = "Brief counseling and continued monitoring. Consider referral to substance use treatment."; }
      else if (total >= 8) { zone = "II"; severity = "Hazardous/harmful use"; recommendation = "Brief intervention — provide feedback and advice. Discuss risks and strategies to reduce use."; }
      else { zone = "I"; severity = "Low risk"; recommendation = "Alcohol education. No intervention needed at this time."; }
      return { total, zone, severity, recommendation };
    }
  },
  "DAST-10": {
    name: "DAST-10 (Drug Abuse Screening Test)",
    description: "Drug use screening (excludes alcohol)",
    timeframe: "Past 12 months",
    questions: [
      "Have you used drugs other than those required for medical reasons?",
      "Do you use more than one drug at a time?",
      "Are you always able to stop using drugs when you want to?",
      "Have you ever had blackouts or flashbacks as a result of drug use?",
      "Do you ever feel bad or guilty about your drug use?",
      "Does your spouse (or parents) ever complain about your involvement with drugs?",
      "Have you neglected your family because of your use of drugs?",
      "Have you engaged in illegal activities in order to obtain drugs?",
      "Have you ever experienced withdrawal symptoms (felt sick) when you stopped taking drugs?",
      "Have you had medical problems as a result of your drug use?"
    ],
    responseOptions: [
      { label: "No", value: 0 },
      { label: "Yes", value: 1 }
    ],
    reverseScored: [2], // Q3 is reverse scored (No=1, Yes=0)
    maxScore: 10,
    scoring: (responses) => {
      // Q3 is reverse scored
      const adjusted = responses.map((r, i) => i === 2 ? (r === 0 ? 1 : 0) : r);
      const total = adjusted.reduce((s, r) => s + r, 0);
      let zone, severity, recommendation;
      if (total >= 6) { zone = "4"; severity = "Very high risk / probable SUD"; recommendation = "Referral to specialist for diagnostic evaluation and treatment. Extended brief intervention recommended."; }
      else if (total >= 3) { zone = "3"; severity = "Intermediate risk"; recommendation = "Extended brief intervention. Discuss available treatment services. Consider referral."; }
      else if (total >= 1) { zone = "2"; severity = "Low-level problem use"; recommendation = "Brief intervention. Monitor and re-screen. Client may be at risk for developing chronic problems."; }
      else { zone = "1"; severity = "No risk identified"; recommendation = "No intervention needed at this time."; }
      return { total, zone, severity, recommendation };
    }
  },
  "CAGE-AID": {
    name: "CAGE-AID (CAGE Adapted to Include Drugs)",
    description: "Quick alcohol & drug use screening",
    timeframe: "Lifetime",
    questions: [
      "Have you ever felt that you ought to Cut down on your drinking or drug use?",
      "Have people Annoyed you by criticizing your drinking or drug use?",
      "Have you ever felt bad or Guilty about your drinking or drug use?",
      "Have you ever had a drink or used drugs first thing in the morning to steady your nerves or to get rid of a hangover (Eye-opener)?"
    ],
    responseOptions: [
      { label: "No", value: 0 },
      { label: "Yes", value: 1 }
    ],
    maxScore: 4,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      const positive = total >= 2;
      return {
        total,
        severity: positive ? "Positive screen — probable substance use concern" : total === 1 ? "Borderline — one positive response" : "Negative screen",
        recommendation: positive
          ? "Positive CAGE-AID (≥2). Further assessment recommended. Consider AUDIT for alcohol or DAST-10 for drugs."
          : total === 1
            ? "One positive response. Monitor and consider further screening at next visit."
            : "Negative screen. No further assessment needed at this time."
      };
    }
  },
  "ASQ": {
    name: "ASQ (Ask Suicide-Screening Questions)",
    description: "Suicide risk screening",
    timeframe: "Recent weeks",
    questions: [
      "In the past few weeks, have you wished you were dead?",
      "In the past few weeks, have you felt that you or your family would be better off if you were dead?",
      "In the past week, have you been having thoughts about killing yourself?",
      "Have you ever tried to kill yourself?"
    ],
    acuityQuestion: "Are you having thoughts of killing yourself right now?",
    responseOptions: [
      { label: "No", value: 0 },
      { label: "Yes", value: 1 }
    ],
    maxScore: 4,
    scoring: (responses, acuityResponse) => {
      const anyPositive = responses.some(r => r > 0);
      return {
        total: responses.reduce((s, r) => s + r, 0),
        positive: anyPositive,
        acute: acuityResponse === 1,
        severity: !anyPositive ? "Negative screen"
          : acuityResponse === 1 ? "ACUTE POSITIVE — IMMINENT RISK"
          : "Non-acute positive — potential risk",
        recommendation: !anyPositive
          ? "Negative suicide screen. No immediate intervention needed. Provide crisis resources anyway."
          : acuityResponse === 1
            ? "⚠️ ACUTE RISK: Patient cannot leave until safety evaluation is complete. Remove dangerous objects. Alert supervising clinician IMMEDIATELY. Call 988 or 911 if needed."
            : "⚠️ POSITIVE SCREEN: Brief suicide safety assessment required. Patient cannot leave until evaluated for safety. Alert supervising clinician. Provide 988 Lifeline number."
      };
    }
  },
  "CRAFFT": {
    name: "CRAFFT 2.0 (Substance Use Screening for Adolescents)",
    description: "Youth substance use screening",
    timeframe: "Past 12 months",
    partA: [
      "During the past 12 months, on how many days did you: Drink more than a few sips of beer, wine, or any drink containing alcohol?",
      "During the past 12 months, on how many days did you: Use any marijuana or 'synthetic marijuana'?",
      "During the past 12 months, on how many days did you: Use anything else to get high?"
    ],
    questions: [
      "Have you ever ridden in a CAR driven by someone (including yourself) who was 'high' or had been using alcohol or drugs?",
      "Do you ever use alcohol or drugs to RELAX, feel better about yourself, or fit in?",
      "Do you ever use alcohol or drugs while you are by yourself, or ALONE?",
      "Do you ever FORGET things you did while using alcohol or drugs?",
      "Do your FAMILY or FRIENDS ever tell you that you should cut down on your drinking or drug use?",
      "Have you ever gotten into TROUBLE while you were using alcohol or drugs?"
    ],
    responseOptions: [
      { label: "No", value: 0 },
      { label: "Yes", value: 1 }
    ],
    maxScore: 6,
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      const positive = total >= 2;
      return {
        total,
        severity: positive ? "Positive screen — substance use disorder risk" : "Lower risk",
        recommendation: positive
          ? "Positive CRAFFT (≥2). Further clinical assessment for substance use disorder recommended. Consider brief intervention."
          : "Negative CRAFFT screen. Provide education and continue to monitor."
      };
    }
  },
  "EPDS": {
    name: "EPDS (Edinburgh Postnatal Depression Scale)",
    description: "Postpartum depression screening",
    timeframe: "In the past 7 days",
    questions: [
      "I have been able to laugh and see the funny side of things",
      "I have looked forward with enjoyment to things",
      "I have blamed myself unnecessarily when things went wrong",
      "I have been anxious or worried for no good reason",
      "I have felt scared or panicky for no good reason",
      "Things have been getting to me",
      "I have been so unhappy that I have had difficulty sleeping",
      "I have felt sad or miserable",
      "I have been so unhappy that I have been crying",
      "The thought of harming myself has occurred to me"
    ],
    responseOptions: [
      // Q1
      [{ label: "As much as I always could", value: 0 }, { label: "Not quite so much now", value: 1 }, { label: "Definitely not so much now", value: 2 }, { label: "Not at all", value: 3 }],
      // Q2
      [{ label: "As much as I ever did", value: 0 }, { label: "Rather less than I used to", value: 1 }, { label: "Definitely less than I used to", value: 2 }, { label: "Hardly at all", value: 3 }],
      // Q3
      [{ label: "No, never", value: 0 }, { label: "Not very often", value: 1 }, { label: "Yes, some of the time", value: 2 }, { label: "Yes, most of the time", value: 3 }],
      // Q4
      [{ label: "No, not at all", value: 0 }, { label: "Hardly ever", value: 1 }, { label: "Yes, sometimes", value: 2 }, { label: "Yes, very often", value: 3 }],
      // Q5
      [{ label: "No, not at all", value: 0 }, { label: "No, not much", value: 1 }, { label: "Yes, sometimes", value: 2 }, { label: "Yes, quite a lot", value: 3 }],
      // Q6
      [{ label: "No, I have been coping as well as ever", value: 0 }, { label: "No, most of the time I have coped quite well", value: 1 }, { label: "Yes, sometimes I haven't been coping as well as usual", value: 2 }, { label: "Yes, most of the time I haven't been able to cope at all", value: 3 }],
      // Q7
      [{ label: "No, not at all", value: 0 }, { label: "No, not very often", value: 1 }, { label: "Yes, sometimes", value: 2 }, { label: "Yes, most of the time", value: 3 }],
      // Q8
      [{ label: "No, not at all", value: 0 }, { label: "Not very often", value: 1 }, { label: "Yes, quite often", value: 2 }, { label: "Yes, most of the time", value: 3 }],
      // Q9
      [{ label: "No, never", value: 0 }, { label: "Only occasionally", value: 1 }, { label: "Yes, quite often", value: 2 }, { label: "Yes, most of the time", value: 3 }],
      // Q10 (critical - self-harm)
      [{ label: "Never", value: 0 }, { label: "Hardly ever", value: 1 }, { label: "Sometimes", value: 2 }, { label: "Yes, quite often", value: 3 }]
    ],
    variableOptions: true,
    maxScore: 30,
    criticalItem: 9, // Q10 - self-harm thoughts
    scoring: (responses) => {
      const total = responses.reduce((s, r) => s + r, 0);
      const q10Flag = responses[9] > 0;
      let severity, recommendation;
      if (total >= 11) { severity = "Likely postpartum depression/anxiety"; recommendation = "Score ≥11: Referral to healthcare provider NOW. Clinical evaluation for PPD/anxiety needed."; }
      else if (total >= 9) { severity = "Borderline — possible PPD"; recommendation = "Score 9-10: Re-screen in 1 week OR contact healthcare provider. Close monitoring recommended."; }
      else { severity = "Low risk"; recommendation = "Score 1-8: Normal mood fluctuations may be present. If symptoms worsen or persist >2 weeks, contact provider."; }
      if (q10Flag) recommendation = "⚠️ CLIENT ENDORSED SELF-HARM THOUGHTS (Q10). Immediate safety assessment required. Contact healthcare provider or go to ER. " + recommendation;
      return { total, severity, recommendation, selfHarmFlag: q10Flag };
    }
  },
  "ASSIST": {
    name: "WHO ASSIST (Alcohol, Smoking and Substance Involvement Screening Test)",
    description: "Comprehensive multi-substance use screening covering tobacco, alcohol, cannabis, cocaine, amphetamines, inhalants, sedatives, hallucinogens, opioids, and other drugs.",
    timeframe: "In the past 3 months",
    // ASSIST is administered per substance. We use a simplified single-pass version
    // asking about the substance(s) the navigator indicates the client uses.
    questions: [
      "In your lifetime, which substances have you ever used? (Ask about: tobacco, alcohol, cannabis, cocaine, amphetamines, inhalants, sedatives, hallucinogens, opioids, other)",
      "In the past 3 months, how often have you used the substance(s) mentioned?",
      "During the past 3 months, how often have you had a strong desire or urge to use?",
      "During the past 3 months, how often has your use led to health, social, legal, or financial problems?",
      "During the past 3 months, how often have you failed to do what was normally expected of you because of your use?",
      "Has a friend, relative, or anyone else ever expressed concern about your use?",
      "Have you ever tried and failed to control, cut down, or stop using?",
      "Have you ever used any substance by injection?"
    ],
    responseOptions: [
      // Q1: multi-select (simplified to text entry)
      [{ label: "None", value: 0 }, { label: "One substance", value: 1 }, { label: "Two or more substances", value: 2 }],
      // Q2-5: frequency
      ...Array(4).fill([{ label: "Never", value: 0 }, { label: "Once or twice", value: 2 }, { label: "Monthly", value: 3 }, { label: "Weekly", value: 4 }, { label: "Daily or almost daily", value: 6 }]),
      // Q6-7: yes/no with timing
      [{ label: "No, never", value: 0 }, { label: "Yes, in the past 3 months", value: 6 }, { label: "Yes, but not in the past 3 months", value: 3 }],
      [{ label: "No, never", value: 0 }, { label: "Yes, in the past 3 months", value: 6 }, { label: "Yes, but not in the past 3 months", value: 3 }],
      // Q8: injection
      [{ label: "No, never", value: 0 }, { label: "Yes, in the past 3 months", value: 2 }, { label: "Yes, but not in the past 3 months", value: 1 }]
    ],
    variableOptions: true,
    maxScore: 39,
    scoring: (responses) => {
      // Substance-Specific Involvement Score (SSIS) = sum of Q2-Q7
      const ssis = responses.slice(1, 7).reduce((s, r) => s + r, 0);
      const injectionRisk = responses[7] > 0;
      let severity, recommendation, riskLevel;
      if (ssis >= 27) {
        riskLevel = "High"; severity = "High risk — likely substance dependence";
        recommendation = "High-risk score (≥27). Referral to specialist treatment and/or intensive intervention. Consider MOUD for opioid use. Assess for withdrawal management needs.";
      } else if (ssis >= 4) {
        riskLevel = "Moderate"; severity = "Moderate risk — hazardous/harmful use";
        recommendation = "Moderate-risk score (4-26). Brief intervention recommended. Provide psychoeducation on risks, discuss harm reduction strategies, and monitor.";
      } else {
        riskLevel = "Low"; severity = "Low risk";
        recommendation = "Low-risk score (0-3). No intervention needed at this time. Provide general health education.";
      }
      if (injectionRisk) {
        recommendation = "⚠️ INJECTION DRUG USE REPORTED. Assess for: BBV risk (HIV/HCV), access to clean equipment, naloxone availability, wound care needs. " + recommendation;
      }
      return { total: ssis, severity, recommendation, riskLevel, injectionRisk };
    }
  }
};

// Screening form request detection patterns
const SCREENING_REQUEST_PATTERNS = [
  /\b(administer|give|do|start|run|conduct|begin|take|fill out|complete)\b.*\b(phq[- ]?[249]|gad[- ]?7|pc[- ]?ptsd|pcl[- ]?5|audit|dast|cage|crafft|asq|epds|assist)\b/i,
  /\b(phq[- ]?[249]|gad[- ]?7|pc[- ]?ptsd|pcl[- ]?5|audit|dast|cage|crafft|asq|epds|assist)\b.*\b(screening|screen|form|assessment|questionnaire|tool)\b/i,
  /\b(screen|screening|assess)\b.*\b(depression|anxiety|ptsd|trauma|alcohol|drug|substance|suicide|postpartum)\b/i,
  /\b(phq[- ]?[249]|gad[- ]?7|pc[- ]?ptsd|pcl[- ]?5|audit|dast|cage|crafft|asq|epds|assist)\b\s*$/i,
];

function isScreeningRequest(message) {
  return SCREENING_REQUEST_PATTERNS.some(p => p.test(message));
}

function detectScreeningForm(message) {
  const msg = message.toLowerCase().replace(/[- ]/g, '');
  if (/phq9/.test(msg)) return "PHQ-9";
  if (/phq4/.test(msg)) return "PHQ-4";
  if (/phq2/.test(msg)) return "PHQ-4"; // PHQ-2 is first 2 items of PHQ-4
  if (/gad7/.test(msg)) return "GAD-7";
  if (/pcptsd/.test(msg)) return "PC-PTSD-5";
  if (/pcl5/.test(msg)) return "PCL-5";
  if (/\bassist\b/.test(message.toLowerCase())) return "ASSIST";
  if (/audit/.test(msg)) return "AUDIT";
  if (/dast/.test(msg)) return "DAST-10";
  if (/cage/.test(msg)) return "CAGE-AID";
  if (/crafft/.test(msg)) return "CRAFFT";
  if (/asq/.test(msg)) return "ASQ";
  if (/epds/.test(msg)) return "EPDS";
  // Detect by condition
  if (/\b(depress|mood|sad|hopeless)\b/i.test(message)) return "PHQ-9";
  if (/\b(anxiet|worry|nervous|panic)\b/i.test(message)) return "GAD-7";
  if (/\b(ptsd|trauma|nightmar)\b/i.test(message)) return "PC-PTSD-5";
  if (/\b(alcohol|drink)\b/i.test(message)) return "AUDIT";
  if (/\b(drug|substance|heroin|cocaine|fentanyl|opioid|poly.?substance)\b/i.test(message)) return "DAST-10";
  if (/\b(suicid|kill|self.?harm)\b/i.test(message)) return "ASQ";
  if (/\b(postpartum|perinatal|pregnan|baby|birth|maternal)\b/i.test(message)) return "EPDS";
  if (/\b(teen|adolesc|youth|minor)\b/i.test(message)) return "CRAFFT";
  return "PHQ-4"; // default to PHQ-4 as initial screener
}

// Build screening prompt for Gemini to administer the form interactively
function buildScreeningPrompt(formId, screeningState) {
  const form = SCREENING_FORMS[formId];
  if (!form) return null;

  const { currentQuestion, responses } = screeningState;
  const totalQuestions = form.questions.length;

  if (currentQuestion >= totalQuestions) {
    // All questions answered — score and interpret
    const result = form.scoring(responses);
    return {
      complete: true,
      result,
      formId,
      formName: form.name,
      responses,
      totalQuestions
    };
  }

  // Get response options for current question
  let options;
  if (form.variableOptions && Array.isArray(form.responseOptions[currentQuestion])) {
    options = form.responseOptions[currentQuestion];
  } else {
    options = form.responseOptions;
  }

  return {
    complete: false,
    formId,
    formName: form.name,
    questionNumber: currentQuestion + 1,
    totalQuestions,
    timeframe: form.timeframe,
    questionText: form.questions[currentQuestion],
    options,
    progress: Math.round((currentQuestion / totalQuestions) * 100)
  };
}

// Parse user's screening response (numeric or text) into a score value
function parseScreeningResponse(input, options) {
  const trimmed = input.trim().toLowerCase();

  // Try numeric first
  const num = parseInt(trimmed);
  if (!isNaN(num)) {
    // If it's a direct index (0, 1, 2, 3...)
    const opt = options.find(o => o.value === num);
    if (opt) return num;
    // If it's a 1-based selection
    if (num >= 1 && num <= options.length) return options[num - 1].value;
  }

  // Try text matching
  for (const opt of options) {
    if (trimmed === opt.label.toLowerCase() || trimmed.startsWith(opt.label.toLowerCase().substring(0, 4))) {
      return opt.value;
    }
  }

  // Common yes/no shortcuts
  if (/^(yes|y|yeah|yep|si)$/i.test(trimmed)) {
    const yesOpt = options.find(o => o.label.toLowerCase().startsWith('yes'));
    if (yesOpt) return yesOpt.value;
    return options[options.length - 1]?.value; // Last option for yes
  }
  if (/^(no|n|nah|nope)$/i.test(trimmed)) {
    const noOpt = options.find(o => o.label.toLowerCase().startsWith('no'));
    if (noOpt) return noOpt.value;
    return options[0]?.value; // First option for no
  }

  return null; // Couldn't parse
}

// ── SCREENING NEED DETECTION (proactive suggestion) ──
// Only scans the CURRENT message (not full history) to avoid irrelevant suggestions
// on follow-up questions. E.g., mentioning "marijuana" once shouldn't trigger DAST-10
// on every subsequent message about unrelated topics.
function detectScreeningNeed(message, history) {
  const allText = message;
  const suggestions = [];

  if (/\b(depress|sad|hopeless|crying|no energy|can't sleep|lost interest|worthless|guilt)\b/i.test(allText)) {
    suggestions.push({ form: "PHQ-4", reason: "Client may be experiencing depressive symptoms" });
  }
  if (/\b(anxious|anxiety|worry|worried|nervous|panic|can't relax|on edge|restless)\b/i.test(allText)) {
    suggestions.push({ form: "GAD-7", reason: "Client may be experiencing anxiety symptoms" });
  }
  if (/\b(trauma|ptsd|nightmare|flashback|assault|abuse|violence|combat)\b/i.test(allText)) {
    suggestions.push({ form: "PC-PTSD-5", reason: "Client may have trauma/PTSD indicators" });
  }
  if (/\b(drink|alcohol|beer|wine|liquor|blackout|hungover)\b/i.test(allText)) {
    suggestions.push({ form: "AUDIT", reason: "Client mentions alcohol use" });
  }
  if (/\b(drug|cocaine|heroin|fentanyl|meth|pill|substance|using|high|inject)\b/i.test(allText)) {
    suggestions.push({ form: "DAST-10", reason: "Client mentions drug use" });
  }
  if (/\b(suicid|kill (my|him|her|them)self|want to die|better off dead|self.?harm)\b/i.test(allText)) {
    suggestions.push({ form: "ASQ", reason: "Client may be at suicide risk" });
  }
  if (/\b(pregnant|postpartum|baby|birth|maternal|perinatal|new mom|new mother)\b/i.test(allText)) {
    suggestions.push({ form: "EPDS", reason: "Client is perinatal/postpartum" });
  }

  return suggestions;
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

// ── NYC ZIP CODE GEOCODING (approximate centroids for distance calculation) ──
const NYC_ZIP_COORDS = {
  // MANHATTAN
  10001:[40.7506,-73.9971],10002:[40.7157,-73.9863],10003:[40.7317,-73.9893],10004:[40.6988,-74.0384],
  10005:[40.7069,-74.0089],10006:[40.7094,-74.0131],10007:[40.7134,-74.0079],10009:[40.7265,-73.9793],
  10010:[40.7390,-73.9826],10011:[40.7418,-74.0002],10012:[40.7258,-73.9981],10013:[40.7198,-74.0030],
  10014:[40.7339,-74.0066],10016:[40.7459,-73.9781],10017:[40.7527,-73.9728],10018:[40.7549,-73.9929],
  10019:[40.7654,-73.9856],10020:[40.7587,-73.9787],10021:[40.7693,-73.9588],10022:[40.7581,-73.9683],
  10023:[40.7764,-73.9828],10024:[40.7870,-73.9724],10025:[40.7986,-73.9682],10026:[40.8028,-73.9531],
  10027:[40.8119,-73.9541],10028:[40.7764,-73.9539],10029:[40.7918,-73.9440],10030:[40.8186,-73.9426],
  10031:[40.8247,-73.9494],10032:[40.8384,-73.9427],10033:[40.8494,-73.9349],10034:[40.8671,-73.9245],
  10035:[40.7963,-73.9315],10036:[40.7590,-73.9901],10037:[40.8133,-73.9378],10038:[40.7093,-74.0018],
  10039:[40.8267,-73.9369],10040:[40.8584,-73.9298],10044:[40.7618,-73.9500],10065:[40.7646,-73.9632],
  10069:[40.7759,-73.9896],10075:[40.7706,-73.9560],10103:[40.7614,-73.9776],10110:[40.7537,-73.9802],
  10111:[40.7591,-73.9782],10112:[40.7590,-73.9789],10115:[40.8107,-73.9642],10119:[40.7506,-73.9935],
  10128:[40.7815,-73.9502],10152:[40.7583,-73.9716],10153:[40.7637,-73.9724],10154:[40.7583,-73.9725],
  10162:[40.7692,-73.9555],10165:[40.7525,-73.9781],10167:[40.7544,-73.9748],10168:[40.7513,-73.9768],
  10169:[40.7545,-73.9746],10170:[40.7529,-73.9758],10171:[40.7559,-73.9730],10172:[40.7541,-73.9731],
  10173:[40.7536,-73.9801],10174:[40.7529,-73.9789],10177:[40.7525,-73.9757],10199:[40.7510,-73.9975],
  10271:[40.7083,-74.0136],10278:[40.7155,-74.0116],10279:[40.7131,-74.0089],10280:[40.7086,-74.0170],
  10282:[40.7171,-74.0151],
  // BRONX
  10451:[40.8201,-73.9234],10452:[40.8369,-73.9236],10453:[40.8531,-73.9126],10454:[40.8073,-73.9189],
  10455:[40.8140,-73.9089],10456:[40.8310,-73.9076],10457:[40.8469,-73.8988],10458:[40.8631,-73.8894],
  10459:[40.8262,-73.8932],10460:[40.8419,-73.8796],10461:[40.8460,-73.8429],10462:[40.8433,-73.8603],
  10463:[40.8800,-73.9067],10464:[40.8677,-73.7999],10465:[40.8232,-73.8207],10466:[40.8893,-73.8470],
  10467:[40.8733,-73.8714],10468:[40.8678,-73.8992],10469:[40.8684,-73.8525],10470:[40.8951,-73.8642],
  10471:[40.8979,-73.8997],10472:[40.8319,-73.8686],10473:[40.8191,-73.8581],10474:[40.8118,-73.8852],
  10475:[40.8764,-73.8274],
  // BROOKLYN
  11201:[40.6936,-73.9905],11203:[40.6491,-73.9352],11204:[40.6188,-73.9847],11205:[40.6949,-73.9667],
  11206:[40.7020,-73.9427],11207:[40.6612,-73.8930],11208:[40.6694,-73.8716],11209:[40.6225,-74.0295],
  11210:[40.6288,-73.9468],11211:[40.7120,-73.9547],11212:[40.6633,-73.9133],11213:[40.6713,-73.9359],
  11214:[40.5992,-73.9970],11215:[40.6625,-73.9860],11216:[40.6810,-73.9499],11217:[40.6816,-73.9775],
  11218:[40.6435,-73.9762],11219:[40.6312,-73.9965],11220:[40.6393,-74.0110],11221:[40.6912,-73.9280],
  11222:[40.7276,-73.9486],11223:[40.5984,-73.9735],11224:[40.5770,-73.9876],11225:[40.6625,-73.9541],
  11226:[40.6462,-73.9576],11228:[40.6157,-74.0132],11229:[40.6012,-73.9434],11230:[40.6217,-73.9658],
  11231:[40.6793,-74.0000],11232:[40.6594,-74.0054],11233:[40.6785,-73.9199],11234:[40.6049,-73.9210],
  11235:[40.5841,-73.9493],11236:[40.6394,-73.9009],11237:[40.7039,-73.9204],11238:[40.6795,-73.9638],
  11239:[40.6477,-73.8792],11241:[40.6905,-73.9872],11242:[40.6890,-73.9848],11243:[40.6826,-73.9730],
  11249:[40.7009,-73.9617],11251:[40.6994,-73.9897],11252:[40.6910,-73.9900],11256:[40.7083,-73.9449],
  // QUEENS
  11004:[40.7455,-73.7114],11005:[40.7552,-73.7132],11101:[40.7474,-73.9399],11102:[40.7715,-73.9211],
  11103:[40.7625,-73.9117],11104:[40.7440,-73.9204],11105:[40.7783,-73.9077],11106:[40.7617,-73.9306],
  11109:[40.7463,-73.9560],11351:[40.7817,-73.8295],11354:[40.7680,-73.8270],11355:[40.7512,-73.8202],
  11356:[40.7844,-73.8448],11357:[40.7869,-73.8102],11358:[40.7619,-73.7967],11359:[40.7903,-73.7784],
  11360:[40.7816,-73.7811],11361:[40.7636,-73.7728],11362:[40.7564,-73.7351],11363:[40.7725,-73.7468],
  11364:[40.7460,-73.7589],11365:[40.7397,-73.7927],11366:[40.7284,-73.7854],11367:[40.7279,-73.8225],
  11368:[40.7494,-73.8540],11369:[40.7633,-73.8733],11370:[40.7649,-73.8921],11371:[40.7732,-73.8675],
  11372:[40.7518,-73.8842],11373:[40.7367,-73.8784],11374:[40.7261,-73.8615],11375:[40.7207,-73.8454],
  11377:[40.7448,-73.9043],11378:[40.7217,-73.9073],11379:[40.7166,-73.8791],11385:[40.7004,-73.8895],
  11411:[40.6937,-73.7367],11412:[40.6978,-73.7575],11413:[40.6687,-73.7524],11414:[40.6574,-73.8440],
  11415:[40.7079,-73.8273],11416:[40.6841,-73.8499],11417:[40.6765,-73.8431],11418:[40.6990,-73.8329],
  11419:[40.6879,-73.8264],11420:[40.6733,-73.8175],11421:[40.6940,-73.8580],11422:[40.6592,-73.7363],
  11423:[40.7155,-73.7673],11426:[40.7356,-73.7227],11427:[40.7306,-73.7452],11428:[40.7204,-73.7413],
  11429:[40.7098,-73.7386],11430:[40.6504,-73.7875],11432:[40.7157,-73.7932],11433:[40.6976,-73.7872],
  11434:[40.6774,-73.7756],11435:[40.7014,-73.8101],11436:[40.6760,-73.7963],11691:[40.5958,-73.7665],
  11692:[40.5930,-73.7915],11693:[40.5889,-73.8090],11694:[40.5794,-73.8376],11697:[40.5559,-73.8795],
  // STATEN ISLAND
  10301:[40.6432,-74.0769],10302:[40.6313,-74.1377],10303:[40.6303,-74.1629],10304:[40.6070,-74.0895],
  10305:[40.5961,-74.0733],10306:[40.5716,-74.1264],10307:[40.5096,-74.2456],10308:[40.5510,-74.1508],
  10309:[40.5270,-74.2179],10310:[40.6327,-74.1160],10311:[40.6055,-74.1793],10312:[40.5442,-74.1738],
  10314:[40.5986,-74.1632],
};

// Haversine formula for distance in miles
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Get distance between two zip codes in miles (returns null if either zip is unknown)
function getZipDistance(zip1, zip2) {
  const coords1 = NYC_ZIP_COORDS[parseInt(zip1)];
  const coords2 = NYC_ZIP_COORDS[parseInt(zip2)];
  if (!coords1 || !coords2) return null;
  return haversineDistance(coords1[0], coords1[1], coords2[0], coords2[1]);
}

// Get all zip codes within a given radius (miles) of a target zip
function getZipsWithinRadius(targetZip, radiusMiles) {
  const targetCoords = NYC_ZIP_COORDS[parseInt(targetZip)];
  if (!targetCoords) return [];
  const result = [];
  for (const [zip, coords] of Object.entries(NYC_ZIP_COORDS)) {
    const dist = haversineDistance(targetCoords[0], targetCoords[1], coords[0], coords[1]);
    if (dist <= radiusMiles) {
      result.push({ zip: String(zip), distance: Math.round(dist * 10) / 10 });
    }
  }
  return result.sort((a, b) => a.distance - b.distance);
}

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

## MODEL CONFINEMENT (MANDATORY):
- You MUST ONLY use information from: (1) the search results provided below, (2) the conversation history, and (3) the core peer support knowledge embedded in these instructions.
- If a question falls outside your data, say: "I don't have specific information about that in my knowledge base. Please consult your supervisor or check with your agency's clinical team."
- NEVER generate agency names, addresses, or phone numbers that are NOT in the search results. If you don't have a matching resource, say so honestly and suggest calling 311 or NYC Well (1-888-692-9355).
- When presenting agency contact details (address, phone, hours), ONLY use data from the "VERIFIED RESOURCES FROM NYC AGENCY DIRECTORY" section. The "GUIDELINES" section may mention agencies but those addresses may be outdated. The structured directory is the single source of truth for contact information.
- NEVER provide clinical diagnoses, prescribe medications, or give medical advice.
- If search results are empty or irrelevant, be transparent: "I couldn't find matching resources in my directory for that specific need."
- You are an AI assistant for Peer Navigators ONLY — never interact as if the client is present.
- HIGH-FIDELITY MODE: When presenting agency information, you MUST copy addresses and phone numbers EXACTLY as shown in the VERIFIED RESOURCES section. Do not paraphrase, abbreviate, or modify addresses. If an agency is not listed in VERIFIED RESOURCES, do NOT provide any address or phone for it.
- ZERO-HALLUCINATION RULE: Never generate, infer, or recall addresses, phone numbers, or hours of operation from your training data. ONLY use contact details that appear verbatim in the VERIFIED RESOURCES section of this prompt. The GUIDELINES section has had contact details removed — do not attempt to reconstruct them.
- If a user asks about a specific agency and it is not in VERIFIED RESOURCES, say: "I found [agency name] mentioned in our guidelines but I don't have verified contact details for them in our directory. Please check their website directly or call 311 for current information."

## PROXIMITY-BASED REFERRALS (CRITICAL):
- When presenting agencies, ALWAYS show the approximate distance from the client's location if distance data is provided.
- Present agencies in order: closest first.
- If agencies are marked with distance ranges, present those within 5 miles FIRST, then 5-10 miles, then 10-20 miles.
- Only show agencies beyond 10 miles if no closer options exist for the client's need.
- Always state: "These agencies are within X miles of your client's zip code [XXXXX]."
- If no agencies are found within 20 miles, suggest calling 311 for additional options.

## SAFETY PLANNING (Stanley-Brown Model):
When a navigator reports that a client has endorsed suicidal ideation, self-harm, or a positive ASQ/PHQ-9 Q9 flag, offer to walk through a structured safety plan. Use the Stanley-Brown Safety Planning Intervention steps:

1. **Warning Signs** — Help identify the thoughts, moods, situations, or behaviors that precede a crisis. Ask: "What does your client notice when things start to get bad?"
2. **Internal Coping Strategies** — Things the client can do ALONE to distract themselves (e.g., go for a walk, listen to music, exercise, deep breathing). Ask: "What has helped your client take their mind off things in the past?"
3. **People and Social Settings That Provide Distraction** — People the client can contact or places they can go for social support WITHOUT discussing the crisis. Ask: "Who can your client be around that helps them feel better, even without talking about what's wrong?"
4. **People to Ask for Help** — Specific people the client can reach out to for help during a crisis. Ask: "Who can your client call or text when they need someone to talk to about what they're going through?"
5. **Professionals and Agencies to Contact** — Therapist, psychiatrist, crisis hotline, ER. Include: 988 Suicide & Crisis Lifeline, NYC Well (1-888-692-9355), Crisis Text Line (text HOME to 741741), local ER information.
6. **Making the Environment Safe** — Reducing access to lethal means. Ask: "Are there any items at home that could be dangerous during a crisis? Can we discuss ways to make the space safer?"

Present each step one at a time. After completing all 6 steps, offer to compile the safety plan into a note the navigator can share or print.

## MOTIVATIONAL INTERVIEWING (MI) PROMPTS:
When a navigator discusses a client with substance use concerns, ambivalence about treatment, or resistance to change, provide MI-aligned guidance using the OARS framework:

- **Open-ended questions** — Suggest questions like: "What would you like to see change about your use?" / "What concerns you most about continuing?" / "Tell me about a time you felt different about using."
- **Affirmations** — Suggest strengths-based statements: "It takes courage to talk about this" / "You've shown real resilience in managing..." / "The fact that you're here shows you care about your well-being."
- **Reflections** — Model reflective listening: "It sounds like you're feeling torn between..." / "So on one hand... and on the other hand..." / "What I'm hearing is that [substance] used to help, but now it's causing problems."
- **Summaries** — Help the navigator pull it together: "Let me summarize what you've shared..." / "So far you've mentioned..." / "It sounds like the most important things to you are..."

Also suggest exploring:
- **Readiness ruler**: "On a scale of 1-10, how ready does your client feel to make a change?"
- **Decisional balance**: Pros and cons of changing vs. staying the same
- **Stages of Change**: Pre-contemplation, Contemplation, Preparation, Action, Maintenance — tailor approach to client's stage
- **Change talk vs. Sustain talk**: Highlight when client expresses desire, ability, reason, or need for change

Always frame MI guidance for the NAVIGATOR to use with their client, not directed at the client.

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
6. Do NOT include ICD-10 codes, diagnostic codes, or billing codes of any kind. Peer Specialists do not diagnose or assign codes — this is outside the scope of peer support practice.
7. Do NOT add barriers, diagnoses, social determinants, or clinical details that were NOT explicitly discussed in the conversation. Only document what was actually said or observed.
8. The note should be COPY-PASTE READY for the chart - no extra commentary or guidance.

## FORMAT: %%FORMAT%%

%%FORMAT_TEMPLATE%%

## OUTPUT:
Return ONLY the clinical note. No preamble, no "Here's your note:", no additional commentary. Just the note itself, ready to paste into the chart.`;

const FORMAT_TEMPLATES = {
  SOAP: `SOAP (Subjective/Objective/Assessment/Plan)

**S - Subjective:** What the client reported/stated. Direct quotes when possible. Include presenting concerns, barriers, and self-reported symptoms.

**O - Objective:** Observable facts. Client's appearance, behavior, affect, engagement level. Services/resources accessed. Measurable data.

**A - Assessment:** Peer specialist's assessment of the situation. Barriers identified. Progress toward goals. Risk level (low/moderate/high).

**P - Plan:** Specific next steps. Follow-up date/time. Referrals made. Resources to be contacted. Client's agreed-upon actions.`,

  DAP: `DAP (Data/Assessment/Plan)

**D - Data:** All relevant information gathered during the session. Client statements, behaviors observed, barriers discussed, interventions used, resources provided.

**A - Assessment:** Peer specialist's assessment of client progress, barriers, engagement level, and risk factors.

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
  // NOTE: Removed overly broad catch-all (/assist|help|support|resource|service|refer|need/)
  // that matched nearly every message. The fallback in detectResourceCategories() already
  // returns ["community services", "social services"] when no specific category matches.
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

// ── FUTURE: NATIVE GROUNDING (Vertex AI Search + Gemini) ──
// Vertex AI supports grounding Gemini directly on data stores, which would
// replace our manual search→inject→generate pipeline and reduce hallucinations.
// To enable, add this to the generateContent request body:
//
// tools: [{
//   retrieval: {
//     vertexAiSearch: {
//       datastore: `projects/${PROJECT_ID}/locations/global/collections/default_collection/dataStores/agencylist-ds`
//     }
//   }
// }]
//
// Note: This grounds on a SINGLE data store. For multi-store (agencies + PDFs),
// evaluate whether to ground on agencies only (highest accuracy) or both.
// Current approach: manual search gives us proximity filtering + source separation.
// TODO: Evaluate native grounding in a future sprint for improved accuracy.

// ── VERTEX AI SEARCH (with multi-strategy location search) ──
const SEARCH_URL = `https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_search:search`;

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

  // --- Strategy 1: Proximity-based zip code search ---
  // Search agencies in the client's zip code AND nearby zips (within 10mi radius)
  if (zipcode) {
    // Get nearby zips for expanded search
    const nearbyZips = getZipsWithinRadius(zipcode, 10).map(z => z.zip);
    const zipFilter = nearbyZips.length > 0
      ? `zipcode: ANY(${nearbyZips.slice(0, 20).map(z => `"${z}"`).join(',')})`
      : `zipcode: ANY("${zipcode}")`;

    for (const searchTerm of categories.slice(0, 3)) {
      // Search with proximity zip filter
      searches.push(
        singleSearch(searchTerm, accessToken, zipFilter)
          .then(r => { console.log(`[SEARCH] proximity ${zipcode} (${nearbyZips.length} zips) + "${searchTerm}": ${r.length} results`); return r; })
      );
    }

    // Also search exact zip for precision
    if (nearbyZips.length > 1) {
      searches.push(
        singleSearch(categories[0] || query, accessToken, `zipcode: ANY("${zipcode}")`)
          .then(r => { console.log(`[SEARCH] exact zip ${zipcode}: ${r.length} results`); return r; })
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

  // --- Strategy 3: Extended radius search (20mi) for sparse areas ---
  // Adds broader geographic coverage when nearby results may be few
  if (zipcode) {
    const extendedZips = getZipsWithinRadius(zipcode, 20).map(z => z.zip);
    if (extendedZips.length > 10) {
      const extFilter = `zipcode: ANY(${extendedZips.slice(0, 30).map(z => `"${z}"`).join(',')})`;
      searches.push(
        singleSearch(categories[0] || query, accessToken, extFilter)
          .then(r => { console.log(`[SEARCH] extended 20mi (${extendedZips.length} zips): ${r.length} results`); return r; })
      );
    }
  }

  // --- Strategy 4: Semantic search with location context (no filter) ---
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

// ── STRIP ADDRESSES FROM PDF SNIPPETS ──
// Removes street addresses, phone numbers, and zip codes from guideline/PDF snippets
// to prevent the model from using outdated contact info from PDFs instead of the
// verified structured directory. This is the primary defense against address hallucination.
function stripAddressesFromSnippet(text) {
  if (!text) return text;
  return text
    // Remove street addresses (number + street name patterns)
    .replace(/\d{1,5}\s+[\w\s.]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Place|Pl|Lane|Ln|Way|Court|Ct|Terrace|Slip|Broadway|Floor|Fl)\b[.,]?\s*(?:\d{0,3}(?:st|nd|rd|th)\s*(?:Floor|Fl\.?))?\s*/gi, '[address removed] ')
    // Remove NYC city/state + zip patterns
    .replace(/\b(?:New York|NY|Brooklyn|Bronx|Queens|Staten Island)[,\s]+(?:NY\s+)?\d{5}(?:-\d{4})?\b/gi, '')
    // Remove standalone NYC zip codes (10xxx, 11xxx)
    .replace(/\b1[01]\d{3}(?:-\d{4})?\b/g, '')
    // Remove phone number patterns
    .replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone removed]')
    // Clean up extra whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
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
        // Strip addresses/phones from PDF snippets to prevent model from using
        // outdated contact info instead of the verified structured directory
        const cleanedContent = stripAddressesFromSnippet(content.substring(0, 500));
        guidelineSnippets.push({
          source: sourceName || 'Peer Support Guidelines',
          content: cleanedContent,
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

    // Calculate actual distance if we have a target zip
    if (targetZip && zipcode) {
      const dist = getZipDistance(targetZip, zipcode);
      if (dist !== null) {
        resource._distanceMiles = Math.round(dist * 10) / 10;
      }
    }

    // Fallback distance indicators
    if (targetZip && zipcode === targetZip) {
      resource._exactZipMatch = true;
      if (!resource._distanceMiles) resource._distanceMiles = 0;
    } else if (targetBorough && borough.toUpperCase() === targetBorough.toUpperCase()) {
      resource._boroughMatch = true;
    }

    resources.push(resource);
  }

  let context = '';

  // ── Guideline/PDF knowledge section ──
  if (guidelineSnippets.length > 0) {
    context += `\n\n═══ PEER SUPPORT GUIDELINES & EVIDENCE-BASED PRACTICES ═══\n`;
    context += `(Information from official guideline documents. CITE the source when using this information.)\n`;
    context += `IMPORTANT: This section is for clinical guidance, best practices, and policy reference ONLY. Do NOT use addresses, phone numbers, or contact details from this section. For agency contact information, ONLY use the VERIFIED RESOURCES section below.\n\n`;
    guidelineSnippets.forEach((g, i) => {
      context += `📖 Source: "${g.source}"\n`;
      context += `${g.content}\n\n`;
    });
    context += `═══ END OF GUIDELINES ═══\n`;
    context += `CITATION INSTRUCTIONS: When referencing guideline content above, cite the source document name (e.g., "According to the Health Services guidelines..." or "Per the Peer Specialist Training Manual...").\n\n`;
  }

  // ── Agency directory section with proximity-based filtering ──
  if (resources.length > 0) {
    // Sort by distance (nearest first), then exact zip, then borough
    resources.sort((a, b) => {
      const aDist = a._distanceMiles ?? 999;
      const bDist = b._distanceMiles ?? 999;
      if (aDist !== bDist) return aDist - bDist;
      if (a._exactZipMatch && !b._exactZipMatch) return -1;
      if (!a._exactZipMatch && b._exactZipMatch) return 1;
      if (a._boroughMatch && !b._boroughMatch) return -1;
      if (!a._boroughMatch && b._boroughMatch) return 1;
      return 0;
    });

    // Apply proximity-based filtering: 5-10mi primary, expand to 20mi if needed
    let filteredResources = resources;
    if (targetZip) {
      const within10 = resources.filter(r => r._distanceMiles !== undefined && r._distanceMiles <= 10);
      if (within10.length >= 3) {
        // Enough agencies within 10 miles — show only those
        filteredResources = within10;
      } else {
        // Expand to 20 miles
        const within20 = resources.filter(r => r._distanceMiles !== undefined && r._distanceMiles <= 20);
        if (within20.length > 0) {
          filteredResources = within20;
        }
        // If still nothing within 20mi, show all results (with distance if available)
      }
    }

    context += `\n═══ VERIFIED RESOURCES FROM NYC AGENCY DIRECTORY (1,016 agencies) ═══\n`;
    context += `(These are REAL agencies with verified addresses and phone numbers. Present them with full details. Do NOT use placeholders.)\n`;
    if (targetZip) context += `Client's zip code: ${targetZip}`;
    if (targetBorough) context += ` (${targetBorough})`;
    if (targetZip || targetBorough) context += ` — showing agencies nearest to client.\n`;
    context += `\n`;

    filteredResources.forEach((r, i) => {
      // Build distance/proximity tag
      let locationTag = '';
      if (r._distanceMiles !== undefined) {
        if (r._distanceMiles === 0) locationTag = ' ★ IN CLIENT ZIP (0 mi)';
        else if (r._distanceMiles <= 5) locationTag = ` ★ ${r._distanceMiles} mi away`;
        else if (r._distanceMiles <= 10) locationTag = ` ● ${r._distanceMiles} mi away`;
        else locationTag = ` ○ ${r._distanceMiles} mi away (extended range)`;
      } else if (r._exactZipMatch) {
        locationTag = ' ★ IN CLIENT ZIP';
      } else if (r._boroughMatch) {
        locationTag = ' ● SAME BOROUGH';
      }

      context += `${i + 1}. **${r.name}**${locationTag}\n`;
      if (r.program) context += `   Program: ${r.program}\n`;
      if (r.site) context += `   Site: ${r.site}\n`;
      if (r.category) context += `   Category: ${r.category.replace(/_/g, ' ')}\n`;
      if (r.address) context += `   Address: ${r.address}\n`;
      if (r.phone) context += `   Phone: ${r.phone}\n`;
      else context += `   Phone: Not listed — call 311 for info\n`;
      if (r.hours) context += `   Hours: ${r.hours}\n`;
      if (r.notes) context += `   Notes: ${r.notes}\n`;
      context += `\n`;
    });

    context += `═══ END OF VERIFIED RESOURCES ═══\n`;
    context += `RESOURCE INSTRUCTIONS (MANDATORY): \n`;
    context += `1. When presenting agencies, ONLY use addresses, phone numbers, and contact details from THIS "VERIFIED RESOURCES" section. NEVER use addresses or phone numbers found in the GUIDELINES section above.\n`;
    context += `2. Present agencies in order shown above (nearest first). Include the distance in your response.\n`;
    context += `3. Agencies marked ★ are within 5 miles — highlight these as the closest options.\n`;
    context += `4. Agencies marked ● are within 5-10 miles — present as secondary options.\n`;
    context += `5. Agencies marked ○ are 10-20 miles — only mention if no closer options exist.\n`;
    context += `6. ALWAYS include the phone number prominently.\n`;
    context += `7. Do NOT invent, hallucinate, or add placeholder resource details.\n`;
    context += `8. If none match the client's need, say so honestly and suggest calling 311 or NYC Well (1-888-692-9355).\n`;
    context += `9. If an agency appears in both the GUIDELINES and VERIFIED RESOURCES sections, ALWAYS use the address and phone from THIS section — the structured directory is the authoritative source for contact details.\n`;
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

  const url = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`;

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
    const { message, history, screeningState: incomingScreeningState } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Message required" }), {
        status: 400,
        headers: H
      });
    }

    console.log("[AI-PEER-ASSIST] User message:", message.substring(0, 100));
    console.log("[AI-PEER-ASSIST] History turns:", (history || []).length);
    if (incomingScreeningState) console.log("[AI-PEER-ASSIST] Active screening:", incomingScreeningState.formId, "Q" + (incomingScreeningState.currentQuestion + 1));

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
      console.log("[AI-PEER-ASSIST] CRISIS DETECTED — returning crisis protocol");
      return new Response(JSON.stringify({
        response: CRISIS_RESPONSE,
        mode: 'crisis',
        noteFormat: null
      }), {
        status: 200,
        headers: H
      });
    }

    // ── PHI DETECTION (warn if personally identifiable information detected) ──
    const PHI_PATTERNS = [
      { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, type: 'email address' },
      { pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, type: 'phone number' },
      { pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/, type: 'SSN' },
      { pattern: /\b(?:0[1-9]|1[0-2])[/-](?:0[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b/, type: 'date of birth' },
      { pattern: /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Ave|Blvd|Dr|Ln|Rd|Way|Ct|Pl|Cir|Pkwy|Hwy|Apt|Suite|Unit)\b/i, type: 'street address' },
    ];
    let phiWarning = '';
    const detectedPHI = PHI_PATTERNS.filter(p => p.pattern.test(message));
    if (detectedPHI.length > 0) {
      const types = detectedPHI.map(p => p.type).join(', ');
      phiWarning = `\n\n---\n\n> ⚠️ **Confidentiality Notice:** I noticed what appears to be ${types} in your message. For client confidentiality, please use initials or placeholders like [CLIENT_NAME] instead of real identifiers. This system does not store data permanently, but it's best practice to avoid sharing PHI.`;
      console.log("[AI-PEER-ASSIST] PHI detected in message:", types);
    }

    // ── SCREENING MODE: Handle active screening session ──
    if (incomingScreeningState && incomingScreeningState.formId) {
      const form = SCREENING_FORMS[incomingScreeningState.formId];
      if (form) {
        const currentQ = incomingScreeningState.currentQuestion || 0;
        const responses = [...(incomingScreeningState.responses || [])];

        // Get options for current question
        let options;
        if (form.variableOptions && Array.isArray(form.responseOptions[currentQ])) {
          options = form.responseOptions[currentQ];
        } else {
          options = form.responseOptions;
        }

        // Parse user's response
        const parsedValue = parseScreeningResponse(message, options);

        if (parsedValue === null) {
          // Couldn't parse response — ask again
          const optionLabels = options.map((o, i) => `${i}: ${o.label}`).join('\n');
          return new Response(JSON.stringify({
            response: `I didn't understand that response. Please enter a number or text matching one of these options:\n\n${optionLabels}`,
            mode: 'screening',
            screeningState: incomingScreeningState
          }), { status: 200, headers: H });
        }

        // Record response and advance
        responses.push(parsedValue);
        const nextQuestion = currentQ + 1;
        const updatedState = {
          formId: incomingScreeningState.formId,
          currentQuestion: nextQuestion,
          responses,
          startTime: incomingScreeningState.startTime
        };

        // Check if screening is complete
        const promptData = buildScreeningPrompt(incomingScreeningState.formId, updatedState);

        if (promptData.complete) {
          // Screening complete — generate results
          const result = promptData.result;
          let resultText = `### Screening Complete: ${promptData.formName}\n\n`;
          resultText += `**Total Score:** ${result.total} / ${form.maxScore}\n`;
          resultText += `**Severity:** ${result.severity}\n\n`;
          if (result.zone) resultText += `**Risk Zone:** ${result.zone}\n`;
          if (result.riskLevel) resultText += `**Risk Level:** ${result.riskLevel}\n`;
          if (result.subscales) {
            resultText += `**Anxiety Subscale:** ${result.subscales.anxiety.score}/6 ${result.subscales.anxiety.positive ? '(POSITIVE)' : '(negative)'}\n`;
            resultText += `**Depression Subscale:** ${result.subscales.depression.score}/6 ${result.subscales.depression.positive ? '(POSITIVE)' : '(negative)'}\n\n`;
          }
          if (result.clusters) {
            resultText += `\n**DSM-5 PTSD Symptom Clusters:**\n`;
            resultText += `- Intrusion (B): ${result.clusters.intrusion}/20\n`;
            resultText += `- Avoidance (C): ${result.clusters.avoidance}/8\n`;
            resultText += `- Negative Cognition/Mood (D): ${result.clusters.negativeCognition}/28\n`;
            resultText += `- Arousal/Reactivity (E): ${result.clusters.arousal}/24\n`;
            if (result.provisionalDiagnosis !== undefined) {
              resultText += `- **Provisional PTSD Diagnosis:** ${result.provisionalDiagnosis ? 'YES — meets DSM-5 cluster criteria' : 'No — does not meet full criteria'}\n`;
            }
            resultText += `\n`;
          }
          if (result.injectionRisk) {
            resultText += `\n**⚠️ INJECTION DRUG USE:** Client reports history of injection use. Assess BBV risk, naloxone access, harm reduction needs.\n\n`;
          }
          resultText += `---\n\n### Recommendation\n${result.recommendation}\n\n`;
          resultText += `---\n\n### Response Summary\n`;
          form.questions.forEach((q, i) => {
            let optLabel;
            if (form.variableOptions && Array.isArray(form.responseOptions[i])) {
              optLabel = form.responseOptions[i].find(o => o.value === responses[i])?.label || responses[i];
            } else {
              optLabel = form.responseOptions.find(o => o.value === responses[i])?.label || responses[i];
            }
            resultText += `${i + 1}. ${q}: **${optLabel}** (${responses[i]})\n`;
          });

          if (result.suicidalIdeation || result.selfHarmFlag || result.acute) {
            resultText += `\n---\n\n### SAFETY ALERT\n${result.recommendation}\n`;
          }

          console.log(`[AI-PEER-ASSIST] Screening complete: ${incomingScreeningState.formId}, score=${result.total}, severity=${result.severity}`);

          return new Response(JSON.stringify({
            response: resultText,
            mode: 'screening_complete',
            screeningResult: {
              formId: incomingScreeningState.formId,
              formName: promptData.formName,
              score: result.total,
              maxScore: form.maxScore,
              severity: result.severity,
              recommendation: result.recommendation,
              responses,
              questions: form.questions,
              responseLabels: responses.map((r, i) => {
                if (form.variableOptions && Array.isArray(form.responseOptions[i])) {
                  return form.responseOptions[i].find(o => o.value === r)?.label || String(r);
                }
                return form.responseOptions.find(o => o.value === r)?.label || String(r);
              }),
              zone: result.zone,
              clusters: result.clusters,
              provisionalDiagnosis: result.provisionalDiagnosis,
              injectionRisk: result.injectionRisk,
              suicidalIdeation: result.suicidalIdeation,
              selfHarmFlag: result.selfHarmFlag,
              acute: result.acute
            }
          }), { status: 200, headers: H });
        }

        // Present next question
        let nextText = `### ${promptData.formName}\n`;
        nextText += `**Question ${promptData.questionNumber} of ${promptData.totalQuestions}** | ${promptData.timeframe}\n\n`;
        nextText += `> ${promptData.questionText}\n\n`;
        nextText += promptData.options.map((o, i) => `**${i}** — ${o.label}`).join('\n');

        return new Response(JSON.stringify({
          response: nextText,
          mode: 'screening',
          screeningState: updatedState,
          screeningProgress: {
            questionNumber: promptData.questionNumber,
            totalQuestions: promptData.totalQuestions,
            progress: promptData.progress,
            formName: promptData.formName
          }
        }), { status: 200, headers: H });
      }
    }

    // ── Detect if this is a screening form request (new screening) ──
    const wantsScreening = isScreeningRequest(message);
    if (wantsScreening) {
      const formId = detectScreeningForm(message);
      const form = SCREENING_FORMS[formId];
      if (form) {
        const newState = { formId, currentQuestion: 0, responses: [], startTime: Date.now() };
        const promptData = buildScreeningPrompt(formId, newState);

        let introText = `### Starting ${form.name}\n`;
        introText += `*${form.description}*\n\n`;
        if (form.screeningQuestion) {
          introText += `**First, a screening question:** ${form.screeningQuestion}\n\n`;
          introText += `Please ask your client and enter **Yes** or **No**.\n\n---\n\n`;
          introText += `If YES, we'll proceed with the ${form.questions.length} screening questions.\nIf NO, screening is complete (no trauma exposure identified).\n`;
        } else {
          introText += `This screening has **${form.questions.length} questions**. For each, ask your client and enter their response.\n\n---\n\n`;
          introText += `**Question ${promptData.questionNumber} of ${promptData.totalQuestions}** | ${promptData.timeframe}\n\n`;
          introText += `> ${promptData.questionText}\n\n`;
          introText += promptData.options.map((o, i) => `**${i}** — ${o.label}`).join('\n');
        }

        console.log(`[AI-PEER-ASSIST] Starting screening: ${formId}`);

        return new Response(JSON.stringify({
          response: introText,
          mode: 'screening',
          screeningState: newState,
          screeningProgress: {
            questionNumber: promptData.questionNumber,
            totalQuestions: promptData.totalQuestions,
            progress: 0,
            formName: form.name
          }
        }), { status: 200, headers: H });
      }
    }

    // ── Detect if this is a referral email request ──
    const wantsReferralEmail = isReferralEmailRequest(message);
    console.log("[AI-PEER-ASSIST] Referral email request?", wantsReferralEmail);

    // ── Detect if this is a note generation request ──
    const wantsNote = !wantsReferralEmail && isNoteRequest(message);
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

    if (wantsReferralEmail) {
      // REFERRAL EMAIL MODE — search for agency context, then generate email
      let agencyContext = "";
      const searchLocation = (location.zipcode || location.borough) ? location : null;
      try {
        const searchResults = await searchVertexAI(message, accessToken, searchLocation, history);
        if (searchResults.length > 0) {
          agencyContext = buildResourceContext(searchResults, location);
        }
      } catch (searchError) {
        console.warn("[AI-PEER-ASSIST] Search for referral email failed", { message: searchError?.message });
      }

      systemPrompt = REFERRAL_EMAIL_INSTRUCTIONS;

      let emailPrompt = `Draft a referral email based on our conversation. ${message}`;
      if (agencyContext) {
        emailPrompt += `\n\n--- AVAILABLE AGENCY CONTEXT ---\n${agencyContext}`;
      }

      contents.push({ role: "user", parts: [{ text: emailPrompt }] });
      console.log("[AI-PEER-ASSIST] Generating referral email");

    } else if (wantsNote) {
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

    // ── Proactive screening suggestions (only in guidance mode, not resource lookups) ──
    let screeningSuggestions = null;
    const isResourceLookup = /\b(address|location|where is|agency|center|service center|tell me about|find me|near|close to|directions|hours|phone number)\b/i.test(message);
    if (!wantsNote && !wantsReferralEmail && !isResourceLookup) {
      const suggestions = detectScreeningNeed(message, history);
      if (suggestions.length > 0) {
        screeningSuggestions = suggestions;
        const suggestionText = suggestions.map(s => `- **${s.form}**: ${s.reason}`).join('\n');
        response += `\n\n---\n\n### 📋 Screening Suggestion\nBased on this conversation, you might consider administering:\n${suggestionText}\n\nWould you like me to walk you through any of these screenings? Just say "start [form name]" (e.g., "start PHQ-9").`;
      }
    }

    // Append PHI warning if detected
    if (phiWarning) {
      response += phiWarning;
    }

    // Determine response mode
    const responseMode = wantsReferralEmail ? 'referral_email' : (wantsNote ? 'note' : 'guidance');

    console.log("[AI-PEER-ASSIST] Response generated", {
      length: response.length,
      mode: responseMode,
      locationUsed: !!(location.zipcode || location.borough),
      screeningSuggestions: screeningSuggestions?.length || 0,
      phiDetected: detectedPHI.length > 0
    });

    return new Response(JSON.stringify({
      response,
      mode: responseMode,
      noteFormat: noteFormat,
      screeningSuggestions
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
