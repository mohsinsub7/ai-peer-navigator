import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const rl = createInterface({
  input: createReadStream('C:/Users/mohsi/OneDrive/Documents/AI Navigator/DOCS/out/rag_docs_cleaned.jsonl', { encoding: 'utf-8' }),
  crlfDelay: Infinity
});

let checked = 0;
rl.on('line', (line) => {
  if (!line.trim() || checked >= 3) return;
  const j = JSON.parse(line);
  if (j.source_file === 'facilities.csv' && j.category === 'mental_health') {
    const keys = Object.keys(j.full_record);
    const phoneKeys = keys.filter(k => k.toLowerCase().includes('phone'));
    const agencyKeys = keys.filter(k => k.toLowerCase().includes('agency'));
    console.log('Record:', j.name);
    console.log('  Phone keys:', phoneKeys);
    console.log('  Agency keys:', agencyKeys);
    console.log('  ALL keys:', keys.join(', '));
    console.log('');
    checked++;
  }
});

rl.on('close', () => {
  console.log('Done, checked', checked, 'records');
});
