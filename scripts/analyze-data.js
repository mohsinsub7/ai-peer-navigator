import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const rl = createInterface({
  input: createReadStream('C:/Users/mohsi/OneDrive/Documents/AI Navigator/DOCS/out/rag_docs_cleaned.jsonl', { encoding: 'utf-8' }),
  crlfDelay: Infinity
});

let cats = {}, phones = 0, noPhone = 0, total = 0;
let samplePhones = [];
let sampleNoPhones = [];

rl.on('line', (line) => {
  if (!line.trim()) return;
  const j = JSON.parse(line);
  total++;
  cats[j.category] = (cats[j.category] || 0) + 1;
  if (j.phone && j.phone.trim()) {
    phones++;
    if (samplePhones.length < 5) samplePhones.push({ name: j.name, phone: j.phone, cat: j.category, zip: j.zipcode });
  } else {
    noPhone++;
    if (sampleNoPhones.length < 5) sampleNoPhones.push({ name: j.name, cat: j.category, zip: j.zipcode, source: j.source_file });
  }
});

rl.on('close', () => {
  console.log('Total:', total);
  console.log('With phone:', phones, '(' + Math.round(phones / total * 100) + '%)');
  console.log('Without phone:', noPhone, '(' + Math.round(noPhone / total * 100) + '%)');
  console.log('\nCategories:');
  Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
  console.log('\nSample records WITH phone:');
  samplePhones.forEach(s => console.log('  ' + s.name + ' | phone=' + s.phone + ' | cat=' + s.cat + ' | zip=' + s.zip));
  console.log('\nSample records WITHOUT phone:');
  sampleNoPhones.forEach(s => console.log('  ' + s.name + ' | cat=' + s.cat + ' | zip=' + s.zip + ' | src=' + s.source));
});
