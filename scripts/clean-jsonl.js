#!/usr/bin/env node
/**
 * clean-jsonl.js
 *
 * Cleans, deduplicates, recategorizes, and enriches the RAG agency data
 * for the AI Peer Navigator Vertex AI Search structured data store.
 *
 * Input:  DOCS/out/rag_docs.jsonl  (50,958 records)
 * Output: DOCS/out/rag_docs_cleaned.jsonl (BH-relevant, deduplicated, enriched)
 *
 * Operations:
 * 1. Remove duplicate source files (NYS_OMH, NYC_Homebase, NYC_Homeless duplicates)
 * 2. Filter facilities.csv to only BH-relevant FACSUBGRP values
 * 3. Recategorize "unknown" facilities.csv records using FACSUBGRP
 * 4. Fix zip codes (strip .0 suffix)
 * 5. Enrich phone numbers from full_record
 * 6. Enrich addresses from full_record
 * 7. Standardize field names (strip leading spaces in mental health data)
 * 8. Remove records with no usable data (no name, no address, no phone)
 */

import { createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';

// ── CONFIGURATION ──

const INPUT_FILE = process.argv[2] || '../DOCS/out/rag_docs.jsonl';
const OUTPUT_FILE = process.argv[3] || '../DOCS/out/rag_docs_cleaned.jsonl';

// Duplicate source files to SKIP (keep only one copy)
const DUPLICATE_SOURCES = new Set([
  'NYS_OMH_Local_Mental_Health_Programs.csv',  // Duplicate of Local_Mental_Health_Programs.csv
  'NYC_Homebase_Locations.csv',                  // Duplicate of Directory_Of_Homebase_Locations.csv
  'NYC_Homeless_DropIn_Centers.csv',             // Duplicate of Directory_Of_Homeless_Drop_In_Centers.csv
]);

// Non-location sources to SKIP
const NON_LOCATION_SOURCES = new Set([
  'NYC_Benefits_Platform__Benefits_and_Programs_Dataset.csv',  // Tax credits, web programs — no physical locations
]);

// BH-relevant FACSUBGRP values from facilities.csv
// Everything else (schools, garages, parks, etc.) gets filtered OUT
const BH_RELEVANT_FACSUBGRPS = {
  'MENTAL HEALTH':                                  'mental_health',
  'SUBSTANCE USE DISORDER TREATMENT PROGRAMS':       'substance_use_treatment',
  'SOUP KITCHENS AND FOOD PANTRIES':                 'food_access',
  'NON-RESIDENTIAL HOUSING AND HOMELESS SERVICES':   'housing_services',
  'HOSPITALS AND CLINICS':                           'health_services',
  'SENIOR SERVICES':                                 'senior_services',
  'LEGAL AND INTERVENTION SERVICES':                 'legal_services',
  'OTHER HEALTH CARE':                               'health_services',
  'PROGRAMS FOR PEOPLE WITH DISABILITIES':           'disability_services',
  'COMMUNITY CENTERS AND COMMUNITY PROGRAMS':        'community_services',
  'RESIDENTIAL HEALTH CARE':                         'residential_health',
  'WORKFORCE DEVELOPMENT':                           'workforce_development',
  'FINANCIAL ASSISTANCE AND SOCIAL SERVICES':        'financial_assistance',
  'IMMIGRANT SERVICES':                              'immigrant_services',
  'HEALTH PROMOTION AND DISEASE PREVENTION':         'health_promotion',
  'FOSTER CARE SERVICES AND RESIDENTIAL CARE':       'foster_care',
  'CHILD NUTRITION':                                 'food_access',
  'HEAD START':                                      'early_childhood',
  'DETENTION AND CORRECTIONAL':                      'criminal_justice',
};

// ── STATS TRACKING ──
const stats = {
  totalRead: 0,
  duplicateSourceSkipped: 0,
  nonLocationSkipped: 0,
  nonBhFacilitySkipped: 0,
  noUsableDataSkipped: 0,
  zipFixed: 0,
  phoneEnriched: 0,
  addressEnriched: 0,
  categoryRecategorized: 0,
  totalWritten: 0,
  byCategory: {},
  bySource: {},
};

// ── HELPER: Strip leading/trailing spaces from field names in full_record ──
function cleanFullRecordKeys(fr) {
  if (!fr || typeof fr !== 'object') return fr;
  const cleaned = {};
  for (const [key, value] of Object.entries(fr)) {
    cleaned[key.trim()] = value;
  }
  return cleaned;
}

// ── HELPER: Fix zip code ──
function fixZipcode(zip) {
  if (!zip) return '';
  let z = String(zip).trim();
  // Remove .0 suffix from float-encoded zips
  z = z.replace(/\.0$/, '');
  // Validate: should be 5 digits
  if (/^\d{5}$/.test(z)) return z;
  // Try to extract 5-digit zip
  const match = z.match(/(\d{5})/);
  return match ? match[1] : z;
}

// ── HELPER: Extract best phone number ──
function extractPhone(record, fr) {
  // Priority order for phone extraction
  const candidates = [
    record.phone,
    fr['Phone Number'],
    fr['Program_Phone'] || fr['Program Phone'],
    fr['Agency_Phone'] || fr['Agency Phone'],
    fr['phone_number'],
  ].filter(p => p && p.trim() !== '' && p.trim().toLowerCase() !== 'not available');

  return candidates.length > 0 ? candidates[0].trim() : '';
}

// ── HELPER: Extract best address ──
function extractAddress(record, fr) {
  // Priority order for address extraction
  const candidates = [
    // Full address from full_record
    fr['ADDRESS'],
    fr['Address'],
    // Combine address parts
    [fr['Program Address 1'], fr['Program Address 2']].filter(Boolean).join(', '),
    [fr['Street Address'], fr['Street Address 1']].filter(Boolean).join(', '),
    // Top-level address (often incomplete for facilities.csv)
    record.address,
  ].filter(a => a && a.trim() !== '' && a.trim().length > 3);

  return candidates.length > 0 ? candidates[0].trim() : '';
}

// ── HELPER: Extract best city ──
function extractCity(record, fr) {
  const candidates = [
    record.city,
    fr['CITY'],
    fr['City'],
    fr['Program City'],
  ].filter(c => c && c.trim() !== '');

  return candidates.length > 0 ? candidates[0].trim() : '';
}

// ── HELPER: Extract best zipcode ──
function extractZipcode(record, fr) {
  const candidates = [
    record.zipcode,
    fr['ZIPCODE'],
    fr['Zip Code'],
    fr['Postcode'],
    fr['Program Zip'],
  ].filter(z => z && String(z).trim() !== '');

  if (candidates.length === 0) return '';
  return fixZipcode(candidates[0]);
}

// ── HELPER: Extract borough ──
function extractBorough(record, fr) {
  const candidates = [
    record.borough,
    fr['BORO'],
    fr['Borough'],
  ].filter(b => b && b.trim() !== '');

  if (candidates.length === 0) return '';
  return candidates[0].trim().toUpperCase();
}

// ── MAIN PROCESSING ──
async function processFile() {
  console.log(`\n=== RAG Data Cleaning Pipeline ===`);
  console.log(`Input:  ${INPUT_FILE}`);
  console.log(`Output: ${OUTPUT_FILE}\n`);

  const rl = createInterface({
    input: createReadStream(INPUT_FILE, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const output = createWriteStream(OUTPUT_FILE, { encoding: 'utf-8' });
  const seenIds = new Set(); // For deduplication within remaining sources

  for await (const line of rl) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch (e) {
      console.warn(`Skipping malformed JSON line: ${e.message}`);
      continue;
    }

    stats.totalRead++;

    // ── Step 1: Skip duplicate source files ──
    if (DUPLICATE_SOURCES.has(record.source_file)) {
      stats.duplicateSourceSkipped++;
      continue;
    }

    // ── Step 2: Skip non-location sources ──
    if (NON_LOCATION_SOURCES.has(record.source_file)) {
      stats.nonLocationSkipped++;
      continue;
    }

    // ── Step 3: Clean full_record keys (strip leading spaces) ──
    const fr = cleanFullRecordKeys(record.full_record || {});

    // ── Step 4: Filter facilities.csv to BH-relevant only ──
    if (record.source_file === 'facilities.csv') {
      const facSubgrp = fr['FACSUBGRP'] || '';
      if (!BH_RELEVANT_FACSUBGRPS[facSubgrp]) {
        stats.nonBhFacilitySkipped++;
        continue;
      }

      // Recategorize from "unknown" to proper category
      if (record.category === 'unknown') {
        record.category = BH_RELEVANT_FACSUBGRPS[facSubgrp];
        stats.categoryRecategorized++;
      }
    }

    // ── Step 5: Fix zip codes ──
    const originalZip = record.zipcode;
    const bestZip = extractZipcode(record, fr);
    if (bestZip !== originalZip) {
      stats.zipFixed++;
    }
    record.zipcode = bestZip;

    // ── Step 6: Enrich phone numbers ──
    const originalPhone = record.phone;
    const bestPhone = extractPhone(record, fr);
    if (!originalPhone && bestPhone) {
      stats.phoneEnriched++;
    }
    record.phone = bestPhone;

    // ── Step 7: Enrich addresses ──
    const originalAddr = record.address;
    const bestAddr = extractAddress(record, fr);
    if ((!originalAddr || originalAddr.length < 5) && bestAddr && bestAddr.length >= 5) {
      stats.addressEnriched++;
    }
    record.address = bestAddr;

    // ── Step 8: Enrich city and borough ──
    record.city = extractCity(record, fr);
    record.borough = extractBorough(record, fr);

    // ── Step 9: Store cleaned full_record back ──
    record.full_record = fr;

    // ── Step 10: Skip records with no usable data ──
    const hasName = record.name && record.name.trim().length > 0;
    const hasAddress = record.address && record.address.trim().length > 3;
    const hasPhone = record.phone && record.phone.trim().length > 0;

    if (!hasName) {
      stats.noUsableDataSkipped++;
      continue;
    }

    // ── Step 11: Deduplicate by ID ──
    if (seenIds.has(record.id)) {
      stats.duplicateSourceSkipped++;
      continue;
    }
    seenIds.add(record.id);

    // ── Write cleaned record ──
    output.write(JSON.stringify(record) + '\n');
    stats.totalWritten++;

    // Track stats
    stats.byCategory[record.category] = (stats.byCategory[record.category] || 0) + 1;
    stats.bySource[record.source_file] = (stats.bySource[record.source_file] || 0) + 1;
  }

  output.end();

  // ── Print Report ──
  console.log(`\n=== CLEANING REPORT ===\n`);
  console.log(`Records read:                   ${stats.totalRead.toLocaleString()}`);
  console.log(`Duplicate sources removed:      ${stats.duplicateSourceSkipped.toLocaleString()}`);
  console.log(`Non-location sources removed:   ${stats.nonLocationSkipped.toLocaleString()}`);
  console.log(`Non-BH facilities removed:      ${stats.nonBhFacilitySkipped.toLocaleString()}`);
  console.log(`No usable data removed:         ${stats.noUsableDataSkipped.toLocaleString()}`);
  console.log(`──────────────────────────────`);
  console.log(`Records written:                ${stats.totalWritten.toLocaleString()}`);
  console.log(`──────────────────────────────`);
  console.log(`Zip codes fixed:                ${stats.zipFixed.toLocaleString()}`);
  console.log(`Phone numbers enriched:         ${stats.phoneEnriched.toLocaleString()}`);
  console.log(`Addresses enriched:             ${stats.addressEnriched.toLocaleString()}`);
  console.log(`Categories recategorized:       ${stats.categoryRecategorized.toLocaleString()}`);

  console.log(`\n--- Records by Category ---`);
  for (const [cat, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(30)} ${count.toLocaleString()}`);
  }

  console.log(`\n--- Records by Source ---`);
  for (const [src, count] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(70)} ${count.toLocaleString()}`);
  }

  console.log(`\n=== Done! Output: ${OUTPUT_FILE} ===\n`);
}

processFile().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
