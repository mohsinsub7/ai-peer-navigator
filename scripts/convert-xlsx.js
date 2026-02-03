import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import XLSX from 'xlsx';

const INPUT = 'C:/Users/mohsi/OneDrive/Documents/AI Navigator/listserv/agencylist.xlsx';
const OUTPUT = 'C:/Users/mohsi/OneDrive/Documents/AI Navigator/listserv/agencylist.jsonl';

const buf = await readFile(INPUT);
const wb = XLSX.read(buf, { type: 'buffer' });

console.log('Sheets:', wb.SheetNames);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

console.log('Total rows:', rows.length);
console.log('Sample row keys:', Object.keys(rows[0]));
console.log('Sample row:', JSON.stringify(rows[0], null, 2));

// Normalize borough names
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

// Normalize category names (lowercase, trim)
function normCategory(c) {
  if (!c) return 'other';
  return c.trim().toLowerCase().replace(/\s+/g, '_');
}

// Normalize zip (first 5 digits)
function normZip(z) {
  if (!z) return '';
  const s = String(z).trim();
  const m = s.match(/(\d{5})/);
  return m ? m[1] : s;
}

// Generate deterministic ID
function makeId(row) {
  const key = `${row['Agency/Org'] || ''}|${row['Site/Office'] || ''}|${row['Address'] || ''}`;
  return createHash('md5').update(key).digest('hex').slice(0, 16);
}

const lines = [];
const stats = { total: 0, withPhone: 0, categories: {}, boroughs: {} };

for (const row of rows) {
  const category = normCategory(row['Category'] || row['category'] || '');
  const program = (row['Program'] || row['program'] || '').trim();
  const name = (row['Agency/Org'] || row['agency/org'] || row['Agency'] || '').trim();
  const site = (row['Site/Office'] || row['site/office'] || row['Site'] || '').trim();
  const address = (row['Address'] || row['address'] || '').trim();
  const borough = normBorough(row['Borough'] || row['borough'] || '');
  const zipcode = normZip(row['ZIP'] || row['Zip'] || row['zip'] || row['Zipcode'] || '');
  const phone = (row['Phone'] || row['phone'] || '').toString().trim();
  const hours = (row['Hours'] || row['hours'] || '').trim();
  const notes = (row['Notes'] || row['notes'] || '').trim();

  if (!name && !site && !program) continue; // skip empty rows

  const doc = {
    _id: makeId(row),
    category,
    program,
    name,
    site,
    address,
    borough,
    zipcode,
    phone,
    hours,
    notes
  };

  lines.push(JSON.stringify(doc));
  stats.total++;
  if (phone) stats.withPhone++;
  stats.categories[category] = (stats.categories[category] || 0) + 1;
  stats.boroughs[borough] = (stats.boroughs[borough] || 0) + 1;
}

await writeFile(OUTPUT, lines.join('\n'), 'utf-8');

console.log('\n=== Conversion Stats ===');
console.log('Total records:', stats.total);
console.log('With phone:', stats.withPhone, `(${Math.round(stats.withPhone / stats.total * 100)}%)`);
console.log('\nCategories:');
Object.entries(stats.categories).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log('\nBoroughs:');
Object.entries(stats.boroughs).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log('\nOutput:', OUTPUT);
