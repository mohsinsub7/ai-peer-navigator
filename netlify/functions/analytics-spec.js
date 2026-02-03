
// netlify/functions/analytics-spec.js
import { GoogleGenAI } from "@google/genai";

const headers = { "content-type": "application/json; charset=utf-8" };

function stripFences(s=""){ return s.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```$/,"").replace(/```json/gi,"").replace(/```/g,"").trim(); }
function firstJson(s=""){ const m=String(s).match(/\{[\s\S]*\}/); return m?m[0]:s; }
function normalizeSpec(x={}){ if(!x.title && x.dashboardTitle) x.title=x.dashboardTitle; x.kpis=Array.isArray(x.kpis)?x.kpis:[]; x.charts=Array.isArray(x.charts)?x.charts:[]; x.insights=Array.isArray(x.insights)?x.insights:(x.insights?[x.insights]:[]); x.title=x.title||"Auto Dashboard"; return x; }

export default async (req) => {
  try {
    const { profile, sampleData = [] } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const model  = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    const ai = new GoogleGenAI({ apiKey });
    const resp = await ai.models.generateContent({
      model,
      contents: [
        { role:"user", parts:[{ text:"Return ONLY JSON for {title,kpis[],charts[],insights[]}. No prose. No code fences." }] },
        { role:"user", parts:[{ text: JSON.stringify({ profile, sample: sampleData.slice(0,300) }) }] }
      ],
      config:{
        responseMimeType:"application/json",
        responseSchema:{
          type:"object",
          properties:{
            title:{type:"string"}, kpis:{type:"array"}, charts:{type:"array"}, insights:{type:"array", items:{type:"string"}}
          },
          required:["title","kpis","charts","insights"]
        }
      }
    });

    const raw = resp?.text || "";
    const cleaned = stripFences(firstJson(raw));
    const parsed = JSON.parse(cleaned);
    const spec = normalizeSpec(parsed);
    return new Response(JSON.stringify(spec), { status:200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ title:"Auto Dashboard", kpis:[], charts:[], insights:["AI generation skipped."] }), { status:200, headers });
  }
};
