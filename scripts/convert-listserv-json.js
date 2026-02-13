/**
 * convert-listserv-json.js
 *
 * Merges 7 listserv JSON files into a single clean JSONL file
 * for upload to Vertex AI Search (agencylist-ds data store).
 *
 * Strategy:
 *   1. Load specialized files FIRST (FoodCFC, OASAS, PeerSupport, Workforce1, KeyIntake)
 *      — these have cleaner data (no OCR garbling)
 *   2. Load master directory LAST, skipping records that already exist from specialized files
 *   3. Skip ALL garbled entries (OCR interleaving artifacts from master directory)
 *   4. Fix truncated agency names using a corrections map
 *   5. Clean garbled Site/Office values
 *   6. Deduplicate by name+address hash
 *   7. Output clean JSONL matching the buildResourceContext() schema
 *
 * Usage: node scripts/convert-listserv-json.js
 */

import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';

const LISTSERV_DIR = 'C:/Users/mohsi/OneDrive/Documents/AI Navigator/listserv';
const OUTPUT_FILE = 'C:/Users/mohsi/OneDrive/Documents/AI Navigator/listserv/listserv_agencies.jsonl';

// ── FILES IN PRIORITY ORDER (specialized first, master last) ──
const FILES_IN_ORDER = [
  'ListServ_FoodCFC.json',              // 570 clean food pantry records
  'Listserv_OASAS_SUD_NYC.json',        // 300 SUD treatment records
  'ListServ_Peersupport.json',          // 20 peer support orgs (full names)
  'ListServ_Workforce1.json',           // 18 Workforce1 centers
  'ListServ_KeyIntake&Hotlines.json',   // 12 DHS intake/hotlines
  'ListServ_original117.json',          // 116 mixed (subset, more truncated)
  'ListServ_masterdirectory.json',      // 1036 master (has OCR garbling)
];

// ── TRUNCATED NAME CORRECTIONS ──
// Maps truncated Agency/Org values to their full names.
// Built by cross-referencing all 7 files and NYC agency knowledge.
const NAME_FIXES = {
  "Lower East Side Service Cente": "Lower East Side Service Center, Inc.",
  "The New York and Presbyteria": "The New York and Presbyterian Hospital",
  "Advanced Human Services, In": "Advanced Human Services, Inc.",
  "Association to Benefit Child": "Association to Benefit Children (ABC)",
  "Association to Benefit Childre": "Association to Benefit Children (ABC)",
  "Baltic Street Wellness Solut": "Baltic Street Wellness Solutions",
  "Baltic Street Wellness Solutio": "Baltic Street Wellness Solutions",
  "BASICS, Bronx Addiction Servi": "BASICS, Bronx Addiction Services",
  "Bellevue Hospital Center (HH": "Bellevue Hospital Center (HHC)",
  "Bleuler Psychotherapy Center": "Bleuler Psychotherapy Center, Inc.",
  "Bliss-Poston The Second Wind": "Bliss-Poston The Second Wind, Inc.",
  "Bronx Addiction Treatment Ce": "Bronx Addiction Treatment Center",
  "Brooklyn Center for Psychoth": "Brooklyn Center for Psychotherapy, Inc.",
  "Brownsville Comm Develop.C": "Brownsville Community Development Corp., Inc.",
  "Catholic Charities Communi": "Catholic Charities Community Services",
  "Catholic Charities Community": "Catholic Charities Community Services",
  "Catholic Charities Neighbor": "Catholic Charities Neighborhood Services",
  "Catholic Charities Neighborho": "Catholic Charities Neighborhood Services",
  "Center for Community Altern": "Center for Community Alternatives, Inc.",
  "Center for Comprehensive Hlt": "Center for Comprehensive Health Practice",
  "Christopher Rose Communi": "Christopher Rose Community Empowerment Campaign, Inc.",
  "Christopher Rose Community": "Christopher Rose Community Empowerment Campaign, Inc.",
  "Community Counseling & M": "Community Counseling & Mediation",
  "Community Counseling & Me": "Community Counseling & Mediation",
  "Community Counseling/Medi": "Community Counseling/Mediation Service",
  "Concourse Medical Center, In": "Concourse Medical Center, Inc.",
  "Cornerstone of Medical Arts C": "Cornerstone of Medical Arts Center",
  "Counseling Service of E.D.N.Y": "Counseling Service of E.D.N.Y., Inc.",
  "Counseling Services of New Y": "Counseling Services of New York LLC",
  "Creedmoor Addiction Treatm": "Creedmoor Addiction Treatment Center",
  "Dynamic Youth Community In": "Dynamic Youth Community Inc.",
  "Elmcor Youth and Adult Activi": "Elmcor Youth and Adult Activities, Inc.",
  "Elmhurst Hospital Center (HH": "Elmhurst Hospital Center (HHC)",
  "Exodus Transitional Communi": "Exodus Transitional Community, Inc.",
  "Flushing Hospital and Medical": "Flushing Hospital and Medical Center",
  "Genesis Detox of Brooklyn, LL": "Genesis Detox of Brooklyn, LLC",
  "Goodwill Industries of NY a": "Goodwill Industries of NY and NJ, Inc.",
  "Goodwill Industries of NY and": "Goodwill Industries of NY and NJ, Inc.",
  "Greenhope Services for Wom": "Greenhope Services for Women, Inc.",
  "Hamilton-Madison House, Inc": "Hamilton-Madison House, Inc.",
  "Hands On Health Associates,": "Hands On Health Associates, LLC",
  "Housing Works Community H": "Housing Works Community Healthcare",
  "Infinity Educational Special": "Infinity Educational Special Programs Corp.",
  "Infinity Educational Special Pr": "Infinity Educational Special Programs Corp.",
  "Inwood Community Services,": "Inwood Community Services, Inc.",
  "Joan And Sanford I. Weill Med": "Joan And Sanford I. Weill Medical College of Cornell University",
  "Kings County Hospital Center": "Kings County Hospital Center (HHC)",
  "Kingsboro Addiction Treatme": "Kingsboro Addiction Treatment Center",
  "Lafayette Medical Approach,": "Lafayette Medical Approach, LLC",
  "Lesbian/Gay Community Serv": "Lesbian/Gay Community Services Center",
  "Long Island Consultation Cent": "Long Island Consultation Center, Inc.",
  "Long Island Jewish Medical Ce": "Long Island Jewish Medical Center",
  "Mental Health Providers/Wes": "Mental Health Providers/Western Queens",
  "Metropolitan Center for Men": "Metropolitan Center for Mental Health",
  "Metropolitan Hospital Center": "Metropolitan Hospital Center (HHC)",
  "N. Crown Heights Family Outr": "North Crown Heights Family Outreach Center",
  "Neighborhood Coalition for S": "Neighborhood Coalition for Shelter, Inc.",
  "New York Center for Living, In": "New York Center for Living, Inc.",
  "New York City Department of": "New York City Department of Police",
  "New York Foundling - Stron": "New York Foundling - Strong Families and Communities Training Center",
  "New York Foundling - Strong": "New York Foundling - Strong Families and Communities Training Center",
  "New York Therapeutic Comm": "New York Therapeutic Communities, Inc.",
  "NYC Department of Homeless": "NYC Department of Homeless Services",
  "NYC HRA / Mayor's Office of I": "NYC HRA / Mayor's Office of Immigrant Affairs (MOIA)",
  "NYC Mayor's Office to End Do": "NYC Mayor's Office to End Domestic & Gender-Based Violence",
  "Ohel Children's and Family Se": "Ohel Children's and Family Services, Inc.",
  "Outreach Development Corpo": "Outreach Development Corporation",
  "Phoenix Houses of Long Islan": "Phoenix Houses of Long Island, Inc.",
  "Postgraduate Center for Men": "Postgraduate Center for Mental Health",
  "Queens Village Committee fo": "Queens Village Committee for Mental Health / J-CAP",
  "Research Foundation for Men": "Research Foundation for Mental Hygiene",
  "RevCore Recovery Ctr / Manh": "RevCore Recovery Ctr / Manhattan, LLC",
  "Richmond University Medical": "Richmond University Medical Center",
  "RiseBoro Community Partn": "RiseBoro Community Partnership",
  "RiseBoro Community Partner": "RiseBoro Community Partnership",
  "Riverdale Mental Health Asso": "Riverdale Mental Health Association",
  "Samaritan Daytop Village, Inc": "Samaritan Daytop Village, Inc.",
  "Services for the Underserved,": "Services for the Underserved, Inc.",
  "Shiloh Psychological Consultin": "Shiloh Psychological Consulting PLLC",
  "Silver Lake Support Services, I": "Silver Lake Support Services, Inc.",
  "South Beach Addiction Treatm": "South Beach Addiction Treatment Center",
  "South Brooklyn Medical Admi": "South Brooklyn Medical Administrative Services Inc.",
  "South Richmond Hill Recovery": "South Richmond Hill Recovery, LLC",
  "Spring Hill Wellness New York": "Spring Hill Wellness New York, LLC",
  "St. Mark's Place Institute for": "St. Mark's Place Institute for Mental Health, Inc.",
  "START Treatment & Recovery": "START Treatment & Recovery Centers",
  "Staten Island University Hospi": "Staten Island University Hospital",
  "Success Counseling Services, I": "Success Counseling Services, Inc.",
  "SUS - Urgent Housing Progr": "SUS - Urgent Housing Program",
  "The Jewish Board of Family": "The Jewish Board of Family and Children's Services",
  "The Jewish Board of Family an": "The Jewish Board of Family and Children's Services",
  "The New Horizon Counseling": "The New Horizon Counseling Center, Inc.",
  "The PAC Program of the Bron": "The PAC Program of the Bronx, Inc.",
  "The Resource Counseling Cen": "The Resource Counseling Center",
  "Under Angel's Wings Recover": "Under Angel's Wings Recovery Center, LLC",
  "United Bronx Parents, Inc": "United Bronx Parents, Inc.",
  "Upper Manhattan Mental Hea": "Upper Manhattan Mental Health Center",
  "Vibrant Emotional Health (a": "Vibrant Emotional Health",
  "Vocational Instruction Proj Co": "Vocational Instruction Project Community Services, Inc.",
  "West Midtown Management": "West Midtown Management Group, Inc.",
  "Woodhull Medical/Mental He": "Woodhull Medical/Mental Health Center (HHC)",
  "Bridge Back to Life Center, Inc": "Bridge Back to Life Center, Inc.",
  "BronxCare Health System": "BronxCare Health System",
};

// ── HELPER: Detect garbled OCR text ──
// Garbled entries from master directory have interleaved columns from PDF parsing.
// Pattern: lowercase letter followed by uppercase letter(s) in the first 3 chars,
// or contains fragments like "In72c", "t8a5l", "C4e7n57te".
function isGarbled(text) {
  if (!text) return false;
  // Interleaved text patterns from the master directory PDF OCR
  if (/^[a-z][A-Z]/.test(text)) return true;  // e.g., "dA bPuanndtraienst..."
  if (/^[a-z]{2}[A-Z]/.test(text)) return true;  // e.g., "cNaYreCe..."
  // Pattern: starts with "d1 " or similar digit-letter mix (e.g., "d1 6P1aSntt...")
  if (/^[a-z]\d\s/.test(text)) return true;
  // Garbled Site/Office patterns with numbers mixed with letters
  if (/^[a-z]\d/.test(text) && /\d[a-z]/i.test(text) && text.length < 20) return true;
  // Known OCR artifact patterns in Site/Office
  if (/^[a-z][A-Z].*[A-Z].*[a-z]/.test(text) && text.includes(' ') && /[A-Z]{2}/.test(text.substring(0, 5))) return true;
  // Detect alternating case patterns typical of interleaved OCR
  // Count rapid case alternations in first 10 chars
  const head = text.substring(0, 12);
  let alternations = 0;
  for (let i = 1; i < head.length; i++) {
    const prev = head[i-1], cur = head[i];
    if (/[a-z]/.test(prev) && /[A-Z]/.test(cur)) alternations++;
    if (/[A-Z]/.test(prev) && /[a-z]/.test(cur) && i < 3) alternations++;
  }
  if (alternations >= 3) return true;  // e.g., "tUyn Sioernvpicoerts" has many alternations
  return false;
}

// ── HELPER: Clean garbled Site/Office values ──
function cleanSiteOffice(site) {
  if (!site) return '';
  // Remove OASAS-style numeric garbling (e.g., "r2,3 In72c.0/03096")
  if (/^\w\d.*\/\d{3,}/.test(site)) return '';
  if (/\d{4,}\/\d{3,}/.test(site)) return '';
  // Remove patterns like "t8a5l200/00304" or "5, 0In4c9.0/50012"
  if (/^[a-z]\d[a-z]?\d/.test(site)) return '';
  if (/\d.*\/\d{4,}/.test(site)) return '';
  // Remove patterns like "C1e5n4t4e0r,/ 5In3c447" or "r3 M13H4/0J-/C0A1P256"
  if (/\d[a-z]\d[a-z]/i.test(site.substring(0, 8)) && /\//.test(site)) return '';
  // Remove patterns starting with "r3 " or similar lowercase-digit-space
  if (/^[a-z]\d\s/.test(site)) return '';
  // Remove patterns like "(8H7H0C3)0/00920"
  if (/\(\d[A-Z]\d/.test(site)) return '';
  // Remove garbled workforce patterns
  if (/^i[A-Z]/.test(site) || /^iBnreosns/.test(site)) return '';
  // Remove garbled food program patterns
  if (/^e[A-Z]/.test(site) || /^eFnos/.test(site) || /^eSenso/.test(site)) return '';
  // Remove garbled peer support patterns
  if (/^n[A-Z]/.test(site) || /^nA\s/.test(site) || /^nBs/.test(site)) return '';
  // Remove garbled hotline patterns
  if (/^m[A-Z]/.test(site) || /^mNYeC/.test(site)) return '';
  // Detect interleaved OCR in Site/Office — rapid case alternation
  const head = site.substring(0, 12);
  let alternations = 0;
  for (let i = 1; i < head.length; i++) {
    if (/[a-z]/.test(head[i-1]) && /[A-Z]/.test(head[i])) alternations++;
  }
  if (alternations >= 2 && head.length >= 4) return '';  // e.g., "tUyn Sioernvpicoerts", "hEoaosdt"
  // Detect patterns like "lVt)ibrant" or "ceF Inosoc)d" — lowercase start then garbled
  if (/^[a-z]{1,3}[A-Z)][a-z]/.test(site) && !/^[a-z]+[A-Z][a-z]+$/.test(site)) return '';
  // Detect doubled/interleaved full names (e.g., "aTnhde CJehwildisrhe nB'os aSredr voifc...")
  if (/^[a-z][A-Z][a-z]/.test(site) && site.length > 15) return '';
  // Clean otherwise
  return site.trim();
}

// ── HELPER: Normalize borough ──
function normBorough(b) {
  if (!b) return '';
  const u = b.trim().toUpperCase();
  if (u.includes('MANHATTAN') || u === 'NEW YORK') return 'MANHATTAN';
  if (u.includes('BRONX')) return 'BRONX';
  if (u.includes('BROOKLYN') || u === 'KINGS') return 'BROOKLYN';
  if (u.includes('QUEENS')) return 'QUEENS';
  if (u.includes('STATEN')) return 'STATEN ISLAND';
  return u;
}

// ── HELPER: Normalize category ──
function normCategory(c) {
  if (!c) return 'other';
  const lower = c.trim().toLowerCase();
  if (lower.includes('food') || lower.includes('snap') || lower.includes('pantry') || lower.includes('cfc')) return 'food_access';
  if (lower.includes('substance') || lower.includes('opioid') || lower.includes('treatment') || lower.includes('detox') || lower.includes('sud')) return 'substance_use_treatment';
  if (lower.includes('mental health') || lower.includes('psychiatric') || lower.includes('counseling')) return 'mental_health';
  if (lower.includes('housing') || lower.includes('shelter') || lower.includes('homeless')) return 'housing_shelter';
  if (lower.includes('employ') || lower.includes('workforce') || lower.includes('vocational') || lower.includes('job')) return 'employment';
  if (lower.includes('peer') || lower.includes('family support') || lower.includes('recovery')) return 'peer_support';
  if (lower.includes('legal') || lower.includes('immigration') || lower.includes('court')) return 'legal_services';
  if (lower.includes('health') || lower.includes('medical') || lower.includes('clinic')) return 'health_services';
  if (lower.includes('domestic violence') || lower.includes('dv') || lower.includes('gender')) return 'domestic_violence';
  if (lower.includes('hotline') || lower.includes('crisis') || lower.includes('intake')) return 'crisis_hotline';
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ── HELPER: Extract ZIP from address string ──
function extractZip(address) {
  if (!address) return '';
  // Match NYC zip codes (10xxx, 11xxx)
  const match = address.match(/\b(1[01]\d{3})\b/);
  return match ? match[1] : '';
}

// ── HELPER: Normalize phone ──
function normPhone(phone, phones) {
  if (phone && phone.trim() && phone.trim() !== 'Not Available' && phone.trim() !== 'N/A') {
    return phone.trim();
  }
  // Fall back to Phones array
  if (Array.isArray(phones) && phones.length > 0) {
    const p = phones[0];
    if (p && p.trim() && p.trim() !== 'Not Available') return p.trim();
  }
  return '';
}

// ── HELPER: Generate deterministic ID ──
function makeId(name, address) {
  const key = `${name}|${address}`.toLowerCase();
  return createHash('md5').update(key).digest('hex').slice(0, 16);
}

// ── HELPER: Fix agency name ──
function fixName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  // Check corrections map
  if (NAME_FIXES[trimmed]) return NAME_FIXES[trimmed];
  // Auto-fix: if name ends with a comma or incomplete word, it's likely truncated
  // but we don't have a correction for it — keep as-is
  return trimmed;
}

// ── MAIN ──
async function main() {
  const seen = new Map(); // key: name|address hash → record (for dedup)
  const stats = {
    totalInput: 0,
    skippedGarbled: 0,
    skippedDuplicate: 0,
    nameFixed: 0,
    sitesCleaned: 0,
    zipExtracted: 0,
    categories: {},
    boroughs: {},
    byFile: {},
  };

  for (const filename of FILES_IN_ORDER) {
    const filePath = join(LISTSERV_DIR, filename);
    let fileData;
    try {
      const raw = await readFile(filePath, 'utf-8');
      fileData = JSON.parse(raw);
    } catch (err) {
      console.warn(`[WARN] Could not read ${filename}:`, err.message);
      continue;
    }

    const records = fileData.records || [];
    let fileAdded = 0;
    let fileSkipped = 0;

    for (const rec of records) {
      stats.totalInput++;
      const rawName = (rec['Agency/Org'] || '').trim();
      const rawSite = (rec['Site/Office'] || '').trim();
      const rawAddress = (rec['Address'] || '').trim();

      // Skip garbled entries (OCR artifacts from master directory)
      if (isGarbled(rawName)) {
        stats.skippedGarbled++;
        fileSkipped++;
        continue;
      }

      // Fix truncated name
      const name = fixName(rawName);
      if (name !== rawName && NAME_FIXES[rawName]) stats.nameFixed++;

      // Clean site/office
      let site = cleanSiteOffice(rawSite);
      if (site !== rawSite) stats.sitesCleaned++;

      // If site is same as name, clear it (redundant)
      if (site === name) site = '';

      const address = rawAddress;
      const borough = normBorough(rec['Borough'] || '');
      let zipcode = (rec['ZIP'] || '').trim();

      // Extract ZIP from address if missing
      if (!zipcode && address) {
        zipcode = extractZip(address);
        if (zipcode) stats.zipExtracted++;
      }

      const phone = normPhone(rec['Phone'], rec['Phones']);
      const hours = (rec['Hours'] || '').trim();
      const notes = (rec['Notes'] || '').trim();
      const category = normCategory(rec['Category'] || '');
      const program = (rec['Program'] || '').trim();

      // Skip records with no identifiable name and no address
      if (!name && !address) {
        fileSkipped++;
        continue;
      }

      // Dedup key: lowercase name + address
      const dedupKey = `${(name || '').toLowerCase()}|${(address || '').toLowerCase()}`;

      if (seen.has(dedupKey)) {
        // Keep the record with more data (prefer specialized files loaded first)
        stats.skippedDuplicate++;
        fileSkipped++;
        continue;
      }

      const doc = {
        _id: makeId(name, address),
        category,
        program,
        name,
        site,
        address,
        borough,
        zipcode,
        phone,
        hours,
        notes,
      };

      seen.set(dedupKey, doc);
      fileAdded++;

      // Stats
      stats.categories[category] = (stats.categories[category] || 0) + 1;
      if (borough) stats.boroughs[borough] = (stats.boroughs[borough] || 0) + 1;
    }

    stats.byFile[filename] = { total: records.length, added: fileAdded, skipped: fileSkipped };
    console.log(`[${filename}] ${records.length} records → ${fileAdded} added, ${fileSkipped} skipped`);
  }

  // Write output
  const lines = [];
  for (const doc of seen.values()) {
    lines.push(JSON.stringify(doc));
  }
  await writeFile(OUTPUT_FILE, lines.join('\n'), 'utf-8');

  // Print stats
  console.log('\n' + '='.repeat(60));
  console.log('CONVERSION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Input records:      ${stats.totalInput}`);
  console.log(`Garbled (skipped):  ${stats.skippedGarbled}`);
  console.log(`Duplicates:         ${stats.skippedDuplicate}`);
  console.log(`Names fixed:        ${stats.nameFixed}`);
  console.log(`Sites cleaned:      ${stats.sitesCleaned}`);
  console.log(`ZIPs extracted:     ${stats.zipExtracted}`);
  console.log(`OUTPUT RECORDS:     ${lines.length}`);
  console.log(`Output file:        ${OUTPUT_FILE}`);

  console.log('\nBy category:');
  Object.entries(stats.categories).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`  ${k}: ${v}`)
  );

  console.log('\nBy borough:');
  Object.entries(stats.boroughs).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`  ${k}: ${v}`)
  );

  console.log('\nBy file:');
  Object.entries(stats.byFile).forEach(([k, v]) =>
    console.log(`  ${k}: ${v.total} → ${v.added} added, ${v.skipped} skipped`)
  );

  // Verification: check LESSC
  console.log('\n--- LESSC Verification ---');
  for (const doc of seen.values()) {
    if (doc.name.toLowerCase().includes('lower east side service')) {
      console.log(`  ✓ ${doc.name} | ${doc.address} | ${doc.phone} | ${doc.program}`);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
