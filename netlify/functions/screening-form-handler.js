// netlify/functions/screening-form-handler.js
// Generates a filled PDF for completed screening assessments using pdf-lib
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const H = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type"
};

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: H });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: H });
  }

  try {
    const body = await req.json();
    const { screeningResult } = body;

    if (!screeningResult || !screeningResult.formId) {
      return new Response(JSON.stringify({ error: "Missing screening result data" }), { status: 400, headers: H });
    }

    const pdfBytes = await generateScreeningPDF(screeningResult);

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${screeningResult.formId}_${new Date().toISOString().split('T')[0]}.pdf"`,
        "access-control-allow-origin": "*"
      }
    });

  } catch (error) {
    console.error("[SCREENING-PDF] Error:", error);
    return new Response(JSON.stringify({ error: "Failed to generate PDF", details: error.message }), {
      status: 500, headers: H
    });
  }
}

async function generateScreeningPDF(result) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_W = 612; // Letter width
  const PAGE_H = 792; // Letter height
  const MARGIN = 50;
  const LINE_H = 14;
  const SECTION_GAP = 8;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // Colors
  const BLACK = rgb(0, 0, 0);
  const DARK_BLUE = rgb(0.07, 0.15, 0.35);
  const ACCENT = rgb(0.15, 0.25, 0.68);
  const GRAY = rgb(0.4, 0.4, 0.4);
  const LIGHT_GRAY = rgb(0.85, 0.85, 0.85);
  const RED = rgb(0.75, 0.1, 0.1);
  const GREEN = rgb(0.05, 0.45, 0.15);

  function addPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }

  function checkPageBreak(needed = 30) {
    if (y < MARGIN + needed) addPage();
  }

  function drawText(text, x, size, color, usedFont) {
    checkPageBreak();
    page.drawText(text, { x, y, size, font: usedFont || font, color: color || BLACK });
    y -= LINE_H;
  }

  function drawLine(x1, x2) {
    page.drawLine({ start: { x: x1, y: y + 6 }, end: { x: x2, y: y + 6 }, thickness: 0.5, color: LIGHT_GRAY });
  }

  // ── HEADER ──
  page.drawRectangle({ x: 0, y: PAGE_H - 80, width: PAGE_W, height: 80, color: DARK_BLUE });
  page.drawText(result.formName || result.formId, {
    x: MARGIN, y: PAGE_H - 40, size: 16, font: fontBold, color: rgb(1, 1, 1)
  });
  page.drawText('Behavioral Health Screening Assessment', {
    x: MARGIN, y: PAGE_H - 58, size: 10, font: fontItalic, color: rgb(0.7, 0.8, 1)
  });
  page.drawText(`Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, {
    x: PAGE_W - MARGIN - 180, y: PAGE_H - 40, size: 9, font: font, color: rgb(0.8, 0.8, 0.9)
  });

  y = PAGE_H - 100;

  // ── CLIENT INFO SECTION ──
  drawText('CLIENT INFORMATION', MARGIN, 11, ACCENT, fontBold);
  drawLine(MARGIN, PAGE_W - MARGIN);
  y -= 4;

  const infoFields = [
    ['Client Name/ID:', '[CLIENT NAME / INITIALS]'],
    ['Date of Birth:', '[DOB]'],
    ['Navigator:', '[PEER NAVIGATOR NAME]'],
    ['Organization:', '[ORGANIZATION]'],
    ['Assessment Date:', new Date().toLocaleDateString('en-US')],
  ];

  for (const [label, value] of infoFields) {
    checkPageBreak();
    page.drawText(label, { x: MARGIN, y, size: 9, font: fontBold, color: GRAY });
    page.drawText(value, { x: MARGIN + 120, y, size: 9, font: font, color: BLACK });
    y -= LINE_H;
  }

  y -= SECTION_GAP;

  // ── RESULTS SUMMARY ──
  drawText('RESULTS SUMMARY', MARGIN, 11, ACCENT, fontBold);
  drawLine(MARGIN, PAGE_W - MARGIN);
  y -= 4;

  // Score box
  checkPageBreak(50);
  const scoreBoxY = y - 35;
  page.drawRectangle({ x: MARGIN, y: scoreBoxY, width: 150, height: 40, color: rgb(0.93, 0.95, 1), borderColor: ACCENT, borderWidth: 1 });
  page.drawText('TOTAL SCORE', { x: MARGIN + 10, y: scoreBoxY + 25, size: 8, font: fontBold, color: ACCENT });
  page.drawText(`${result.score} / ${result.maxScore}`, { x: MARGIN + 10, y: scoreBoxY + 7, size: 16, font: fontBold, color: DARK_BLUE });

  // Severity box
  const sevColor = /severe|high|probable|positive|dependence|harmful/i.test(result.severity) ? RED :
                   /moderate|borderline|hazardous/i.test(result.severity) ? rgb(0.7, 0.5, 0) : GREEN;
  page.drawRectangle({ x: MARGIN + 170, y: scoreBoxY, width: PAGE_W - 2 * MARGIN - 170, height: 40, color: rgb(0.97, 0.97, 0.97), borderColor: sevColor, borderWidth: 1 });
  page.drawText('SEVERITY', { x: MARGIN + 180, y: scoreBoxY + 25, size: 8, font: fontBold, color: sevColor });
  // Wrap severity text if long
  const sevText = result.severity || 'N/A';
  if (sevText.length > 55) {
    page.drawText(sevText.substring(0, 55), { x: MARGIN + 180, y: scoreBoxY + 12, size: 9, font: fontBold, color: sevColor });
    page.drawText(sevText.substring(55), { x: MARGIN + 180, y: scoreBoxY + 2, size: 9, font: fontBold, color: sevColor });
  } else {
    page.drawText(sevText, { x: MARGIN + 180, y: scoreBoxY + 7, size: 10, font: fontBold, color: sevColor });
  }

  y = scoreBoxY - 15;

  // Zone if present (AUDIT)
  if (result.zone) {
    drawText(`Risk Zone: ${result.zone}`, MARGIN, 9, GRAY, fontBold);
  }

  // Clusters if present (PCL-5)
  if (result.clusters) {
    drawText('DSM-5 PTSD Symptom Clusters:', MARGIN, 9, ACCENT, fontBold);
    const clusterLabels = {
      intrusion: 'Intrusion (B, Q1-5)',
      avoidance: 'Avoidance (C, Q6-7)',
      negativeCognition: 'Negative Cognition/Mood (D, Q8-14)',
      arousal: 'Arousal/Reactivity (E, Q15-20)'
    };
    for (const [key, label] of Object.entries(clusterLabels)) {
      if (result.clusters[key] !== undefined) {
        drawText(`    ${label}: ${result.clusters[key]}`, MARGIN, 9, GRAY, font);
      }
    }
    if (result.provisionalDiagnosis !== undefined) {
      const dxColor = result.provisionalDiagnosis ? RED : GREEN;
      drawText(`    Provisional PTSD Diagnosis: ${result.provisionalDiagnosis ? 'YES — meets DSM-5 criteria' : 'No — does not meet full criteria'}`, MARGIN, 9, dxColor, fontBold);
    }
  }

  y -= SECTION_GAP;

  // ── RECOMMENDATION ──
  drawText('CLINICAL RECOMMENDATION', MARGIN, 11, ACCENT, fontBold);
  drawLine(MARGIN, PAGE_W - MARGIN);
  y -= 4;

  // Word-wrap recommendation text
  const recText = result.recommendation || 'No recommendation available.';
  const maxCharsPerLine = 85;
  const recLines = wrapText(recText, maxCharsPerLine);
  for (const line of recLines) {
    checkPageBreak();
    page.drawText(line, { x: MARGIN, y, size: 9, font: font, color: BLACK });
    y -= LINE_H;
  }

  y -= SECTION_GAP;

  // ── SAFETY FLAGS ──
  if (result.suicidalIdeation || result.selfHarmFlag || result.acute || result.injectionRisk) {
    checkPageBreak(40);
    page.drawRectangle({ x: MARGIN, y: y - 25, width: PAGE_W - 2 * MARGIN, height: 30, color: rgb(1, 0.92, 0.92), borderColor: RED, borderWidth: 1.5 });
    page.drawText('⚠ SAFETY ALERT — Immediate Review Required', {
      x: MARGIN + 10, y: y - 15, size: 10, font: fontBold, color: RED
    });
    y -= 40;
  }

  y -= SECTION_GAP;

  // ── RESPONSE DETAIL ──
  drawText('ITEM-BY-ITEM RESPONSES', MARGIN, 11, ACCENT, fontBold);
  drawLine(MARGIN, PAGE_W - MARGIN);
  y -= 4;

  if (result.questions && result.responses) {
    for (let i = 0; i < result.questions.length; i++) {
      checkPageBreak(30);

      // Question number + text
      const qText = `${i + 1}. ${result.questions[i]}`;
      const qLines = wrapText(qText, 75);
      for (const line of qLines) {
        page.drawText(line, { x: MARGIN, y, size: 8, font: font, color: GRAY });
        y -= LINE_H - 2;
      }

      // Answer
      const answer = result.responseLabels?.[i] || `Score: ${result.responses[i]}`;
      page.drawText(`    → ${answer}  (${result.responses[i]})`, { x: MARGIN, y, size: 9, font: fontBold, color: DARK_BLUE });
      y -= LINE_H + 2;
    }
  }

  // ── FOOTER ──
  y -= SECTION_GAP;
  checkPageBreak(50);
  drawLine(MARGIN, PAGE_W - MARGIN);
  y -= 6;
  drawText('SIGNATURES', MARGIN, 10, ACCENT, fontBold);
  y -= 10;
  drawText('Navigator Signature: ___________________________    Date: ____________', MARGIN, 9, BLACK, font);
  y -= 6;
  drawText('Supervisor Signature: ___________________________    Date: ____________', MARGIN, 9, BLACK, font);

  y -= 20;
  page.drawText('Generated by AI Peer Navigator — This document is for clinical use only. Verify all information.', {
    x: MARGIN, y: Math.max(y, 30), size: 7, font: fontItalic, color: GRAY
  });

  return await pdfDoc.save();
}

// Simple word-wrap utility
function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}
