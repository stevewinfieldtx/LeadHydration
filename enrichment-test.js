#!/usr/bin/env node
/**
 * ENRICHMENT TRIPLE-TEST
 * ──────────────────────────────────────────────────────────────
 * Tests 3 enrichment approaches against 100 COSIB companies:
 * 
 *   1. APOLLO  — API people search (find decision-maker contacts)
 *   2. XING    — Web search via OpenRouter LLM for German contacts
 *   3. COMPETE — Firecrawl website scrape for ERP/tech stack detection
 * 
 * ENV VARS REQUIRED:
 *   APOLLO_API_KEY       — Apollo.io API key
 *   OPENROUTER_API_KEY   — For Xing web search via LLM
 *   OPENROUTER_MODEL_ID  — e.g. anthropic/claude-sonnet-4
 *   FIRECRAWL_API_KEY    — Firecrawl.dev API key
 * 
 * INPUT:  cosib_leads_resolved.tsv (tab-separated, expects columns:
 *         Company Name, Final URL, Status, ...)
 * OUTPUT: enrichment_test_results.json  (full structured results)
 *         enrichment_test_report.html   (visual scorecard)
 * 
 * USAGE:
 *   node enrichment-test.js [--limit 100] [--input cosib_leads_resolved.tsv]
 * ──────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';

const LIMIT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--limit') || '100');
const INPUT_FILE = process.argv.find((a, i) => process.argv[i - 1] === '--input') || 'cosib_leads_resolved.tsv';

// Rate limiting
const DELAY_MS = 1500;           // Between API calls
const APOLLO_DELAY_MS = 1000;    // Apollo rate limit
const FIRECRAWL_DELAY_MS = 2000; // Firecrawl rate limit
const LLM_DELAY_MS = 2000;       // OpenRouter rate limit

// Competing ERP keywords to detect
const COMPETE_KEYWORDS = {
  'SAP': ['sap.com', 'SAP Business One', 'SAP B1', 'SAP HANA', 'S/4HANA', 'SAP ERP', 'SAP R/3'],
  'Microsoft Dynamics': ['dynamics.com', 'Dynamics 365', 'Dynamics NAV', 'Navision', 'Dynamics AX', 'Axapta', 'Business Central'],
  'Oracle/NetSuite': ['netsuite.com', 'oracle.com', 'NetSuite', 'Oracle ERP', 'JD Edwards'],
  'Sage': ['sage.com', 'Sage 100', 'Sage X3', 'Sage 50', 'Sage Intacct'],
  'Infor': ['infor.com', 'Infor CloudSuite', 'Infor LN', 'Infor M3', 'Baan'],
  'proALPHA': ['proalpha.com', 'proALPHA'],
  'abas': ['abas.de', 'abas ERP'],
  'DATEV': ['datev.de', 'DATEV'],
  'Lexware': ['lexware.de', 'Lexware'],
  'Exact': ['exact.com', 'Exact Online'],
  'Comarch': ['comarch.com', 'Comarch ERP'],
  'APplus': ['applus-erp.de', 'APplus'],
  'myfactory': ['myfactory.com', 'myfactory'],
  'SelectLine': ['selectline.de', 'SelectLine'],
  'Haufe X360': ['haufe-x360.de', 'Haufe X360', 'lexbizz'],
};

// German decision-maker titles to search for
const DECISION_TITLES_DE = [
  'Geschäftsführer',
  'Inhaber',
  'IT-Leiter',
  'Leiter IT',
  'Head of IT',
  'CTO',
  'CFO',
  'COO',
  'Betriebsleiter',
  'Produktionsleiter',
  'Technischer Leiter',
  'Kaufmännischer Leiter',
  'Prokurist',
];

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(prefix, msg) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${prefix}] ${msg}`);
}

function loadCompanies(filePath, limit) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.trim().split('\n');
  const header = lines[0].split('\t');
  
  // Find column indices
  const nameIdx = header.findIndex(h => /company\s*name/i.test(h)) || 0;
  const urlIdx = header.findIndex(h => /final\s*url|website|url/i.test(h));
  const statusIdx = header.findIndex(h => /status/i.test(h));
  const locationIdx = header.findIndex(h => /location|city/i.test(h));
  
  const companies = [];
  for (let i = 1; i < lines.length && companies.length < limit; i++) {
    const cols = lines[i].split('\t');
    const status = statusIdx >= 0 ? cols[statusIdx]?.trim() : '';
    
    // Only take RESOLVED or FINAL_VERIFIED
    if (status && !['RESOLVED', 'FINAL_VERIFIED'].includes(status)) continue;
    
    const name = cols[nameIdx]?.trim();
    const url = (urlIdx >= 0 ? cols[urlIdx]?.trim() : cols[1]?.trim()) || '';
    const location = locationIdx >= 0 ? cols[locationIdx]?.trim() : '';
    
    if (name && url && url.includes('.')) {
      companies.push({ name, url, location, status });
    }
  }
  
  log('LOAD', `Loaded ${companies.length} companies from ${filePath} (limit: ${limit})`);
  return companies;
}

// ═══════════════════════════════════════════════════════════════
// TEST 1: APOLLO CONTACT SEARCH
// ═══════════════════════════════════════════════════════════════

async function testApollo(company) {
  if (!APOLLO_API_KEY) {
    return { source: 'apollo', status: 'SKIPPED', reason: 'No APOLLO_API_KEY', contacts: [] };
  }
  
  try {
    // Apollo People Search by company domain
    const domain = company.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    
    const resp = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': APOLLO_API_KEY,
      },
      body: JSON.stringify({
        q_organization_domains: domain,
        page: 1,
        per_page: 10,
        // No title filter — we want to see raw coverage: does Apollo know ANYONE here?
      }),
    });
    
    if (resp.status === 429) {
      return { source: 'apollo', status: 'RATE_LIMITED', contacts: [] };
    }
    
    if (!resp.ok) {
      const errText = await resp.text();
      return { source: 'apollo', status: 'ERROR', reason: `HTTP ${resp.status}: ${errText.substring(0, 200)}`, contacts: [] };
    }
    
    const data = await resp.json();
    const people = data.people || [];
    
    const contacts = people.map(p => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      title: p.title || '',
      email: p.email || '',
      phone: p.phone_numbers?.[0]?.sanitized_number || '',
      linkedin: p.linkedin_url || '',
      confidence: p.email_status || 'unknown',
    }));
    
    return {
      source: 'apollo',
      status: contacts.length > 0 ? 'FOUND' : 'EMPTY',
      totalResults: data.pagination?.total_entries || 0,
      contacts,
    };
  } catch (err) {
    return { source: 'apollo', status: 'ERROR', reason: err.message, contacts: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: XING COMPANY PRESENCE CHECK
// ═══════════════════════════════════════════════════════════════
// Simple test: does this company exist on Xing? How many people?
// No title filtering — just company-level coverage check.

async function testXingSearch(company) {
  if (!OPENROUTER_API_KEY) {
    return { source: 'xing', status: 'SKIPPED', reason: 'No OPENROUTER_API_KEY', contacts: [] };
  }
  
  try {
    const searchPrompt = `Search the web for: site:xing.com "${company.name}"

I need to know:
1. Does this company have a presence on Xing (xing.com)?
2. How many employee/people profiles are listed there for this company?
3. What is the Xing company page URL if one exists?

Return ONLY a JSON object (no markdown, no explanation, no backticks):
{
  "found": true or false,
  "company_page_url": "https://www.xing.com/companies/..." or null,
  "employee_count": number or null,
  "sample_titles": ["title1", "title2"],
  "notes": "brief note on what you found"
}`;

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://leadhydration.com',
        'X-Title': 'LeadHydration Xing Test',
      },
      body: JSON.stringify({
        // Use :online suffix for web search — works on most OpenRouter models
        // Also include plugins as fallback for models that use that approach
        model: OPENROUTER_MODEL_ID.includes(':online') ? OPENROUTER_MODEL_ID : OPENROUTER_MODEL_ID + ':online',
        max_tokens: 800,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant. Search the web and report what you find. Return ONLY valid JSON, no markdown fences, no explanation text before or after the JSON.'
          },
          { role: 'user', content: searchPrompt }
        ],
        plugins: [{ id: 'web' }],
      }),
    });
    
    if (!resp.ok) {
      const errText = await resp.text();
      return { source: 'xing', status: 'ERROR', reason: `HTTP ${resp.status}: ${errText.substring(0, 200)}`, contacts: [], employeeCount: 0 };
    }
    
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    let parsed;
    try {
      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { source: 'xing', status: 'PARSE_ERROR', reason: content.substring(0, 300), contacts: [], employeeCount: 0 };
    }
    
    return {
      source: 'xing',
      status: parsed.found ? 'FOUND' : 'EMPTY',
      companyPageUrl: parsed.company_page_url || null,
      employeeCount: parsed.employee_count || 0,
      sampleTitles: parsed.sample_titles || [],
      contacts: [],  // Not searching for specific contacts in this test
      searchNotes: parsed.notes || '',
      rawModel: data.model || '',
    };
  } catch (err) {
    return { source: 'xing', status: 'ERROR', reason: err.message, contacts: [], employeeCount: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: FIRECRAWL COMPETE SEARCH (ERP/tech stack detection)
// ═══════════════════════════════════════════════════════════════

async function testCompeteSearch(company) {
  if (!FIRECRAWL_API_KEY) {
    // FALLBACK: Use basic fetch + keyword scan if no Firecrawl
    return testCompeteSearchBasic(company);
  }
  
  try {
    const domain = company.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const targetUrl = `https://${domain}`;
    
    // Firecrawl scrape
    const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url: targetUrl,
        formats: ['markdown'],
        onlyMainContent: false,  // Get full page including footer/scripts
        waitFor: 3000,
      }),
    });
    
    if (!resp.ok) {
      const errText = await resp.text();
      // If Firecrawl fails, fall back to basic fetch
      if (resp.status === 402 || resp.status === 429) {
        log('COMPETE', `Firecrawl limit hit for ${company.name}, falling back to basic`);
        return testCompeteSearchBasic(company);
      }
      return { source: 'firecrawl', status: 'ERROR', reason: `HTTP ${resp.status}`, erps: [], signals: [] };
    }
    
    const data = await resp.json();
    const content = data.data?.markdown || '';
    const html = data.data?.html || '';
    
    return analyzeForERP(company, content + ' ' + html, 'firecrawl');
  } catch (err) {
    return { source: 'firecrawl', status: 'ERROR', reason: err.message, erps: [], signals: [] };
  }
}

// Basic fallback: fetch homepage + common subpages
async function testCompeteSearchBasic(company) {
  try {
    const domain = company.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const urls = [
      `https://${domain}`,
      `https://${domain}/impressum`,
      `https://${domain}/ueber-uns`,
      `https://${domain}/about`,
      `https://${domain}/karriere`,
      `https://${domain}/jobs`,
    ];
    
    let allContent = '';
    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydration/1.0)' },
          signal: AbortSignal.timeout(8000),
          redirect: 'follow',
        });
        if (resp.ok) {
          const text = await resp.text();
          allContent += ' ' + text;
        }
      } catch (e) {
        // Skip failed subpages
      }
    }
    
    if (!allContent.trim()) {
      return { source: 'basic-fetch', status: 'UNREACHABLE', erps: [], signals: [] };
    }
    
    return analyzeForERP(company, allContent, 'basic-fetch');
  } catch (err) {
    return { source: 'basic-fetch', status: 'ERROR', reason: err.message, erps: [], signals: [] };
  }
}

function analyzeForERP(company, content, source) {
  const contentLower = content.toLowerCase();
  const detected = [];
  const signals = [];
  
  for (const [erp, keywords] of Object.entries(COMPETE_KEYWORDS)) {
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (contentLower.includes(kwLower)) {
        // Find context around the match
        const idx = contentLower.indexOf(kwLower);
        const contextStart = Math.max(0, idx - 80);
        const contextEnd = Math.min(content.length, idx + kw.length + 80);
        const context = content.substring(contextStart, contextEnd).replace(/\s+/g, ' ').trim();
        
        if (!detected.includes(erp)) {
          detected.push(erp);
        }
        signals.push({
          erp,
          keyword: kw,
          context: context.substring(0, 200),
        });
      }
    }
  }
  
  // Also check for job posting signals
  const jobKeywords = ['ERP', 'Systemadministrator', 'SAP Berater', 'SAP Consultant',
                        'Dynamics', 'NetSuite', 'Sage Administrator', 'ERP-System'];
  for (const jk of jobKeywords) {
    if (contentLower.includes(jk.toLowerCase())) {
      const idx = contentLower.indexOf(jk.toLowerCase());
      const contextStart = Math.max(0, idx - 60);
      const contextEnd = Math.min(content.length, idx + jk.length + 60);
      signals.push({
        erp: 'JOB_SIGNAL',
        keyword: jk,
        context: content.substring(contextStart, contextEnd).replace(/\s+/g, ' ').trim().substring(0, 200),
      });
    }
  }
  
  return {
    source,
    status: detected.length > 0 ? 'DETECTED' : (signals.length > 0 ? 'SIGNALS' : 'CLEAN'),
    erps: detected,
    signals: signals.slice(0, 10),  // Cap signals
    contentLength: content.length,
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       ENRICHMENT TRIPLE-TEST — COSIB COMPANIES         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  // Check env vars
  console.log('Environment check:');
  console.log(`  APOLLO_API_KEY:      ${APOLLO_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`  OPENROUTER_API_KEY:  ${OPENROUTER_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`  OPENROUTER_MODEL_ID: ${OPENROUTER_MODEL_ID}`);
  console.log(`  FIRECRAWL_API_KEY:   ${FIRECRAWL_API_KEY ? '✅ SET' : '⚠️  MISSING (will use basic fetch)'}`);
  console.log(`  Input file:          ${INPUT_FILE}`);
  console.log(`  Company limit:       ${LIMIT}\n`);
  
  // Load companies
  const companies = loadCompanies(INPUT_FILE, LIMIT);
  if (companies.length === 0) {
    console.error('No companies loaded. Check the input file path and format.');
    process.exit(1);
  }
  
  // Results accumulator
  const results = [];
  const scoreboard = {
    apollo:  { tested: 0, found: 0, empty: 0, error: 0, skipped: 0, totalContacts: 0 },
    xing:    { tested: 0, found: 0, empty: 0, error: 0, skipped: 0, totalEmployees: 0 },
    compete: { tested: 0, detected: 0, signals: 0, clean: 0, error: 0, erpsFound: {} },
  };
  
  // Run tests
  for (let i = 0; i < companies.length; i++) {
    const co = companies[i];
    const progress = `[${i + 1}/${companies.length}]`;
    console.log(`\n${'─'.repeat(60)}`);
    log('TEST', `${progress} ${co.name} (${co.url})`);
    
    // --- Test 1: Apollo ---
    log('APOLLO', `Searching for contacts at ${co.name}...`);
    const apolloResult = await testApollo(co);
    scoreboard.apollo.tested++;
    scoreboard.apollo[apolloResult.status === 'FOUND' ? 'found' : 
                       apolloResult.status === 'SKIPPED' ? 'skipped' :
                       apolloResult.status === 'EMPTY' ? 'empty' : 'error']++;
    scoreboard.apollo.totalContacts += apolloResult.contacts.length;
    log('APOLLO', `→ ${apolloResult.status} (${apolloResult.contacts.length} contacts)`);
    if (apolloResult.contacts.length > 0) {
      apolloResult.contacts.forEach(c => log('APOLLO', `  • ${c.name} — ${c.title} ${c.email ? '📧' : ''}`));
    }
    
    await sleep(APOLLO_DELAY_MS);
    
    // --- Test 2: Xing Presence Check ---
    log('XING', `Checking Xing presence for ${co.name}...`);
    const xingResult = await testXingSearch(co);
    scoreboard.xing.tested++;
    scoreboard.xing[xingResult.status === 'FOUND' ? 'found' : 
                     xingResult.status === 'SKIPPED' ? 'skipped' :
                     xingResult.status === 'EMPTY' ? 'empty' : 'error']++;
    scoreboard.xing.totalEmployees += xingResult.employeeCount || 0;
    log('XING', `→ ${xingResult.status}${xingResult.employeeCount ? ' (' + xingResult.employeeCount + ' employees)' : ''} ${xingResult.companyPageUrl || ''}`);
    if (xingResult.sampleTitles?.length > 0) {
      log('XING', `  Titles seen: ${xingResult.sampleTitles.join(', ')}`);
    }
    
    await sleep(LLM_DELAY_MS);
    
    // --- Test 3: Compete Search ---
    log('COMPETE', `Scanning ${co.url} for ERP signals...`);
    const competeResult = await testCompeteSearch(co);
    scoreboard.compete.tested++;
    if (competeResult.status === 'DETECTED') {
      scoreboard.compete.detected++;
      competeResult.erps.forEach(erp => {
        scoreboard.compete.erpsFound[erp] = (scoreboard.compete.erpsFound[erp] || 0) + 1;
      });
    } else if (competeResult.status === 'SIGNALS') {
      scoreboard.compete.signals++;
    } else if (competeResult.status === 'ERROR' || competeResult.status === 'UNREACHABLE') {
      scoreboard.compete.error++;
    } else {
      scoreboard.compete.clean++;
    }
    log('COMPETE', `→ ${competeResult.status} ${competeResult.erps?.length > 0 ? '🎯 ' + competeResult.erps.join(', ') : ''}`);
    
    await sleep(FIRECRAWL_DELAY_MS);
    
    // Store result
    results.push({
      company: co,
      apollo: apolloResult,
      xing: xingResult,
      compete: competeResult,
    });
    
    // Progress summary every 10 companies
    if ((i + 1) % 10 === 0) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`PROGRESS: ${i + 1}/${companies.length} complete`);
      console.log(`  Apollo:  ${scoreboard.apollo.found} found / ${scoreboard.apollo.empty} empty / ${scoreboard.apollo.error} errors`);
      console.log(`  Xing:    ${scoreboard.xing.found} on Xing / ${scoreboard.xing.empty} not found / ${scoreboard.xing.totalEmployees} total employees`);
      console.log(`  Compete: ${scoreboard.compete.detected} detected / ${scoreboard.compete.signals} signals / ${scoreboard.compete.clean} clean`);
      console.log(`${'═'.repeat(60)}\n`);
    }
  }
  
  // ═══════════════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════════════
  
  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║              FINAL RESULTS — SCORECARD                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  const apolloRate = scoreboard.apollo.tested > 0 
    ? ((scoreboard.apollo.found / (scoreboard.apollo.tested - scoreboard.apollo.skipped)) * 100).toFixed(1) 
    : 'N/A';
  const xingRate = scoreboard.xing.tested > 0 
    ? ((scoreboard.xing.found / (scoreboard.xing.tested - scoreboard.xing.skipped)) * 100).toFixed(1)
    : 'N/A';
  const competeRate = scoreboard.compete.tested > 0
    ? ((scoreboard.compete.detected / scoreboard.compete.tested) * 100).toFixed(1)
    : 'N/A';
  
  console.log('┌────────────────────────────────────────────────────────┐');
  console.log('│ TEST 1: APOLLO CONTACT SEARCH                         │');
  console.log('├────────────────────────────────────────────────────────┤');
  console.log(`│ Tested:          ${scoreboard.apollo.tested}`);
  console.log(`│ Found contacts:  ${scoreboard.apollo.found}  (${apolloRate}% hit rate)`);
  console.log(`│ Empty results:   ${scoreboard.apollo.empty}`);
  console.log(`│ Errors:          ${scoreboard.apollo.error}`);
  console.log(`│ Skipped:         ${scoreboard.apollo.skipped}`);
  console.log(`│ Total contacts:  ${scoreboard.apollo.totalContacts}`);
  console.log('└────────────────────────────────────────────────────────┘\n');
  
  console.log('┌────────────────────────────────────────────────────────┐');
  console.log('│ TEST 2: XING COMPANY PRESENCE                         │');
  console.log('├────────────────────────────────────────────────────────┤');
  console.log(`│ Tested:          ${scoreboard.xing.tested}`);
  console.log(`│ Found on Xing:   ${scoreboard.xing.found}  (${xingRate}% presence rate)`);
  console.log(`│ Not on Xing:     ${scoreboard.xing.empty}`);
  console.log(`│ Errors:          ${scoreboard.xing.error}`);
  console.log(`│ Skipped:         ${scoreboard.xing.skipped}`);
  console.log(`│ Total employees: ${scoreboard.xing.totalEmployees}`);
  console.log(`│ Avg employees:   ${scoreboard.xing.found > 0 ? (scoreboard.xing.totalEmployees / scoreboard.xing.found).toFixed(1) : 'N/A'}`);
  console.log('└────────────────────────────────────────────────────────┘\n');
  
  console.log('┌────────────────────────────────────────────────────────┐');
  console.log('│ TEST 3: COMPETE / ERP DETECTION                        │');
  console.log('├────────────────────────────────────────────────────────┤');
  console.log(`│ Tested:          ${scoreboard.compete.tested}`);
  console.log(`│ ERP detected:    ${scoreboard.compete.detected}  (${competeRate}% detection rate)`);
  console.log(`│ Weak signals:    ${scoreboard.compete.signals}`);
  console.log(`│ Clean (no ERP):  ${scoreboard.compete.clean}`);
  console.log(`│ Errors:          ${scoreboard.compete.error}`);
  if (Object.keys(scoreboard.compete.erpsFound).length > 0) {
    console.log('│ ERP breakdown:');
    for (const [erp, count] of Object.entries(scoreboard.compete.erpsFound).sort((a, b) => b[1] - a[1])) {
      console.log(`│   ${erp}: ${count} companies`);
    }
  }
  console.log('└────────────────────────────────────────────────────────┘\n');
  
  // Head-to-head: Apollo vs Xing
  console.log('┌────────────────────────────────────────────────────────┐');
  console.log('│ HEAD-TO-HEAD: APOLLO CONTACTS vs XING PRESENCE        │');
  console.log('├────────────────────────────────────────────────────────┤');
  let bothFound = 0, apolloOnly = 0, xingOnly = 0, neitherFound = 0;
  for (const r of results) {
    const aHit = r.apollo.status === 'FOUND';
    const xHit = r.xing.status === 'FOUND';
    if (aHit && xHit) bothFound++;
    else if (aHit) apolloOnly++;
    else if (xHit) xingOnly++;
    else neitherFound++;
  }
  console.log(`│ Both found:         ${bothFound}`);
  console.log(`│ Apollo only:        ${apolloOnly}`);
  console.log(`│ Xing only:          ${xingOnly}  ← These are companies Apollo misses`);
  console.log(`│ Neither found:      ${neitherFound}`);
  console.log(`│ Combined coverage:  ${(((bothFound + apolloOnly + xingOnly) / results.length) * 100).toFixed(1)}%`);
  console.log('│');
  console.log(`│ VERDICT: Xing adds ${xingOnly} companies Apollo can't find`);
  console.log('└────────────────────────────────────────────────────────┘\n');
  
  // Save full results
  const outputJson = 'enrichment_test_results.json';
  fs.writeFileSync(outputJson, JSON.stringify({ scoreboard, results }, null, 2));
  log('OUTPUT', `Full results saved to ${outputJson}`);
  
  // Generate HTML report
  generateHTMLReport(scoreboard, results);
}

// ═══════════════════════════════════════════════════════════════
// HTML REPORT GENERATOR
// ═══════════════════════════════════════════════════════════════

function generateHTMLReport(scoreboard, results) {
  const apolloRate = scoreboard.apollo.tested > 0
    ? ((scoreboard.apollo.found / Math.max(1, scoreboard.apollo.tested - scoreboard.apollo.skipped)) * 100).toFixed(1)
    : '0';
  const xingRate = scoreboard.xing.tested > 0
    ? ((scoreboard.xing.found / Math.max(1, scoreboard.xing.tested - scoreboard.xing.skipped)) * 100).toFixed(1)
    : '0';
  const competeRate = scoreboard.compete.tested > 0
    ? ((scoreboard.compete.detected / scoreboard.compete.tested) * 100).toFixed(1)
    : '0';
  
  let bothFound = 0, apolloOnly = 0, xingOnly = 0, neitherFound = 0;
  for (const r of results) {
    const aHit = r.apollo.status === 'FOUND';
    const xHit = r.xing.status === 'FOUND';
    if (aHit && xHit) bothFound++;
    else if (aHit) apolloOnly++;
    else if (xHit) xingOnly++;
    else neitherFound++;
  }
  const combinedRate = (((bothFound + apolloOnly + xingOnly) / results.length) * 100).toFixed(1);
  
  // Build company rows
  let companyRows = '';
  for (const r of results) {
    const apolloStatus = r.apollo.status === 'FOUND' ? '✅' : r.apollo.status === 'EMPTY' ? '❌' : '⚠️';
    const xingStatus = r.xing.status === 'FOUND' ? '✅' : r.xing.status === 'EMPTY' ? '❌' : '⚠️';
    const competeStatus = r.compete.status === 'DETECTED' ? `🎯 ${r.compete.erps.join(', ')}` :
                           r.compete.status === 'SIGNALS' ? '🔍 signals' :
                           r.compete.status === 'CLEAN' ? '—' : '⚠️';
    
    const apolloNames = r.apollo.contacts.map(c => `${c.name} (${c.title})`).join('<br>') || '—';
    const xingInfo = r.xing.status === 'FOUND' 
      ? `${r.xing.employeeCount || '?'} employees${r.xing.companyPageUrl ? '<br><a href="' + r.xing.companyPageUrl + '" target="_blank" style="color:#00d2ff;">Xing page</a>' : ''}`
      : '—';
    
    companyRows += `<tr>
      <td><strong>${r.company.name}</strong><br><small>${r.company.url}</small></td>
      <td>${r.company.location}</td>
      <td class="${r.apollo.status === 'FOUND' ? 'hit' : 'miss'}">${apolloStatus} ${r.apollo.contacts.length}</td>
      <td class="${r.xing.status === 'FOUND' ? 'hit' : 'miss'}">${xingStatus} ${r.xing.employeeCount || 0}</td>
      <td>${competeStatus}</td>
      <td class="details"><small>${apolloNames}</small></td>
      <td class="details"><small>${xingInfo}</small></td>
    </tr>`;
  }
  
  // ERP breakdown
  let erpRows = '';
  for (const [erp, count] of Object.entries(scoreboard.compete.erpsFound || {}).sort((a, b) => b[1] - a[1])) {
    erpRows += `<tr><td>${erp}</td><td>${count}</td></tr>`;
  }
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Enrichment Triple-Test Report — COSIB Companies</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0e17; color: #c8d6e5; padding: 24px; }
  h1 { color: #fff; margin-bottom: 8px; font-size: 24px; }
  h2 { color: #00d2ff; margin: 24px 0 12px; font-size: 18px; border-bottom: 1px solid #1a2332; padding-bottom: 8px; }
  .subtitle { color: #636e72; margin-bottom: 24px; }
  
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; }
  .card h3 { color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .card .big { font-size: 36px; font-weight: 700; color: #fff; }
  .card .rate { font-size: 14px; color: #00d2ff; margin-top: 4px; }
  .card.highlight { border-color: #00d2ff; }
  .card.warn { border-color: #f39c12; }
  .card.good { border-color: #27ae60; }
  
  .h2h { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .h2h .bar { display: flex; gap: 4px; margin-top: 12px; height: 32px; border-radius: 6px; overflow: hidden; }
  .h2h .bar div { display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #fff; }
  .bar .both { background: #27ae60; }
  .bar .apollo-only { background: #3498db; }
  .bar .xing-only { background: #f39c12; }
  .bar .neither { background: #636e72; }
  
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
  th { background: #1a2332; color: #00d2ff; text-align: left; padding: 10px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; }
  td { padding: 8px; border-bottom: 1px solid #1a2332; vertical-align: top; }
  tr:hover { background: #111827; }
  .hit { color: #27ae60; font-weight: 600; }
  .miss { color: #e74c3c; }
  .details { max-width: 200px; }
  
  .footer { text-align: center; color: #636e72; font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #1a2332; }
</style>
</head>
<body>

<h1>🔬 Enrichment Triple-Test Report</h1>
<p class="subtitle">COSIB NRW Manufacturing Companies — ${results.length} tested — ${new Date().toISOString().split('T')[0]}</p>

<div class="cards">
  <div class="card ${parseFloat(apolloRate) > 30 ? 'good' : 'warn'}">
    <h3>Apollo Contacts</h3>
    <div class="big">${scoreboard.apollo.found}</div>
    <div class="rate">${apolloRate}% hit rate · ${scoreboard.apollo.totalContacts} total contacts</div>
  </div>
  <div class="card ${parseFloat(xingRate) > 30 ? 'good' : 'warn'}">
    <h3>Xing Presence</h3>
    <div class="big">${scoreboard.xing.found}</div>
    <div class="rate">${xingRate}% found on Xing · ${scoreboard.xing.totalEmployees} total employees listed</div>
  </div>
  <div class="card highlight">
    <h3>ERP Detected</h3>
    <div class="big">${scoreboard.compete.detected}</div>
    <div class="rate">${competeRate}% detection · ${scoreboard.compete.signals} weak signals</div>
  </div>
  <div class="card highlight">
    <h3>Combined Contact Rate</h3>
    <div class="big">${combinedRate}%</div>
    <div class="rate">${bothFound + apolloOnly + xingOnly} of ${results.length} companies</div>
  </div>
</div>

<div class="h2h">
  <h3 style="color:#fff; margin-bottom: 4px;">Head-to-Head: Apollo Contacts vs Xing Presence</h3>
  <p style="color:#9ca3af; font-size: 13px;">Does Apollo find contacts? Does Xing even know the company?</p>
  <div class="bar">
    <div class="both" style="flex:${bothFound};" title="Both: ${bothFound}">${bothFound > 0 ? 'Both: ' + bothFound : ''}</div>
    <div class="apollo-only" style="flex:${apolloOnly};" title="Apollo only: ${apolloOnly}">${apolloOnly > 0 ? 'Apollo: ' + apolloOnly : ''}</div>
    <div class="xing-only" style="flex:${xingOnly};" title="Xing only: ${xingOnly}">${xingOnly > 0 ? 'Xing: ' + xingOnly : ''}</div>
    <div class="neither" style="flex:${neitherFound};" title="Neither: ${neitherFound}">${neitherFound > 0 ? 'Neither: ' + neitherFound : ''}</div>
  </div>
  <p style="color:#636e72; font-size: 11px; margin-top: 8px;">
    🟢 Both &nbsp; 🔵 Apollo only &nbsp; 🟡 Xing only &nbsp; ⚪ Neither
  </p>
</div>

${erpRows ? `
<h2>🎯 Competing ERP Breakdown</h2>
<table>
  <tr><th>ERP System</th><th>Companies Detected</th></tr>
  ${erpRows}
</table>
` : ''}

<h2>📋 Company-by-Company Results</h2>
<div style="overflow-x: auto;">
<table>
  <tr>
    <th>Company</th>
    <th>Location</th>
    <th>Apollo</th>
    <th>Xing Employees</th>
    <th>ERP Detected</th>
    <th>Apollo Contacts</th>
    <th>Xing Details</th>
  </tr>
  ${companyRows}
</table>
</div>

<div class="footer">
  Generated by LeadHydration Enrichment Test · ${new Date().toISOString()}
</div>

</body>
</html>`;
  
  const outputHtml = 'enrichment_test_report.html';
  fs.writeFileSync(outputHtml, html);
  log('OUTPUT', `HTML report saved to ${outputHtml}`);
}

// ═══════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
