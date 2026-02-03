#!/usr/bin/env node

// verify-setup.js - Run this to check if everything is configured correctly
// Usage: node verify-setup.js

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 Verifying Google Generative AI SDK Setup...\n');

let hasErrors = false;

// Check 1: package.json
try {
  const pkgPath = join(__dirname, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  
  if (pkg.dependencies['@google/generative-ai']) {
    console.log('✅ package.json: Correct package installed');
    console.log(`   Version: ${pkg.dependencies['@google/generative-ai']}`);
  } else if (pkg.dependencies['@google/genai']) {
    console.log('❌ package.json: WRONG PACKAGE!');
    console.log('   Found: @google/genai');
    console.log('   Need:  @google/generative-ai');
    hasErrors = true;
  } else {
    console.log('❌ package.json: Google Generative AI SDK not found');
    hasErrors = true;
  }
} catch (e) {
  console.log('❌ Cannot read package.json:', e.message);
  hasErrors = true;
}

console.log('');

// Check 2: analytics-run-background.js
try {
  const funcPath = join(__dirname, 'netlify', 'functions', 'analytics-run-background.js');
  const funcCode = readFileSync(funcPath, 'utf-8');
  
  const hasCorrectImport = funcCode.includes('from "@google/generative-ai"');
  const hasWrongImport = funcCode.includes('from "@google/genai');
  const hasServerImport = funcCode.includes('from "@google/generative-ai/server"');
  
  if (hasCorrectImport && hasServerImport && !hasWrongImport) {
    console.log('✅ analytics-run-background.js: Correct imports');
  } else {
    console.log('❌ analytics-run-background.js: Import issues detected');
    if (hasWrongImport) {
      console.log('   Found wrong import: @google/genai');
    }
    if (!hasCorrectImport) {
      console.log('   Missing: import from "@google/generative-ai"');
    }
    if (!hasServerImport) {
      console.log('   Missing: import from "@google/generative-ai/server"');
    }
    hasErrors = true;
  }
} catch (e) {
  console.log('⚠️  Cannot read analytics-run-background.js:', e.message);
}

console.log('');

// Check 3: Environment variables
const hasApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (hasApiKey) {
  console.log('✅ Environment: API key found');
  console.log('   (Make sure this is also set in Netlify)');
} else {
  console.log('⚠️  Environment: No API key found locally');
  console.log('   Make sure GEMINI_API_KEY is set in Netlify environment variables');
}

console.log('');

// Check 4: Try importing the package
try {
  console.log('🔄 Testing package import...');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const { GoogleAIFileManager } = await import('@google/generative-ai/server');
  
  console.log('✅ Package import: Success!');
  console.log('   GoogleGenerativeAI:', typeof GoogleGenerativeAI);
  console.log('   GoogleAIFileManager:', typeof GoogleAIFileManager);
} catch (e) {
  console.log('❌ Package import failed:', e.message);
  console.log('   Run: rm -rf node_modules package-lock.json && npm install');
  hasErrors = true;
}

console.log('');
console.log('═'.repeat(60));

if (hasErrors) {
  console.log('❌ Setup has issues. Please review errors above.');
  console.log('   Follow the DEPLOYMENT_GUIDE.md for fixes.');
  process.exit(1);
} else {
  console.log('✅ All checks passed! Ready to deploy.');
  console.log('   Next steps:');
  console.log('   1. Commit changes: git add . && git commit -m "Fix SDK"');
  console.log('   2. Deploy: git push (or netlify deploy --prod)');
  console.log('   3. Set GEMINI_API_KEY in Netlify if not already set');
  process.exit(0);
}
