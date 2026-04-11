require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables for OpenRouter
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Environment variables for ClearSignals
const CLEARSIGNALS_VENDOR_KEY = process.env.CLEARSIGNALS_VENDOR_KEY;
const CLEARSIGNALS_SECRET = process.env.CLEARSIGNALS_SECRET;

// Global State Store for Multi-Tenant Portal (Leads & PAM Call Bells)
// In production, this should be replaced with Postgres/MongoDB
const leadStore = new Map();

// Model configurations for different agents
const MODELS = {
  solution: process.env.OPENROUTER_MODEL_SOLUTION || 'anthropic/claude-sonnet-4',
  industry: process.env.OPENROUTER_MODEL_INDUSTRY || 'anthropic/claude-haiku-4.5',
  painpoints: process.env.OPENROUTER_MODEL_PAINPOINTS || 'anthropic/claude-sonnet-4',
  customer: process.env.OPENROUTER_MODEL_CUSTOMER || 'anthropic/claude-haiku-4.5',
  prequalify: process.env.OPENROUTER_MODEL_PREQUALIFY || 'anthropic/claude-haiku-4.5'
};


// ============================================================================
// ===== FIRECRAWL — scrape + interact (optional, falls back if key not set) ==
// ============================================================================
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v2';
const FC_MAX_CHARS = 12000;

function fcAvailable() { return !!FIRECRAWL_API_KEY; }

async function fcScrape(url) {
  if (!fcAvailable()) return null;
  try {
    const r = await axios.post(`${FIRECRAWL_BASE}/scrape`, {
      url, formats: ['markdown'], onlyMainContent: true
    }, { headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const md = r.data?.data?.markdown || r.data?.markdown || '';
    if (!md) return null;
    console.log(`[Firecrawl] Scraped ${Math.min(md.length, FC_MAX_CHARS)} chars from ${url}`);
    return md.slice(0, FC_MAX_CHARS);
  } catch (e) { console.log(`[Firecrawl] scrape failed ${url}: ${e.message}`); return null; }
}

async function fcScrapeGetId(url) {
  if (!fcAvailable()) return null;
  try {
    const r = await axios.post(`${FIRECRAWL_BASE}/scrape`, {
      url, formats: ['markdown'], onlyMainContent: true
    }, { headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    return r.data?.data?.metadata?.scrapeId || r.data?.data?.metadata?.scrape_id || null;
  } catch (e) { console.log(`[Firecrawl] scrapeGetId failed: ${e.message}`); return null; }
}

async function fcInteract(scrapeId, prompt, timeout) {
  timeout = timeout || 45;
  try {
    const r = await axios.post(`${FIRECRAWL_BASE}/scrape/${scrapeId}/interact`,
      { prompt, timeout },
      { headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' }, timeout: (timeout + 10) * 1000 }
    );
    const out = r.data?.output || r.data?.result || '';
    return out ? out.slice(0, FC_MAX_CHARS) : null;
  } catch (e) { console.log(`[Firecrawl] interact failed: ${e.message}`); return null; }
}

async function fcStop(scrapeId) {
  try {
    await axios.delete(`${FIRECRAWL_BASE}/scrape/${scrapeId}/interact`,
      { headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}` }, timeout: 8000 }
    );
  } catch (e) { /* best effort */ }
}

async function fcInteractLinkedIn(linkedinUrl) {
  if (!fcAvailable() || !linkedinUrl) return null;
  const scrapeId = await fcScrapeGetId(linkedinUrl);
  if (!scrapeId) return null;
  try {
    return await fcInteract(scrapeId,
      'Extract the full public profile: headline, about/summary, all work experience (company, title, dates, description), skills, recommendations received, recent posts. Return as plain text with section labels.',
      60);
  } finally { await fcStop(scrapeId); }
}

async function fcInteractSubpages(baseUrl) {
  if (!fcAvailable()) return '';
  const scrapeId = await fcScrapeGetId(baseUrl);
  if (!scrapeId) return '';
  const collected = [];
  try {
    const team = await fcInteract(scrapeId, 'Navigate to the team, leadership, or about-us page. Extract all staff names and titles. Return plain text.', 45);
    if (team) collected.push('--- TEAM/LEADERSHIP ---\n' + team);
    const jobs = await fcInteract(scrapeId, 'Navigate to the careers or jobs page. Extract open roles and required technologies. Return plain text.', 45);
    if (jobs) collected.push('--- CAREERS/JOBS ---\n' + jobs);
  } finally { await fcStop(scrapeId); }
  return collected.join('\n\n');
}

// ============================================================================
// ===== LOCALE-AWARE SIGNAL SCANNER (Firecrawl-powered) ======================
// Uses the SAP B1 prospecting playbook: country-specific job boards, review
// sites, and localized search queries to find migration/ERP signals.
// ============================================================================

const LOCALE_CONFIG = {
  DE: {
    label: 'Germany',
    lang: 'de',
    jobBoards: [
      { site: 'indeed.de', name: 'Indeed DE' },
      { site: 'stepstone.de', name: 'StepStone' },
      { site: 'stellenanzeigen.de', name: 'Stellenanzeigen' }
    ],
    reviewSites: [
      { site: 'kununu.de', name: 'Kununu' },
      { site: 'glassdoor.de', name: 'Glassdoor DE' }
    ],
    professionalNet: 'xing.com',
    keywords: {
      manufacturing: ['Fertigung', 'Produktion', 'Maschinenbau', 'Anlagenbau', 'Metallverarbeitung'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'DATEV', 'Warenwirtschaft'],
      frustration: ['frustriert', 'langsam', 'unzuverlässig', 'veraltet', 'Excel-Tabellen', 'manuelle Prozesse'],
      migration: ['Migration', 'Umstellung', 'Ablösung', 'Einführung', 'Digitalisierung'],
      roles: ['ERP-Berater', 'ERP-Spezialist', 'IT-Leiter', 'Systemadministrator ERP']
    }
  },
  US: {
    label: 'United States',
    lang: 'en',
    jobBoards: [
      { site: 'indeed.com', name: 'Indeed US' },
      { site: 'monster.com', name: 'Monster' }
    ],
    reviewSites: [
      { site: 'glassdoor.com', name: 'Glassdoor US' }
    ],
    professionalNet: 'linkedin.com',
    keywords: {
      manufacturing: ['manufacturing', 'production', 'fabrication', 'machining', 'plant operations'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'QuickBooks', 'spreadsheets'],
      frustration: ['frustrated', 'slow', 'unreliable', 'outdated', 'manual processes', 'spreadsheets everywhere'],
      migration: ['migrating from', 'outgrowing', 'replacing', 'upgrading to', 'ERP selection'],
      roles: ['ERP Specialist', 'ERP Manager', 'IT Manager', 'Systems Analyst', 'ERP Implementation']
    }
  },
  GB: {
    label: 'United Kingdom',
    lang: 'en',
    jobBoards: [
      { site: 'indeed.co.uk', name: 'Indeed UK' },
      { site: 'reed.co.uk', name: 'Reed' },
      { site: 'totaljobs.com', name: 'TotalJobs' }
    ],
    reviewSites: [
      { site: 'glassdoor.co.uk', name: 'Glassdoor UK' }
    ],
    professionalNet: 'linkedin.com',
    keywords: {
      manufacturing: ['manufacturing', 'production', 'engineering', 'fabrication'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'Sage', 'QuickBooks'],
      frustration: ['frustrated', 'slow', 'unreliable', 'outdated', 'manual processes'],
      migration: ['migrating from', 'outgrowing', 'replacing', 'upgrading'],
      roles: ['ERP Specialist', 'ERP Manager', 'IT Manager', 'Systems Analyst']
    }
  },
  FR: {
    label: 'France',
    lang: 'fr',
    jobBoards: [
      { site: 'indeed.fr', name: 'Indeed FR' },
      { site: 'apec.fr', name: 'APEC' }
    ],
    reviewSites: [
      { site: 'glassdoor.fr', name: 'Glassdoor FR' }
    ],
    professionalNet: 'linkedin.com',
    keywords: {
      manufacturing: ['fabrication', 'production', 'usinage', 'industrie'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'Sage', 'GPAO'],
      frustration: ['frustré', 'lent', 'obsolète', 'Excel', 'processus manuels'],
      migration: ['migration', 'remplacement', 'mise en place', 'digitalisation'],
      roles: ['Consultant ERP', 'Responsable ERP', 'Directeur IT', 'Chef de projet ERP']
    }
  },
  AT: {
    label: 'Austria',
    lang: 'de',
    jobBoards: [
      { site: 'indeed.at', name: 'Indeed AT' },
      { site: 'karriere.at', name: 'karriere.at' }
    ],
    reviewSites: [
      { site: 'kununu.de', name: 'Kununu' },
      { site: 'glassdoor.at', name: 'Glassdoor AT' }
    ],
    professionalNet: 'xing.com',
    keywords: {
      manufacturing: ['Fertigung', 'Produktion', 'Maschinenbau'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'BMD'],
      frustration: ['frustriert', 'langsam', 'unzuverlässig', 'veraltet'],
      migration: ['Migration', 'Umstellung', 'Einführung'],
      roles: ['ERP-Berater', 'ERP-Spezialist', 'IT-Leiter']
    }
  },
  CH: {
    label: 'Switzerland',
    lang: 'de',
    jobBoards: [
      { site: 'indeed.ch', name: 'Indeed CH' },
      { site: 'jobs.ch', name: 'jobs.ch' }
    ],
    reviewSites: [
      { site: 'kununu.de', name: 'Kununu' },
      { site: 'glassdoor.ch', name: 'Glassdoor CH' }
    ],
    professionalNet: 'xing.com',
    keywords: {
      manufacturing: ['Fertigung', 'Produktion', 'Maschinenbau'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'Abacus'],
      frustration: ['frustriert', 'langsam', 'unzuverlässig', 'veraltet'],
      migration: ['Migration', 'Umstellung', 'Einführung'],
      roles: ['ERP-Berater', 'ERP-Spezialist', 'IT-Leiter']
    }
  },
  IT: {
    label: 'Italy',
    lang: 'it',
    jobBoards: [
      { site: 'indeed.it', name: 'Indeed IT' },
      { site: 'infojobs.it', name: 'InfoJobs IT' }
    ],
    reviewSites: [
      { site: 'glassdoor.it', name: 'Glassdoor IT' }
    ],
    professionalNet: 'linkedin.com',
    keywords: {
      manufacturing: ['produzione', 'fabbricazione', 'lavorazione', 'manifattura'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'gestionale'],
      frustration: ['frustrato', 'lento', 'obsoleto', 'Excel', 'processi manuali'],
      migration: ['migrazione', 'sostituzione', 'implementazione', 'digitalizzazione'],
      roles: ['Consulente ERP', 'Responsabile IT', 'Project Manager ERP']
    }
  },
  ES: {
    label: 'Spain',
    lang: 'es',
    jobBoards: [
      { site: 'indeed.es', name: 'Indeed ES' },
      { site: 'infojobs.net', name: 'InfoJobs ES' }
    ],
    reviewSites: [
      { site: 'glassdoor.es', name: 'Glassdoor ES' }
    ],
    professionalNet: 'linkedin.com',
    keywords: {
      manufacturing: ['fabricación', 'producción', 'manufactura', 'mecanizado'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'gestión empresarial'],
      frustration: ['frustrado', 'lento', 'obsoleto', 'Excel', 'procesos manuales'],
      migration: ['migración', 'sustitución', 'implementación', 'digitalización'],
      roles: ['Consultor ERP', 'Responsable IT', 'Jefe de proyecto ERP']
    }
  },
  NL: {
    label: 'Netherlands',
    lang: 'nl',
    jobBoards: [
      { site: 'indeed.nl', name: 'Indeed NL' },
      { site: 'nationalevacaturebank.nl', name: 'Nationale Vacaturebank' }
    ],
    reviewSites: [
      { site: 'glassdoor.nl', name: 'Glassdoor NL' }
    ],
    professionalNet: 'linkedin.com',
    keywords: {
      manufacturing: ['productie', 'fabricage', 'machinebouw'],
      erp: ['ERP', 'SAP Business One', 'SAP B1', 'Exact Online'],
      frustration: ['gefrustreerd', 'traag', 'verouderd', 'Excel', 'handmatig'],
      migration: ['migratie', 'vervanging', 'implementatie', 'digitalisering'],
      roles: ['ERP Consultant', 'IT Manager', 'Projectmanager ERP']
    }
  }
};

// Default fallback for unlisted countries
const DEFAULT_LOCALE = {
  label: 'International',
  lang: 'en',
  jobBoards: [{ site: 'indeed.com', name: 'Indeed' }],
  reviewSites: [{ site: 'glassdoor.com', name: 'Glassdoor' }],
  professionalNet: 'linkedin.com',
  keywords: {
    manufacturing: ['manufacturing', 'production'],
    erp: ['ERP', 'SAP Business One'],
    frustration: ['frustrated', 'slow', 'outdated'],
    migration: ['migrating', 'outgrowing', 'replacing'],
    roles: ['ERP Specialist', 'IT Manager']
  }
};

/**
 * Resolve country string → locale config
 * Accepts: "Germany", "DE", "Deutschland", "United States", "US", etc.
 */
function resolveLocale(countryStr) {
  if (!countryStr) return DEFAULT_LOCALE;
  const c = countryStr.trim().toUpperCase();
  // Direct ISO match
  if (LOCALE_CONFIG[c]) return LOCALE_CONFIG[c];
  // Common name mapping
  const nameMap = {
    'GERMANY': 'DE', 'DEUTSCHLAND': 'DE',
    'UNITED STATES': 'US', 'USA': 'US', 'UNITED STATES OF AMERICA': 'US',
    'UNITED KINGDOM': 'GB', 'UK': 'GB', 'ENGLAND': 'GB', 'GREAT BRITAIN': 'GB',
    'FRANCE': 'FR', 'FRANKREICH': 'FR',
    'AUSTRIA': 'AT', 'ÖSTERREICH': 'AT',
    'SWITZERLAND': 'CH', 'SCHWEIZ': 'CH',
    'ITALY': 'IT', 'ITALIEN': 'IT',
    'SPAIN': 'ES', 'SPANIEN': 'ES', 'ESPAÑA': 'ES',
    'NETHERLANDS': 'NL', 'NIEDERLANDE': 'NL', 'HOLLAND': 'NL'
  };
  const mapped = nameMap[c];
  if (mapped && LOCALE_CONFIG[mapped]) return LOCALE_CONFIG[mapped];
  return DEFAULT_LOCALE;
}

/**
 * fcSignalScan — Locale-aware signal intelligence via Firecrawl
 *
 * For a given company + country, scrapes the RIGHT job board and review
 * site for that locale, using localized search terms.
 *
 * Returns: { jobSignals, reviewSignals, signalSummary }
 */
async function fcSignalScan(companyName, country) {
  if (!fcAvailable()) return { jobSignals: null, reviewSignals: null, signalSummary: '' };

  const locale = resolveLocale(country);
  const signals = { jobSignals: null, reviewSignals: null, signalSummary: '' };
  const parts = [];

  console.log(`[SignalScan] ${companyName} → ${locale.label} (${locale.jobBoards.map(j => j.name).join(', ')})`);

  // 1. Job board scan — pick the top board for this locale
  const primaryBoard = locale.jobBoards[0];
  if (primaryBoard) {
    const boardUrl = `https://${primaryBoard.site}`;
    const scrapeId = await fcScrapeGetId(boardUrl);
    if (scrapeId) {
      try {
        const searchPrompt = `Search for "${companyName}" on this job site. Extract ALL job postings for this company. For each posting return: job title, location, and a summary of the description including any mentions of ERP, SAP, software systems, QuickBooks, spreadsheets, migration, implementation, manufacturing, production, ${locale.keywords.erp.join(', ')}. Return as plain text with each job separated by a blank line.`;
        const jobResult = await fcInteract(scrapeId, searchPrompt, 60);
        if (jobResult && jobResult.length > 50) {
          signals.jobSignals = jobResult;
          parts.push('--- JOB POSTINGS (' + primaryBoard.name + ') ---\n' + jobResult);
          console.log(`[SignalScan] ${primaryBoard.name}: ${jobResult.length} chars of job data`);
        }
      } catch (e) {
        console.log(`[SignalScan] ${primaryBoard.name} job scan failed: ${e.message}`);
      } finally {
        await fcStop(scrapeId);
      }
    }
  }

  // 2. Review site scan — pick the top review site for this locale
  const primaryReview = locale.reviewSites[0];
  if (primaryReview) {
    const reviewUrl = `https://${primaryReview.site}`;
    const scrapeId = await fcScrapeGetId(reviewUrl);
    if (scrapeId) {
      try {
        const reviewPrompt = `Search for "${companyName}" company reviews on this site. Extract: overall rating, number of reviews, and any employee comments that mention technology, software, ERP, systems, tools, frustrations, processes, ${locale.keywords.frustration.join(', ')}. Return as plain text.`;
        const reviewResult = await fcInteract(scrapeId, reviewPrompt, 60);
        if (reviewResult && reviewResult.length > 30) {
          signals.reviewSignals = reviewResult;
          parts.push('--- EMPLOYEE REVIEWS (' + primaryReview.name + ') ---\n' + reviewResult);
          console.log(`[SignalScan] ${primaryReview.name}: ${reviewResult.length} chars of review data`);
        }
      } catch (e) {
        console.log(`[SignalScan] ${primaryReview.name} review scan failed: ${e.message}`);
      } finally {
        await fcStop(scrapeId);
      }
    }
  }

  signals.signalSummary = parts.join('\n\n');
  return signals;
}

// Helper function to call OpenRouter
// Options: { maxTokens, webSearch } — webSearch appends :online to model for real-time web results
async function callOpenRouter(model, messages, temperature = 0.3, options = {}) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const maxTokens = options.maxTokens || 2000;
  const useWebSearch = options.webSearch || false;
  const requestModel = useWebSearch && !model.includes(':online') ? `${model}:online` : model;

  try {
    const response = await axios.post(
      OPENROUTER_BASE_URL,
      {
        model: requestModel,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'Lead Hydration Engine'
        },
        timeout: 120000 // 2 min timeout for web search calls
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('OpenRouter API error:', error.response?.data || error.message);
    throw new Error(`API call failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

// Helper: call OpenRouter and parse JSON response (with retry + repair)
async function callOpenRouterJSON(model, systemPrompt, userPrompt, temperature = 0.3, options = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const maxRetries = options.maxRetries || 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await callOpenRouter(model, messages, temperature + (attempt * 0.1), options);

      // Strip code fences
      let content = raw.trim();
      if (content.startsWith('```json')) content = content.slice(7);
      else if (content.startsWith('```')) content = content.slice(3);
      if (content.endsWith('```')) content = content.slice(0, -3);
      content = content.trim();

      // Extract JSON object
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        content = content.substring(jsonStart, jsonEnd + 1);
      }

      // Strip trailing commas before } or ]
      content = content.replace(/,\s*([}\]])/g, '$1');

      // Repair truncated JSON: close any open brackets/braces
      let openBraces = 0, openBrackets = 0;
      let inString = false, escaped = false;
      for (const ch of content) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
      }
      // Close any unclosed structures (truncated response)
      if (openBrackets > 0 || openBraces > 0) {
        console.log(`[JSON Repair] Truncated response detected — closing ${openBrackets} brackets, ${openBraces} braces`);
        // Remove trailing partial content after last complete value
        content = content.replace(/,\s*"[^"]*$/, ''); // remove trailing partial key
        content = content.replace(/,\s*$/, ''); // remove trailing comma
        for (let b = 0; b < openBrackets; b++) content += ']';
        for (let b = 0; b < openBraces; b++) content += '}';
      }

      return JSON.parse(content);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        console.log(`[JSON Parse] Attempt ${attempt + 1} failed, retrying...`);
      }
    }
  }
  throw new Error(`Failed to parse JSON after ${maxRetries + 1} attempts: ${lastError.message}`);
}

// ===== SOLUTION AGENT =====
// TDE-first approach: check if TDE already has a collection for this solution.
// If yes → reconstruct a solution brief from existing atoms (richer, faster, free).
// If no → TDE kicks off Solution Discovery (swarm + deep fill) and creates the collection.
// Fallback: if TDE is unreachable, do the original Firecrawl + LLM approach.

const TDE_BASE_URL = process.env.TDE_BASE_URL || 'https://targeteddecomposition-production.up.railway.app';
const TDE_API_KEY = process.env.TDE_API_KEY || '';

function tdeAvailable() { return !!TDE_API_KEY && !!TDE_BASE_URL; }

async function tdeRequest(method, path, body) {
  const opts = {
    method,
    url: `${TDE_BASE_URL}${path}`,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': TDE_API_KEY },
    timeout: 90000, // swarm can take a while
  };
  if (body) opts.data = body;
  const r = await axios(opts);
  return r.data;
}

// Convert a URL to a safe TDE collection ID
function urlToCollectionId(url) {
  return (url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_{2,}/g, '_').replace(/_$/, '').substring(0, 60);
}

app.post('/api/agent/solution', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    console.log(`[Solution Agent] Researching: ${url}`);
    const collectionId = urlToCollectionId(url);

    // ── Step 1: Try TDE first ──────────────────────────────────────────────
    if (tdeAvailable()) {
      console.log(`[Solution Agent] Checking TDE for: ${collectionId}`);
      try {
        // First: check exact collection by URL-derived ID
        let col = await tdeRequest('GET', `/collections/${collectionId}`).catch(() => null);

        // Second: if not found or thin, search all collections for a keyword match
        if (!col || (col.stats?.atomCount || 0) < 20) {
          console.log(`[Solution Agent] Exact match ${col ? 'thin (' + (col.stats?.atomCount || 0) + ' atoms)' : 'not found'} — searching by keyword`);
          const allCols = await tdeRequest('GET', '/collections').catch(() => []);
          const urlTerms = url.toLowerCase().replace(/https?:\/\//, '').replace(/www\./, '')
            .split(/[\/\-_\.\?=&]+/).filter(t => t.length > 2 && !['com','html','www','https','http','products'].includes(t));
          console.log(`[Solution Agent] URL search terms: ${urlTerms.join(', ')}`);
          let bestMatch = null;
          let bestScore = 0;
          for (const c of allCols) {
            if ((c.stats?.atomCount || 0) < 20) continue;
            const cName = (c.name + ' ' + c.id + ' ' + (c.description || '')).toLowerCase();
            let score = 0;
            for (const term of urlTerms) {
              if (cName.includes(term)) score += (term.length > 4 ? 3 : 1);
            }
            if (score > bestScore) { bestScore = score; bestMatch = c; }
          }
          if (bestMatch && bestScore >= 2) {
            console.log(`[Solution Agent] Keyword match: "${bestMatch.id}" (${bestMatch.stats?.atomCount} atoms, score: ${bestScore})`);
            col = bestMatch;
          }
        }

        if (col && (col.stats?.atomCount || 0) > 20) {
          // Collection exists with substantial content — reconstruct from atoms
          console.log(`[Solution Agent] TDE HIT: ${col.stats.atomCount} atoms in collection "${col.id}"`);
          const tdeColId = col.id; // Use the matched collection ID, not URL-derived
          const enrichment = await tdeRequest('POST', `/reconstruct/${tdeColId}`, {
            intent: 'enrichment',
            query: 'Complete solution profile: product name, type, capabilities, differentiators, target market, key benefits, proof points, competitive positioning, pain points solved',
            format: 'json',
            max_atoms: 25,
            max_words: 800,
          });

          // Parse the reconstructed output into solution format
          let solutionData;
          try {
            const raw = typeof enrichment.output === 'string' ? enrichment.output : JSON.stringify(enrichment.output);
            // The reconstruct endpoint returns text — LLM parse to solution JSON
            const messages = [
              { role: 'system', content: `Convert this solution intelligence into the exact JSON format below. Use ONLY the data provided — do not invent information.\n\n{\n  "name": "Product Name",\n  "type": "Type of solution",\n  "description": "What the solution does",\n  "capabilities": ["cap1", "cap2", "cap3", "cap4", "cap5"],\n  "targetMarket": "Who buys this",\n  "keyBenefits": ["benefit1", "benefit2", "benefit3"],\n  "differentiators": ["diff1", "diff2"],\n  "proofPoints": ["proof1", "proof2"],\n  "painPointsSolved": ["pain1", "pain2", "pain3"],\n  "confidence": "high",\n  "source": "tde"\n}\n\nReturn ONLY valid JSON.` },
              { role: 'user', content: raw }
            ];
            const parsed = await callOpenRouter(MODELS.solution, messages, 0.2, { maxTokens: 1000 });
            const jsonMatch = parsed.match(/```json\n?([\s\S]*?)\n?```/) || parsed.match(/```\n?([\s\S]*?)\n?```/);
            solutionData = JSON.parse((jsonMatch ? jsonMatch[1] : parsed).trim());
          } catch {
            // If parse fails, build a basic structure from what we have
            solutionData = {
              name: col.name || url,
              type: 'Business Software',
              description: typeof enrichment.output === 'string' ? enrichment.output.substring(0, 500) : 'Solution data from TDE',
              capabilities: [],
              targetMarket: 'Unknown',
              keyBenefits: [],
              confidence: enrichment.confidence || 'medium',
              source: 'tde'
            };
          }

          solutionData.source = 'tde';
          solutionData.tde_collection = tdeColId;
          solutionData.tde_atom_count = col.stats.atomCount;
          solutionData.confidence = solutionData.confidence || enrichment.confidence || 'high';
          console.log(`[Solution Agent] TDE reconstruct: ${solutionData.name} (${col.stats.atomCount} atoms, confidence: ${solutionData.confidence})`);
          return res.json(solutionData);
        }

        // Collection doesn't exist or is thin — kick off Solution Discovery
        console.log(`[Solution Agent] TDE MISS: collection "${collectionId}" ${col ? 'has ' + (col.stats?.atomCount || 0) + ' atoms (too few)' : 'does not exist'} — starting Solution Discovery`);
        const research = await tdeRequest('POST', `/research/${collectionId}`, {
          solutionUrl: url,
          solutionName: null // let TDE extract the name
        });

        // research returns { status, msip, enrichment, confidence, gaps, swarm }
        const msip = research.msip || {};
        const solutionData = {
          name: msip.product_name || msip.company_name || url,
          type: msip.product_category || 'Business Software',
          description: msip.value_proposition || msip.one_liner || 'Solution discovered by TDE',
          capabilities: msip.capabilities || msip.features || [],
          targetMarket: msip.target_buyer || msip.icp || 'Unknown',
          keyBenefits: msip.key_benefits || [],
          differentiators: msip.differentiators || [],
          proofPoints: msip.proof_points || msip.social_proof || [],
          painPointsSolved: msip.pain_points || [],
          confidence: research.confidence || 'medium',
          source: 'tde_discovery',
          tde_collection: collectionId,
          tde_status: research.status,
          tde_swarm: research.swarm,
          gaps: research.gaps || []
        };

        console.log(`[Solution Agent] TDE Discovery complete: ${solutionData.name} (status: ${research.status}, agents: ${research.swarm?.agents || '?'})`);
        return res.json(solutionData);

      } catch (tdeErr) {
        console.log(`[Solution Agent] TDE unavailable: ${tdeErr.message} — falling back to direct scrape`);
      }
    }

    // ── Step 2: Fallback — direct Firecrawl + LLM (original approach) ──────
    console.log(`[Solution Agent] Using fallback: Firecrawl + LLM`);
    console.log(`[Solution Agent] Using model: ${MODELS.solution}`);

    let pageContent = '';
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    if (fcAvailable()) {
      const fc = await fcScrape(fullUrl);
      if (fc) { pageContent = fc; console.log(`[Solution Agent] Firecrawl: ${pageContent.length} chars`); }
    }
    if (!pageContent) {
    try {
      const fetchRes = await axios.get(fullUrl, {
        timeout: 15000, maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydrationBot/1.0)' },
        responseType: 'text'
      });
      pageContent = fetchRes.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ')
        .trim().slice(0, 8000);
      console.log(`[Solution Agent] Fetched ${pageContent.length} chars from ${fullUrl}`);
    } catch (fetchErr) {
      console.log(`[Solution Agent] Could not fetch URL: ${fetchErr.message}. Using LLM knowledge only.`);
      pageContent = '';
    }
    }

    const messages = [
      {
        role: 'system',
        content: `You are a solution research expert. Your job is to analyze a product/solution and extract key information.\n\nCRITICAL RULE: If WEBSITE CONTENT is provided below, that is the SOURCE OF TRUTH. Base your analysis primarily on what the website actually says the product does.\n\nReturn your response in this exact JSON format:\n{\n  "name": "Product Name",\n  "type": "Type of solution (e.g., NDR, CRM, ERP, SIEM, EDR, etc.)",\n  "description": "Brief description of what the solution actually does based on the website",\n  "capabilities": ["capability 1", "capability 2", "capability 3", "capability 4", "capability 5"],\n  "targetMarket": "Who typically buys this solution",\n  "keyBenefits": ["benefit 1", "benefit 2", "benefit 3"],\n  "confidence": "high if from website content, low if from knowledge only"\n}`
      },
      {
        role: 'user',
        content: `Analyze this solution: ${url}\n\n${pageContent ? 'WEBSITE CONTENT (SOURCE OF TRUTH):\n' + pageContent : 'NOTE: Could not fetch website content. Use your knowledge but indicate low confidence.'}\n\nReturn ONLY valid JSON, no markdown formatting, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.solution, messages, 0.3);
    let solutionData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      solutionData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('Failed to parse solution response:', response);
      return res.json({
        raw: response, name: 'Unknown Solution', type: 'Business Software',
        description: 'Could not parse solution details', capabilities: [],
        targetMarket: 'Unknown', keyBenefits: [], source: 'fallback'
      });
    }

    solutionData.source = 'firecrawl';
    console.log(`[Solution Agent] Completed: ${solutionData.name}`);
    res.json(solutionData);

  } catch (error) {
    console.error('[Solution Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== INDUSTRY AGENT =====
// Uses OPENROUTER_MODEL_INDUSTRY to detect industry from company info
app.post('/api/agent/industry', async (req, res) => {
  try {
    const { companyName, website, address, country, skipSignalScan } = req.body;
    
    if (!companyName || !website) {
      return res.status(400).json({ error: 'Company name and website are required' });
    }

    console.log(`[Industry Agent] Analyzing: ${companyName}${skipSignalScan ? ' (fast mode)' : ''}`);
    console.log(`[Industry Agent] Using model: ${MODELS.industry}`);

    // Step 1: Firecrawl scrape the company website for real content
    let websiteContent = '';
    const fullUrl = website.startsWith('http') ? website : 'https://' + website;
    if (fcAvailable()) {
      const fc = await fcScrape(fullUrl);
      if (fc) {
        websiteContent = fc;
        console.log(`[Industry Agent] Firecrawl: ${websiteContent.length} chars from ${website}`);
      }
    }
    if (!websiteContent) {
      // Fallback: raw axios HTML strip
      try {
        const fetchRes = await axios.get(fullUrl, {
          timeout: 10000, maxRedirects: 5,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydrationBot/1.0)' },
          responseType: 'text'
        });
        websiteContent = fetchRes.data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
        console.log(`[Industry Agent] Axios fallback: ${websiteContent.length} chars`);
      } catch (fetchErr) {
        console.log(`[Industry Agent] Could not fetch ${website}: ${fetchErr.message}`);
      }
    }

    // Step 2: Signal scan — locale-aware job board + review site scraping
    // SKIP in batch mode (skipSignalScan=true) — the interact sessions take 60-120s each
    const effectiveCountry = country || 'US';
    let signalContext = '';
    if (fcAvailable() && !skipSignalScan) {
      const scan = await fcSignalScan(companyName, effectiveCountry);
      if (scan.signalSummary) {
        signalContext = scan.signalSummary;
        console.log(`[Industry Agent] Signal scan: ${signalContext.length} chars`);
      }
    } else if (skipSignalScan) {
      console.log(`[Industry Agent] Signal scan skipped (batch mode)`);
    }

    // Step 3: Resolve locale for localized keywords
    const locale = resolveLocale(effectiveCountry);

    const messages = [
      {
        role: 'system',
        content: `You are an industry classification expert. Your job is to analyze a company using its ACTUAL WEBSITE CONTENT (primary source of truth), any available job posting and employee review signals, and your general knowledge (secondary).

ALWAYS return ALL THREE industry code systems:
- sicCode: US SIC code (4 digits, e.g. "3599" for Industrial Machinery NEC, "3444" for Sheet Metal Work)
- naicsCode: US NAICS code (4-6 digits, e.g. "332710" for Machine Shops, "333249" for Industrial Machinery)
- localCode: The LOCAL country industry code for the company's country:
  * Germany → WZ code (e.g. "28" for Maschinenbau, "25" for Metallerzeugnisse)
  * UK → UK SIC code (may differ from US SIC)
  * France → NAF/APE code
  * Italy → ATECO code
  * Spain → CNAE code
  * Netherlands → SBI code
  * Other EU → NACE Rev.2 code
  * US → same as NAICS

Return your response in this exact JSON format:
{
  "industry": "Primary Industry Name in English",
  "subIndustry": "More specific sub-category if applicable",
  "sicCode": "US SIC code (4 digits)",
  "naicsCode": "US NAICS code (4-6 digits)",
  "localCode": "Local country industry code",
  "localCodeSystem": "WZ|UK-SIC|NAF|ATECO|CNAE|SBI|NACE|NAICS",
  "confidence": "High/Medium/Low",
  "reasoning": "Brief explanation citing specific evidence from the website content or signals",
  "contentSource": "firecrawl|axios|llm_only"
}

RULES:
- If WEBSITE CONTENT is provided, use it as your PRIMARY evidence for classification.
- If JOB POSTINGS or EMPLOYEE REVIEWS are provided, use them as SECONDARY signals to confirm or refine.
- Be specific with industry names — "Discrete Manufacturing" not just "Manufacturing".
- If uncertain, use "Unknown" with Low confidence.`
      },
      {
        role: 'user',
        content: `Classify this company's industry:

Company Name: ${companyName}
Website: ${website}
${address ? `Address: ${address}` : ''}
Country: ${effectiveCountry}

${websiteContent ? 'WEBSITE CONTENT (ground truth):\n' + websiteContent.slice(0, 6000) : 'NOTE: Could not fetch website. Use company name and your knowledge.'}
${signalContext ? '\n\nEXTERNAL SIGNALS:\n' + signalContext.slice(0, 4000) : ''}

Return ONLY valid JSON, no markdown formatting, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.industry, messages, 0.2, { maxTokens: 800 });
    
    let industryData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      industryData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('Failed to parse industry response:', response);
      industryData = {
        industry: 'Unknown',
        subIndustry: null,
        sicCode: null,
        naicsCode: null,
        localCode: null,
        localCodeSystem: null,
        confidence: 'Low',
        reasoning: 'Could not parse response',
        raw: response
      };
    }

    // Ensure all code fields exist
    industryData.sicCode = industryData.sicCode || null;
    industryData.naicsCode = industryData.naicsCode || null;
    industryData.localCode = industryData.localCode || null;
    industryData.localCodeSystem = industryData.localCodeSystem || null;
    industryData.contentSource = websiteContent ? (fcAvailable() ? 'firecrawl' : 'axios') : 'llm_only';

    console.log(`[Industry Agent] Result: ${industryData.industry} (${industryData.confidence}) SIC:${industryData.sicCode || '?'} NAICS:${industryData.naicsCode || '?'} Local:${industryData.localCode || '?'}`);
    res.json(industryData);

  } catch (error) {
    console.error('[Industry Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== PRE-QUALIFY AGENT =====
// Two-pass approach:
//   Pass 1: Try URL as given. If it works → classify + score. If URL fails → flag and skip.
//   Pass 2: For URL failures, search by company name + city to find real domain, then classify.
// Always returns BOTH US NAICS code AND local industry code (WZ/NACE for Germany).

const DEAD_DOMAINS = ['forsaledomain.net', 'forsaledomain.com', 'parked.com', 'sedoparking.com', 'hier-im-netz.de', 'chayns.site', 'odoo.com', 'banggood.com'];

// Helper: try to fetch a URL and extract content snippet
async function scrapeUrl(url, timeout = 8000) {
  if (!url) return { alive: false, snippet: '', resolvedDomain: null, reason: 'no_url' };
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  try {
    const resp = await axios.get(fullUrl, {
      timeout, maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: s => s < 500,
      responseType: 'text'
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || fullUrl;
    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    // Check for parked/dead domains
    if (DEAD_DOMAINS.some(d => host.includes(d))) {
      return { alive: false, snippet: '', resolvedDomain: host, reason: 'parked_domain' };
    }
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (html.length < 200) {
      return { alive: false, snippet: '', resolvedDomain: host, reason: 'empty_page' };
    }
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
                   || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const bodyText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
    const snippet = `TITLE: ${(titleMatch ? titleMatch[1].trim() : '')}\nMETA: ${(metaMatch ? metaMatch[1].trim() : '')}\nCONTENT: ${bodyText}`;
    return { alive: true, snippet, resolvedDomain: host, reason: null };
  } catch (err) {
    return { alive: false, snippet: '', resolvedDomain: null, reason: err.code || err.message };
  }
}

// Helper: try multiple URL variants for a domain
async function tryDomainVariants(domain) {
  if (!domain) return null;
  const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  for (const prefix of ['https://', 'https://www.', 'http://', 'http://www.']) {
    const result = await scrapeUrl(prefix + clean, 6000);
    if (result.alive) return result;
  }
  return null;
}

// Helper: search for a company domain by name + city
async function searchForCompanyDomain(companyName, city) {
  try {
    const query = encodeURIComponent(`${companyName} ${city || ''} Germany official website`);
    const resp = await axios.get(`https://html.duckduckgo.com/html/?q=${query}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const urlMatches = resp.data.match(/href="(https?:\/\/[^"]+)"/g) || [];
    const urls = urlMatches
      .map(m => m.replace('href="', '').replace('"', ''))
      .filter(u => !u.includes('duckduckgo') && !u.includes('google') && !u.includes('bing') && !u.includes('wikipedia') && !u.includes('linkedin'))
      .slice(0, 5);
    for (const url of urls) {
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (!DEAD_DOMAINS.some(d => host.includes(d))) {
          const check = await scrapeUrl(`https://${host}`, 5000);
          if (check.alive) return check;
        }
      } catch {}
    }
  } catch (err) {
    console.log(`  [Search] Failed for "${companyName}": ${err.message}`);
  }
  return null;
}

// Main pre-qualify endpoint — single company
app.post('/api/agent/prequalify', async (req, res) => {
  try {
    const { companyName, website, solution, targetIndustries, employeeCount, city, country, pass, lang } = req.body;
    if (!companyName) return res.status(400).json({ error: 'companyName is required' });

    const isSecondPass = pass === 2;
    const effectiveCountry = (country || 'Germany').trim();
    const isGerman = effectiveCountry.toLowerCase().includes('german') || effectiveCountry.toLowerCase() === 'de';
    const responseLang = lang === 'en' ? 'Respond in English.' : 'Respond in German (Deutsch). All text fields including fitReason, disqualifyReason, industry, and subIndustry should be in German.';

    console.log(`[Pre-Qualify${isSecondPass ? ' P2' : ''}] Screening: ${companyName}`);

    // Step 1: Try to get website content
    let scrapeResult = null;
    if (website) {
      scrapeResult = await tryDomainVariants(website);
    }

    // If first pass and URL failed → return urlFailed flag immediately (don't waste LLM call)
    if (!isSecondPass && !scrapeResult?.alive && website) {
      console.log(`[Pre-Qualify] ${companyName}: URL FAILED (${website}) → deferred to pass 2`);
      return res.json({
        industry: 'Unknown', subIndustry: null, sicCode: null, naicsCode: null, wzCode: null,
        fitScore: 0, fitReason: 'Website could not be reached — deferred to second pass',
        disqualifyReason: null, sizeEstimate: null,
        websiteAlive: false, urlFailed: true, qualified: false,
        failReason: scrapeResult?.reason || 'unreachable'
      });
    }

    // Second pass: if URL still not alive, try searching by name + city
    if (isSecondPass && !scrapeResult?.alive) {
      console.log(`[Pre-Qualify P2] Searching for ${companyName} in ${city || 'unknown city'}...`);
      scrapeResult = await searchForCompanyDomain(companyName, city);
      if (scrapeResult?.alive) {
        console.log(`[Pre-Qualify P2] Found: ${scrapeResult.resolvedDomain}`);
      } else {
        console.log(`[Pre-Qualify P2] ${companyName}: No domain found via search either`);
      }
    }

    // Step 2: LLM classification with dual industry codes
    const targetIndustryContext = targetIndustries?.length > 0
      ? `\n\nTARGET INDUSTRIES: ${targetIndustries.join(', ')}\nCompanies NOT matching these → fitScore below 40.`
      : '';
    const solutionContext = solution
      ? `\nSOLUTION: ${solution.name || 'Unknown'} (${solution.type || 'Unknown'}) | Target: ${solution.targetMarket || 'SMB'}`
      : '';

    // Build solution-aware scoring context
    const isSAPB1 = solution && (solution.name || '').toLowerCase().includes('sap');
    const sapScoringContext = isSAPB1 ? `

SAP BUSINESS ONE SPECIFIC SCORING SIGNALS (use these to refine fitScore):
High-value signals (+10-15 points each):
- Company is in discrete manufacturing, process manufacturing, project manufacturing, engineer-to-order, or job shop
- Company has 11-250 employees (the SAP B1 sweet spot for Mittelstand)
- Website mentions production planning, BOM, MRP, inventory management, or shop floor
- Company appears to be outgrowing entry-level software (QuickBooks, DATEV, Lexware, spreadsheets)

Medium-value signals (+5-8 points each):
- Company is in machinery/plant engineering (Maschinenbau/Anlagenbau), metal fabrication, automotive supply, plastics, chemicals, food production
- Website mentions quality control, lot/serial traceability, or compliance (GoBD, ISO)
- Company has multiple product lines or mixed-mode manufacturing
- Evidence of international operations or multi-currency needs

Negative signals (reduce score):
- Company is pure retail, consulting, services, media, real estate, hospitality (not manufacturing) → fitScore below 30
- Company appears to have fewer than 10 employees → fitScore below 40
- Company appears to have 500+ employees (too large for B1, needs S/4HANA) → fitScore below 50
- Parked domain, no real business content, or domain is for sale → fitScore 0
- Company is a barber shop, tutoring center, fashion retailer, or other non-manufacturing → fitScore below 20` : '';

    const messages = [
      {
        role: 'system',
        content: `You are a rapid lead qualification expert specializing in ERP prospect identification. Classify this company and score its fit for the solution being sold.

ALWAYS return ALL THREE industry code systems:
- sicCode: US SIC code (4 digits, e.g. "3599" for Industrial Machinery NEC, "3444" for Sheet Metal Work)
- naicsCode: US NAICS code (e.g. "332710" for Machine Shops, "333249" for Industrial Machinery, "326199" for Plastics)
- localCode: The local country industry code. For Germany this is the WZ/NACE code (e.g. "28" for Maschinenbau, "25" for Metallerzeugnisse, "22" for Kunststoff). For other countries use the equivalent national code.

Return ONLY valid JSON:
{
  "industry": "Primary industry name in English",
  "subIndustry": "More specific sub-category (e.g. Discrete Manufacturing, Process Manufacturing, Engineer-to-Order)",
  "manufacturingType": "discrete|process|project|job_shop|mixed|none",
  "sicCode": "US SIC code (4 digits)",
  "naicsCode": "US NAICS code (4-6 digits)",
  "localCode": "Local industry code (WZ for Germany, SIC for UK, etc.)",
  "localCodeSystem": "WZ" or "NACE" or "SIC" etc.,
  "fitScore": <integer 0-100>,
  "fitReason": "1-2 sentence explanation citing specific signals found",
  "disqualifyReason": "If fitScore is low, explain specifically why. Otherwise null",
  "sizeEstimate": "Estimated company size if detectable",
  "erpSignals": ["list any detected signals: current ERP mentioned, pain points visible, growth indicators, compliance needs"],
  "websiteAlive": true/false
}

Scoring guide:
- 85-100: Manufacturing SMB, right size, clear ERP need, strong industry match
- 70-84: Manufacturing-adjacent or right industry but uncertain size/need
- 60-69: Possible fit — tangential industry but some manufacturing activity
- 40-59: Weak fit — mostly non-manufacturing but has some industrial element
- 0-39: Not a fit — wrong industry, too small, too large, or not a real business${sapScoringContext}${targetIndustryContext}

${responseLang}`
      },
      {
        role: 'user',
        content: `Pre-qualify this company:

COMPANY: ${companyName}
WEBSITE: ${scrapeResult?.resolvedDomain || website || 'Unknown'}
COUNTRY: ${effectiveCountry}
${city ? 'CITY: ' + city : ''}
${employeeCount ? 'EMPLOYEES: ' + employeeCount : ''}${solutionContext}

${scrapeResult?.snippet ? 'WEBSITE CONTENT:\n' + scrapeResult.snippet : 'NOTE: Could not fetch website. Use company name and context to classify.'}

Return ONLY valid JSON.`
      }
    ];

    const response = await callOpenRouter(MODELS.prequalify, messages, 0.2, { maxTokens: 800 });

    let result;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      result = JSON.parse(jsonString.trim());
    } catch {
      result = {
        industry: 'Unknown', subIndustry: null, sicCode: null, naicsCode: null, localCode: null, localCodeSystem: null,
        fitScore: 50, fitReason: 'Could not parse response',
        disqualifyReason: null, sizeEstimate: null, websiteAlive: !!scrapeResult?.alive
      };
    }

    // Normalize
    result.fitScore = parseInt(result.fitScore) || 50;
    // Let the frontend decide qualification based on its threshold slider
    // Server just provides the score — no hardcoded cutoff
    result.qualified = result.fitScore >= 0; // always pass through, frontend filters
    result.websiteAlive = !!scrapeResult?.alive;
    result.urlFailed = false;
    result.sicCode = result.sicCode || null;
    // Backward compat: keep wzCode for German companies
    if (isGerman && result.localCode) result.wzCode = result.localCode;
    // If domain was resolved via search, include it
    if (scrapeResult?.resolvedDomain && scrapeResult.resolvedDomain !== (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '')) {
      result.resolvedDomain = scrapeResult.resolvedDomain;
    }

    console.log(`[Pre-Qualify${isSecondPass ? ' P2' : ''}] ${companyName}: ${result.fitScore}/100 — ${result.qualified ? 'QUALIFIED' : 'DISQUALIFIED'} (${result.industry}) SIC:${result.sicCode || '?'} NAICS:${result.naicsCode || '?'} Local:${result.localCode || '?'}`);
    res.json(result);

  } catch (error) {
    console.error('[Pre-Qualify] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== PAIN POINT AGENT =====
// Uses OPENROUTER_MODEL_PAINPOINTS to map solution to industry pain points
app.post('/api/agent/painpoints', async (req, res) => {
  try {
    const { industry, solution } = req.body;
    
    if (!industry || !solution) {
      return res.status(400).json({ error: 'Industry and solution data are required' });
    }

    console.log(`[Pain Point Agent] Mapping: ${industry} + ${solution.name}`);
    console.log(`[Pain Point Agent] Using model: ${MODELS.painpoints}`);

    const messages = [
      {
        role: 'system',
        content: `You are a business analyst expert specializing in identifying industry pain points and how solutions address them.

Return your response in this exact JSON format:
{
  "painPoints": [
    {
      "pain": "Description of the pain point/challenge",
      "solution": "How the solution addresses this pain point",
      "impact": "Business impact of solving this (e.g., 'Reduces costs by 30%', 'Saves 10 hours per week')"
    }
  ]
}

Provide 4-6 specific, actionable pain points that are relevant to this industry and solution combination.`
      },
      {
        role: 'user',
        content: `Identify pain points for this industry + solution combination:

INDUSTRY: ${industry}

SOLUTION: ${solution.name}
TYPE: ${solution.type}
DESCRIPTION: ${solution.description}
CAPABILITIES: ${solution.capabilities?.join(', ') || 'N/A'}
TARGET MARKET: ${solution.targetMarket || 'N/A'}

What are the top pain points companies in the ${industry} industry face that ${solution.name} can solve?

For each pain point, explain:
1. What is the pain point?
2. How does ${solution.name} solve it?
3. What is the business impact?

Return ONLY valid JSON, no markdown formatting, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.painpoints, messages, 0.4);
    
    let painData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      painData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('Failed to parse pain points response:', response);
      painData = {
        painPoints: [
          {
            pain: 'Could not parse pain points',
            solution: 'N/A',
            impact: 'N/A'
          }
        ],
        raw: response
      };
    }

    console.log(`[Pain Point Agent] Mapped ${painData.painPoints?.length || 0} pain points`);
    res.json(painData);

  } catch (error) {
    console.error('[Pain Point Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== CUSTOMER RESEARCH AGENT =====
// Uses OPENROUTER_MODEL_CUSTOMER to research individual companies
app.post('/api/agent/customer', async (req, res) => {
  try {
    const { companyName, website, address } = req.body;
    
    if (!companyName || !website) {
      return res.status(400).json({ error: 'Company name and website are required' });
    }

    console.log(`[Customer Agent] Researching: ${companyName}`);
    console.log(`[Customer Agent] Using model: ${MODELS.customer}`);

    // Firecrawl: homepage scrape + team/careers subpage interact
    let fcContext = '';
    if (website && fcAvailable()) {
      const wsUrl = website.startsWith('http') ? website : 'https://' + website;
      const homepage = await fcScrape(wsUrl);
      const subpages = await fcInteractSubpages(wsUrl);
      if (homepage) fcContext += '\n\nHOMEPAGE (scraped — ground truth):\n' + homepage;
      if (subpages) fcContext += '\n\n' + subpages;
      if (fcContext) console.log(`[Customer Agent] Firecrawl: ${fcContext.length} chars`);
    }

    const messages = [
      {
        role: 'system',
        content: `You are a company research expert. Your job is to gather intelligence about a company for sales purposes.

Return your response in this exact JSON format:
{
  "companyName": "Full company name",
  "industry": "Primary industry",
  "companySize": "Estimated size if known (e.g., '500-1000 employees', 'Enterprise', 'SMB')",
  "headquarters": "Location if known",
  "description": "Brief description of what the company does",
  "keyDecisionMakers": ["likely role 1", "likely role 2"],
  "potentialUseCases": ["use case 1", "use case 2"],
  "researchNotes": "Any additional intelligence that would help in sales outreach"
}

If information is not available, use null or "Unknown".`
      },
      {
        role: 'user',
        content: `Research this company for sales intelligence:

Company Name: ${companyName}
Website: ${website}
${address ? `Address: ${address}` : ''}

What can you determine about this company that would be useful for a sales conversation?
${fcContext ? fcContext : ''}
${fcContext ? 'Scraped content above is ground truth. Use web search to fill gaps: LinkedIn, news, reviews, job postings.' : 'Search the web for everything useful: LinkedIn, news, reviews, job postings.'}

Return ONLY valid JSON, no markdown formatting, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.customer, messages, 0.3);
    
    let customerData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      customerData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('Failed to parse customer response:', response);
      customerData = {
        companyName: companyName,
        industry: 'Unknown',
        companySize: 'Unknown',
        headquarters: address || 'Unknown',
        description: 'Could not retrieve company information',
        keyDecisionMakers: [],
        potentialUseCases: [],
        researchNotes: response
      };
    }

    console.log(`[Customer Agent] Completed: ${customerData.companyName}`);
    res.json(customerData);

  } catch (error) {
    console.error('[Customer Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== BATCH PROCESSING ENDPOINTS =====

// Process multiple companies for industry detection
app.post('/api/batch/industries', async (req, res) => {
  try {
    const { companies } = req.body;
    
    if (!Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({ error: 'Companies array is required' });
    }

    console.log(`[Batch Industry] Processing ${companies.length} companies`);

    const results = [];
    for (const company of companies) {
      try {
        const messages = [
          {
            role: 'system',
            content: `You are an industry classification expert. Return ONLY a JSON object with: {"industry": "Industry Name", "confidence": "High/Medium/Low"}`
          },
          {
            role: 'user',
            content: `What industry is "${company.name}" (${company.url}) in? Return only JSON.`
          }
        ];

        const response = await callOpenRouter(MODELS.industry, messages, 0.2);
        
        let result;
        try {
          const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
          // Fixed regex fallback matching
          const cleanResponse = response.replace(/```json/g, '').replace(/```/g, '').trim();
          result = JSON.parse(cleanResponse);
        } catch {
          result = { industry: 'Unknown', confidence: 'Low' };
        }

        results.push({
          name: company.name,
          url: company.url,
          ...result
        });

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        results.push({
          name: company.name,
          url: company.url,
          industry: 'Error',
          confidence: 'Low',
          error: err.message
        });
      }
    }

    res.json({ results });

  } catch (error) {
    console.error('[Batch Industry] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// ===== CLEARSIGNALS AI ENGINE (BUILT-IN) =================================
// Embedded ClearSignals deal coaching powered by OpenRouter.
// Response format matches the ClearSignals API spec exactly, so when
// ClearSignals ships as a standalone service, swap this for external calls.
// =========================================================================

// Session store — self-issued tokens carry lead context
const csSessions = new Map();
const crypto = require('crypto');

// 1. Create a coaching session (self-issued token with lead context)
app.post('/api/coaching-session', async (req, res) => {
    const { companyName, contactName, contactTitle, contactEmail, dealValue, stage } = req.body;

    try {
        const sessionToken = 'cs_sess_' + crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000).toISOString();

        csSessions.set(sessionToken, {
            lead: {
                company: companyName || 'Unknown Prospect',
                contact_name: contactName || null,
                contact_title: contactTitle || null,
                contact_email: contactEmail || null,
                estimated_value: dealValue || null,
                stage: stage || 'Discovery'
            },
            created_at: new Date().toISOString(),
            expires_at: expiresAt
        });

        console.log(`[ClearSignals] Session created for: ${companyName} (${sessionToken.substring(0, 20)}...)`);
        res.json({ session_token: sessionToken, expires_at: expiresAt });
    } catch (error) {
        console.error('[ClearSignals Session Error]:', error.message);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// 2. Analyze email thread — the actual ClearSignals engine
app.post('/api/coaching-analyze', async (req, res) => {
    const { session_token, thread_text } = req.body;

    if (!session_token || !thread_text) {
        return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'session_token and thread_text are required', status: 400 } });
    }

    if (thread_text.length < 100) {
        return res.status(422).json({ error: { code: 'THREAD_TOO_SHORT', message: 'Thread text must contain at least 100 characters.', status: 422 } });
    }

    // Validate session
    const session = csSessions.get(session_token);
    if (!session) {
        return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid or expired session token', status: 401 } });
    }
    if (new Date(session.expires_at) < new Date()) {
        csSessions.delete(session_token);
        return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Session token expired', status: 401 } });
    }

    const lead = session.lead;
    const analysisId = 'ca_' + crypto.randomBytes(8).toString('hex');

    try {
        console.log(`[ClearSignals] Analyzing thread for ${lead.company} (${thread_text.length} chars)...`);

        // Build solution context from lead store + any pain context the frontend passed
        const storedLead = leadStore.get(lead.company);
        const painCtx = req.body.pain_context; // Frontend can pass companyPainData[company]
        const solutionCtx = painCtx
            ? `The solution being sold is an ERP/business software system. Known intelligence for this company: ${JSON.stringify(painCtx)}`
            : storedLead
                ? `Known lead data: ${JSON.stringify(storedLead)}`
                : 'No prior solution context available — analyze based on thread content alone.';

        const messages = [
            {
                role: 'system',
                content: `You are ClearSignals AI — an elite email thread analyst for B2B sales coaching.

You receive a pasted email thread between a sales rep and a prospect. Your job is to:
1. Parse the conversation: identify participants, timeline, direction of each message
2. Assess deal health: score 0-100, detect sentiment trends, identify risk signals
3. Provide specific, actionable next steps with timing and rationale
4. Offer coaching tips: teach the rep what to do differently based on patterns you see

LEAD CONTEXT (from the vendor portal):
- Company: ${lead.company}
- Contact: ${lead.contact_name || 'Unknown'} (${lead.contact_title || 'Unknown title'})
- Deal Value: ${lead.estimated_value || 'Unknown'}
- Stage: ${lead.stage || 'Unknown'}

SOLUTION CONTEXT:
${solutionCtx}

Return ONLY valid JSON matching this exact structure:
{
  "analysis_id": "${analysisId}",
  "generated_at": "${new Date().toISOString()}",
  "deal_health": {
    "score": <0-100>,
    "label": "<healthy|neutral|at_risk|critical>",
    "stage": "<detected deal stage>",
    "days_in_stage": <estimated days or null>,
    "last_activity_days": <days since last message>,
    "response_rate": <0.0-1.0 ratio of prospect replies to rep messages>,
    "sentiment_trend": "<warming|stable|cooling|cold>"
  },
  "intelligence": {
    "company": {
      "summary": "<what you can infer about this company from the thread>",
      "relevance": "<why this matters for the deal right now>"
    },
    "industry": {
      "summary": "<industry context relevant to this deal>",
      "relevance": "<timing or competitive pressure insights>"
    }
  },
  "timeline": [
    {
      "date": "<YYYY-MM-DD or approximate>",
      "direction": "<outbound|inbound|gap>",
      "label": "<short description of this touchpoint>",
      "status": "<positive|neutral|concerning>",
      "note": "<what this tells us about the deal>"
    }
  ],
  "next_steps": [
    {
      "priority": <1-5>,
      "action": "<specific action to take>",
      "detail": "<how to do it, what to reference>",
      "timing": "<Today|This week|Within 48 hours|etc.>",
      "rationale": "<why this matters now>"
    }
  ],
  "coaching_tips": [
    {
      "title": "<coaching lesson title>",
      "tip": "<the actual advice>",
      "in_this_thread": "<specific example from this thread that triggered the tip>"
    }
  ]
}

Provide at least 3 timeline entries, 3 next steps (prioritized), and 2 coaching tips.
Be specific — reference actual names, dates, and phrases from the thread. No generic advice.
Return ONLY valid JSON, no markdown, no explanations.`
            },
            {
                role: 'user',
                content: `Analyze this email thread and provide deal coaching:\n\n${thread_text}`
            }
        ];

        const llmResponse = await callOpenRouter(
            MODELS.painpoints, // Use the strong model for analysis
            messages,
            0.3
        );

        // Parse the LLM response
        let analysis;
        try {
            if (!llmResponse) throw new Error('LLM returned null response');
            const jsonMatch = llmResponse.match(/```json\n?([\s\S]*?)\n?```/) || llmResponse.match(/```\n?([\s\S]*?)\n?```/);
            const jsonString = jsonMatch ? jsonMatch[1] : llmResponse;
            analysis = JSON.parse(jsonString.trim());
        } catch (parseError) {
            console.error('[ClearSignals] Parse error:', (llmResponse || '(null response)').substring(0, 300));
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to parse analysis response', status: 500 } });
        }

        // Ensure required fields and add metadata
        analysis.analysis_id = analysisId;
        analysis.generated_at = new Date().toISOString();
        analysis.pii_purged_at = new Date(Date.now() + 1000).toISOString(); // PII purge guarantee

        console.log(`[ClearSignals] Analysis complete: ${analysisId} — Deal health: ${analysis.deal_health?.score}/100 (${analysis.deal_health?.label})`);
        res.json(analysis);

    } catch (error) {
        console.error('[ClearSignals Engine Error]:', error.message);
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Analysis failed: ' + error.message, status: 500 } });
    }
});

// Cleanup expired sessions every 30 minutes
setInterval(() => {
    const now = new Date();
    for (const [token, session] of csSessions) {
        if (new Date(session.expires_at) < now) csSessions.delete(token);
    }
}, 1800000);

// 2. Flight Attendant Call Bell - RING (Escalate to PAM)
app.post('/api/leads/:companyName/ring-bell', (req, res) => {
    const companyName = req.params.companyName;
    const lead = leadStore.get(companyName) || { companyName: companyName };
    
    lead.is_pam_alert_active = true;
    lead.pam_alert_start_time = new Date();
    leadStore.set(companyName, lead);
    
    console.log(`[CALL BELL ACTIVE] PAM Alert triggered for: ${companyName}`);
    // Here you would trigger an email via SendGrid/Postmark to the PAM
    
    res.json({ status: 'success', is_pam_alert_active: true });
});

// 3. Flight Attendant Call Bell - CLEAR (PAM Acknowledged)
app.post('/api/leads/:companyName/clear-bell', (req, res) => {
    const companyName = req.params.companyName;
    const lead = leadStore.get(companyName);
    
    if (lead) {
        lead.is_pam_alert_active = false;
        leadStore.set(companyName, lead);
        console.log(`[CALL BELL CLEARED] PAM resolved alert for: ${companyName}`);
    }
    
    res.json({ status: 'success', is_pam_alert_active: false });
});

// 4. Endpoint to fetch current lead state (for UI updates)
app.get('/api/leads/:companyName/status', (req, res) => {
    const companyName = req.params.companyName;
    const lead = leadStore.get(companyName) || { is_pam_alert_active: false };
    res.json(lead);
});

// ============================================================================

// ===== PER-COMPANY PAIN AGENT =====
// Generates rich per-company sales intelligence: leading question, why ask it,
// expected good/bad outcomes, 2 follow-up questions, and extra company background.
app.post('/api/agent/company-pain', async (req, res) => {
  try {
    const { companyName, website, address, industry, solution, lang, tier } = req.body;
    if (!companyName || !solution) {
      return res.status(400).json({ error: 'companyName and solution are required' });
    }
    // Tier 2 = LLM-only (fast batch mode), Tier 3 = full evidence (on-demand deep intel)
    const effectiveTier = parseInt(tier) || 2;
    const responseLang = lang === 'en'
      ? 'Respond entirely in English.'
      : 'Respond entirely in German (Deutsch). All fields — whoIsThis, fitReason, painIndicators labels and explanations, questions, strategicInsight, extraBackground, and emailCampaign subject lines and bodies — MUST be in German.';

    console.log(`[Company Pain Agent] Generating intelligence for: ${companyName} (Tier ${effectiveTier})`);

    // ── EVIDENCE GATHERING ── Only runs for Tier 3 (Deep Intel) ────────────
    let evidenceBlock = '';
    const evidenceSources = [];

    if (effectiveTier < 3) {
      console.log(`[Company Pain Agent] Tier ${effectiveTier}: skipping evidence gathering (batch mode)`);
    }

    // 1. Firecrawl: scrape the company's actual website for leadership + signals
    if (effectiveTier >= 3 && website) {
      const domain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      try {
        // Scrape main page + key subpages
        const pagePaths = ['', '/ueber-uns', '/about', '/impressum', '/karriere', '/jobs', '/produkte', '/products'];
        let siteContent = '';
        if (fcAvailable()) {
          for (const p of pagePaths) {
            if (siteContent.length > 12000) break;
            const md = await fcScrape('https://' + domain + p);
            if (md) siteContent += '\n---PAGE: ' + p + '---\n' + md;
          }
        } else {
          for (const p of pagePaths.slice(0, 4)) {
            if (siteContent.length > 8000) break;
            try {
              const r = await axios.get('https://' + domain + p, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydration/1.0)' },
                timeout: 6000, maxRedirects: 3
              });
              if (r.data && typeof r.data === 'string') {
                const text = r.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                siteContent += '\n---PAGE: ' + p + '---\n' + text.substring(0, 3000);
              }
            } catch (e) { /* skip */ }
          }
        }
        if (siteContent.length > 100) {
          evidenceBlock += '\n\n=== COMPANY WEBSITE CONTENT (VERIFIED) ===\n' + siteContent.substring(0, 8000);
          evidenceSources.push('website_scrape');
          console.log(`[Company Pain Agent] Website scraped: ${siteContent.length} chars`);
        }
      } catch (e) {
        console.log(`[Company Pain Agent] Website scrape failed: ${e.message}`);
      }
    }

    // 2. TDE: query the solution collection for relevant atoms
    if (effectiveTier >= 3 && tdeAvailable() && solution.tde_collection) {
      try {
        const searchQuery = `${industry || ''} pain points challenges problems ${companyName}`;
        const tdeResults = await tdeRequest('GET', `/search/${solution.tde_collection}?q=${encodeURIComponent(searchQuery)}&top_k=10`);
        if (tdeResults.results?.length) {
          const atomText = tdeResults.results.map(r =>
            `[${r.metadata?.evidence_type || 'insight'}] ${r.text?.substring(0, 300)}`
          ).join('\n');
          evidenceBlock += '\n\n=== SOLUTION KNOWLEDGE BASE (TDE ATOMS) ===\n' + atomText;
          evidenceSources.push('tde_atoms:' + tdeResults.results.length);
          console.log(`[Company Pain Agent] TDE returned ${tdeResults.results.length} relevant atoms`);
        }
      } catch (e) {
        console.log(`[Company Pain Agent] TDE search failed: ${e.message}`);
      }
    }

    // 3. Compete-detect: check for ERP signals on their site
    if (effectiveTier >= 3 && website) {
      try {
        const competeRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/agent/compete-detect`, {
          companyName, website, industry
        }, { timeout: 30000 });
        const cd = competeRes.data;
        if (cd.detected && cd.erps?.length) {
          evidenceBlock += '\n\n=== ERP/TECH SIGNALS DETECTED ON WEBSITE ===\n';
          evidenceBlock += 'Detected ERPs: ' + cd.erps.join(', ') + '\n';
          if (cd.signals?.length) {
            evidenceBlock += cd.signals.map(s => `- ${s.erp}: "${s.keyword}" found in context: ${s.context}`).join('\n');
          }
          evidenceSources.push('erp_detection:' + cd.erps.join(','));
          console.log(`[Company Pain Agent] ERP signals detected: ${cd.erps.join(', ')}`);
        }
      } catch (e) {
        console.log(`[Company Pain Agent] Compete-detect failed: ${e.message}`);
      }
    }

    console.log(`[Company Pain Agent] Evidence sources: ${evidenceSources.length ? evidenceSources.join(', ') : 'NONE (LLM-only)'}`);

    const messages = [
      {
        role: 'system',
        content: `You are an elite B2B sales strategist specialising in ERP and business software.
Given a target company and a solution being sold, generate highly specific, research-backed sales intelligence for a first meeting.
Return ONLY valid JSON in this exact format:
{
  "score": <integer 1-100 representing how strong a fit this company is for the solution>,
  "whoIsThis": "<2-3 sentence narrative about what this company does, their market position, and why they are relevant>",
  "primaryLead": {
    "title": "<specific job title of the primary person to target, e.g. 'Head of Operations / Plant Manager'>",
    "topic": "<the primary conversation topic, e.g. 'Production Planning with MRP & Shop Floor Control'>"
  },
  "painIndicators": [
    { "label": "<2-4 word pain chip>", "explanation": "<1-2 sentence explanation of why this is a pain for this specific company and how the solution addresses it>" },
    { "label": "<2-4 word pain chip>", "explanation": "<explanation>" },
    { "label": "<2-4 word pain chip>", "explanation": "<explanation>" },
    { "label": "<2-4 word pain chip>", "explanation": "<explanation>" }
  ],
  "questions": [
    {
      "stage": "OPENING — Discovery",
      "question": "<powerful open-ended question tailored to this company/industry>",
      "purpose": "<why we ask this — what intelligence it reveals>",
      "pain_point": "<the specific pain this question is designed to uncover>",
      "positive_responses": [
        { "response": "<what a good/interested answer sounds like>", "next_step": "<what to do next if they say this>" },
        { "response": "<another positive scenario>", "next_step": "<follow-up action>" }
      ],
      "neutral_negative_responses": [
        { "response": "<what a dismissive or negative answer sounds like>", "pivot": "<how to redirect the conversation>" },
        { "response": "<another negative scenario>", "pivot": "<alternative approach>" }
      ]
    },
    {
      "stage": "DEEPENING — Pain Exploration",
      "question": "<follow-up question drilling deeper into the pain>",
      "purpose": "<why this deepening question matters>",
      "pain_point": "<the deeper pain layer this uncovers>",
      "positive_responses": [
        { "response": "<positive answer>", "next_step": "<next action>" }
      ],
      "neutral_negative_responses": [
        { "response": "<negative answer>", "pivot": "<pivot strategy>" }
      ]
    },
    {
      "stage": "CLOSING — Business Impact & ROI",
      "question": "<question linking pain to business impact or ROI>",
      "purpose": "<why connecting to ROI matters here>",
      "pain_point": "<the business cost this reveals>",
      "positive_responses": [
        { "response": "<positive answer>", "next_step": "<next action>" }
      ],
      "neutral_negative_responses": [
        { "response": "<negative answer>", "pivot": "<pivot strategy>" }
      ]
    }
  ],
  "strategicInsight": "<1-2 sentence AI insight about this specific opportunity — what makes this company a strong prospect, what angle to lead with, or where the biggest opportunity lies. NOT a question. Think of it as a smart colleague whispering in your ear before the meeting.>",
  "extraBackground": "<2-3 sentences of extra company context: region, company culture, industry dynamics, or recent trends that help the seller prepare>",
  "emailCampaign": [
    {
      "step": 1,
      "label": "Initial Outreach",
      "sendDay": "Day 1",
      "subject": "<compelling subject line>",
      "body": "<full cold outreach email — 3-4 short paragraphs, professional, references their specific industry/pain, ends with soft CTA>"
    },
    {
      "step": 2,
      "label": "Value-Add Follow-Up",
      "sendDay": "Day 4",
      "subject": "<follow-up subject referencing first email>",
      "body": "<shorter follow-up sharing a relevant insight, case study, or stat — adds value without being pushy>"
    },
    {
      "step": 3,
      "label": "Pain-Point Trigger",
      "sendDay": "Day 8",
      "subject": "<subject highlighting a specific pain point>",
      "body": "<email that zeroes in on one specific pain indicator for this company — make it feel personal and timely>"
    },
    {
      "step": 4,
      "label": "Social Proof & Nudge",
      "sendDay": "Day 14",
      "subject": "<subject with social proof angle>",
      "body": "<email referencing similar companies or industry peers who solved this problem — gentle nudge to reconnect>"
    },
    {
      "step": 5,
      "label": "Breakup / Last Touch",
      "sendDay": "Day 21",
      "subject": "<closing/breakup subject>",
      "body": "<short, friendly breakup email — acknowledge they may be busy, leave door open, create urgency without pressure>"
    }
  ],
  "hanaUpgrade": {
    "candidate": true or false,
    "confidence": "high" | "medium" | "low",
    "signals": ["signal1", "signal2"],
    "reason": "1-2 sentence explanation of why this company may or may not be outgrowing SAP Business One"
  }
}

HANA UPGRADE ASSESSMENT:
Also evaluate whether this company shows signs of outgrowing SAP Business One and could be an S/4HANA Cloud mid-market upgrade candidate.
Signals that indicate upgrade candidacy: 200+ employees and growing, multiple international subsidiaries or locations, complex supply chain, revenue over 50M EUR, Industry 4.0 / IoT / smart factory / digital twin mentions, hiring for senior ERP or IT transformation roles.
If none of these signals are present, set candidate: false with confidence: "low".`
      },
      {
        role: 'user',
        content: `Generate sales intelligence for this company:

COMPANY: ${companyName}
WEBSITE: ${website || 'Unknown'}
LOCATION: ${address || 'Unknown'}
INDUSTRY: ${industry || 'Unknown'}

SOLUTION BEING SOLD: ${solution.name}
SOLUTION TYPE: ${solution.type}
SOLUTION DESCRIPTION: ${solution.description}
KEY CAPABILITIES: ${solution.capabilities?.join(', ') || 'N/A'}
TARGET MARKET: ${solution.targetMarket || 'N/A'}
${solution.differentiators?.length ? 'DIFFERENTIATORS: ' + solution.differentiators.join(', ') : ''}
${solution.painPointsSolved?.length ? 'PAIN POINTS SOLVED: ' + solution.painPointsSolved.join(', ') : ''}

EVIDENCE SOURCES AVAILABLE: ${evidenceSources.length ? evidenceSources.join(', ') : 'NONE'}
${evidenceBlock || '\nNO VERIFIED EVIDENCE AVAILABLE — all insights below are INFERRED from general industry knowledge. Mark them accordingly.'}

CRITICAL EVIDENCE RULES:
- If COMPANY WEBSITE CONTENT is provided above, use it as PRIMARY source. Reference specific things found on their site.
- If TDE ATOMS are provided, use those proof points and case studies in your pain indicators and questions.
- If ERP SIGNALS are detected, reference the specific technology found and build displacement strategy around it.
- Do NOT state specific operational details about the company (like "they use spreadsheets" or "they rely on manual processes") UNLESS that evidence appears in the website content or detected signals above.
- If no evidence exists for a claim, phrase it as a hypothesis: "Companies in this segment typically face..." NOT "${companyName} relies on..."
- The whoIsThis field should cite what was actually found on their website, not invented details.
- The strategicInsight should reference real signals when available.

Generate highly specific intelligence for a first sales meeting at this company.
Each of the 3 questions must be tailored to their specific industry context.
The first question is the strategic opener, the second drills deeper into pain, the third links to ROI/business impact.
Each question MUST include purpose, pain_point, positive_responses (with next_step), and neutral_negative_responses (with pivot).
Pain indicators should be 2-4 word chips (e.g. "Manual Production Scheduling"), each with a 1-2 sentence explanation grounded in evidence when available.
The strategicInsight should be a short AI insight about the opportunity — NOT a question.
The emailCampaign should be a 5-step drip sequence personalized to this company.
Also assess whether this company is a potential S/4HANA Cloud upgrade candidate.
Return ONLY valid JSON, no markdown, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.painpoints, messages, 0.5, { maxTokens: 16000, webSearch: true });

    let companyPainData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      companyPainData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('[Company Pain Agent] Parse error:', (response || '(null)').substring(0, 200));
      return res.status(500).json({ error: 'Failed to parse company pain response' });
    }

    console.log(`[Company Pain Agent] Complete for: ${companyName} (score: ${companyPainData.score})`);
    companyPainData.evidenceSources = evidenceSources;
    companyPainData.tier = effectiveTier;
    res.json(companyPainData);

  } catch (error) {
    console.error('[Company Pain Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ===== COMPETE DETECTION + PLAYBOOK QUESTIONS ===============================
// Scans company website for competing ERP signals, returns matched
// competitive displacement questions from the SAP playbook.
// ============================================================================

const COMPETE_ERP_KEYWORDS = {
  'Microsoft Dynamics': ['Dynamics 365', 'Dynamics NAV', 'Navision', 'Business Central', 'Dynamics AX', 'Axapta'],
  'Oracle NetSuite': ['NetSuite', 'Oracle ERP', 'JD Edwards'],
  'Sage': ['Sage 100', 'Sage X3', 'Sage 50', 'Sage Intacct'],
  'Infor': ['Infor CloudSuite', 'Infor LN', 'Infor M3', 'Baan'],
  'proALPHA': ['proALPHA'],
  'abas': ['abas ERP'],
  'SAP (existing)': ['SAP Business One', 'SAP B1', 'S/4HANA', 'SAP ERP', 'SAP R/3'],
  'DATEV': ['DATEV'],
  'Lexware': ['Lexware'],
  'Exact': ['Exact Online'],
  'Comarch': ['Comarch ERP'],
  'APplus': ['APplus'],
  'myfactory': ['myfactory'],
  'SelectLine': ['SelectLine'],
  'Haufe X360': ['Haufe X360', 'lexbizz'],
};

const PLAYBOOK_QUESTIONS = {
  1:  { title: 'Deployment Flexibility', question: 'Was being locked into cloud-only a concern, or did your team specifically choose to give up on-premise options?', category: 'Infrastructure', targetSystem: 'Dynamics 365' },
  2:  { title: 'Month-End Close', question: 'Is your finance team closing in days, or still spending nights pulling data into Excel?', category: 'Finance', targetSystem: 'Dynamics 365' },
  3:  { title: 'Manufacturing Gaps', question: 'Did built-in manufacturing handle your production needs, or did you need third-party add-ons?', category: 'Manufacturing', targetSystem: 'Dynamics 365' },
  4:  { title: 'Total Cost Surprises', question: 'Has total cost been predictable, or have there been surprises with licensing tiers, CRM, and AI costs?', category: 'TCO', targetSystem: 'Dynamics 365' },
  5:  { title: 'Implementation Lessons', question: 'If you could do the implementation over, what would you change?', category: 'Implementation', targetSystem: 'Dynamics 365' },
  6:  { title: 'Excel Dependency', question: 'Does your finance team still use Excel more than they would like?', category: 'Finance', targetSystem: 'Dynamics 365' },
  7:  { title: 'Cloud Lock-In', question: 'Has there been a moment where your team wished you could keep certain data on-premise?', category: 'Infrastructure', targetSystem: 'NetSuite' },
  8:  { title: 'Renewal Price Shock', question: 'How have annual license renewals been? In line with expectations?', category: 'TCO', targetSystem: 'NetSuite' },
  9:  { title: 'Support Quality', question: 'When you need something fixed, do you get help or get directed toward paid services?', category: 'Support', targetSystem: 'NetSuite' },
  10: { title: 'Customization Debt', question: 'Have upgrades become harder as you have added customizations?', category: 'Technical', targetSystem: 'NetSuite' },
  11: { title: 'Reporting Speed', question: 'When leadership asks for a new report, how long does it take? Hours, days, or weeks?', category: 'Analytics', targetSystem: 'NetSuite' },
  12: { title: 'Manufacturing Depth', question: 'How well has NetSuite handled production planning, BOM management, and shop floor tracking?', category: 'Manufacturing', targetSystem: 'NetSuite' },
  13: { title: 'Add-On Costs', question: 'What are you spending on third-party add-ons each year to fill gaps?', category: 'TCO', targetSystem: 'NetSuite' },
  14: { title: 'Multi-Entity Pain', question: 'Is consolidated financial reporting smooth, or does it take manual Excel work?', category: 'Multi-Entity', targetSystem: 'NetSuite' },
};

const PLAYBOOK_PICKS = {
  'Microsoft Dynamics': { manufacturer: [3, 6, 2], general: [4, 2, 5], regulated: [1, 4, 2] },
  'Oracle NetSuite': { manufacturer: [12, 13, 8], general: [8, 10, 11], multiEntity: [14, 8, 13] },
};

app.post('/api/agent/compete-detect', async (req, res) => {
  try {
    const { companyName, website, industry } = req.body;
    if (!website) return res.json({ detected: false, erps: [], playbook: [] });

    console.log(`[Compete] Scanning ${companyName} (${website})`);
    const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    let content = '';

    if (fcAvailable()) {
      const md = await fcScrape('https://' + domain);
      if (md) content = md;
    }
    if (!content) {
      for (const page of ['', '/impressum', '/ueber-uns', '/about', '/karriere', '/jobs']) {
        try {
          const r = await axios.get('https://' + domain + page, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydration/1.0)' },
            timeout: 8000, maxRedirects: 3,
          });
          if (r.data && typeof r.data === 'string') content += ' ' + r.data;
        } catch (e) { /* skip */ }
      }
    }
    if (!content) return res.json({ detected: false, erps: [], playbook: [], reason: 'unreachable' });

    const contentLower = content.toLowerCase();
    const detectedERPs = [];
    const signals = [];
    for (const [erp, keywords] of Object.entries(COMPETE_ERP_KEYWORDS)) {
      for (const kw of keywords) {
        if (contentLower.includes(kw.toLowerCase())) {
          if (!detectedERPs.includes(erp)) detectedERPs.push(erp);
          const idx = contentLower.indexOf(kw.toLowerCase());
          const ctx = content.substring(Math.max(0, idx - 60), Math.min(content.length, idx + kw.length + 60)).replace(/\s+/g, ' ').trim();
          signals.push({ erp, keyword: kw, context: ctx.substring(0, 150) });
        }
      }
    }
    // Job posting ERP signals
    for (const jk of ['ERP-System', 'ERP Berater', 'ERP Consultant', 'ERP-Einführung', 'ERP Migration']) {
      if (contentLower.includes(jk.toLowerCase())) signals.push({ erp: 'JOB_SIGNAL', keyword: jk, context: '' });
    }

    const playbook = [];
    const isManufacturer = !!(industry || '').toLowerCase().match(/manufactur|maschinenbau|fertigung|produktion|metal|plastic|chemical/);
    const isMultiEntity = (contentLower.match(/standort|niederlassung|tochtergesellschaft|subsidiary|branch office|filiale/g) || []).length >= 2;

    for (const erp of detectedERPs) {
      const picks = PLAYBOOK_PICKS[erp];
      if (!picks) continue;
      let pickedNums = isManufacturer && picks.manufacturer ? picks.manufacturer
        : isMultiEntity && picks.multiEntity ? picks.multiEntity
        : picks.general;
      for (const num of (pickedNums || [])) {
        const q = PLAYBOOK_QUESTIONS[num];
        if (q) playbook.push({ questionNumber: num, ...q });
      }
    }

    console.log(`[Compete] ${companyName}: ${detectedERPs.length > 0 ? detectedERPs.join(', ') : 'No ERP'} | ${playbook.length} playbook Qs`);
    res.json({ detected: detectedERPs.length > 0, erps: detectedERPs, signals: signals.slice(0, 8), playbook, isManufacturer, isMultiEntity });
  } catch (error) {
    console.error('[Compete] Error:', error.message);
    res.json({ detected: false, erps: [], playbook: [], error: error.message });
  }
});

// Brain Trust advisory panel system
const { BRAIN_TRUST_ROLES, runBrainTrustPanel, runBrainTrustVertical, runBrainTrustPainMapper, runBrainTrustMetro } = require('./brain-trust')(callOpenRouterJSON, MODELS);

// ============================================================================
// ===== PROSPECTOR MODULE (ported from OppIntelAI) =====
// Proactively finds new leads using web search via OpenRouter :online models
// Pipeline: Solution TDP → Vertical Selector → Metro Cartographer → Account Prospector
// ============================================================================

// --- VERTICAL SELECTOR AGENT ---
async function runVerticalSelector(solutionData, targetVertical = '') {
  const systemPrompt = `You are the Vertical Selector Agent in a proactive B2B lead prospecting engine. Given a solution's profile, identify the BEST industry vertical to target.

Select the vertical where this solution has the highest probability of closing deals — not the broadest market, but the deepest pain.

Evaluate verticals against:
1. STRUCTURAL COMPLEXITY: Does this vertical inherently require the solution's capabilities?
2. FRAGMENTED LANDSCAPE: Are there many local/regional SMB players (not just national giants)?
3. OPERATIONAL PAIN DENSITY: How acute and common is the pain this solution solves?
4. ACCESSIBILITY: Can we find and research these companies through public data?

Return JSON:
{
  "selected_vertical": "Specific vertical name (operational language, not generic NAICS)",
  "naics_codes": ["Relevant NAICS codes"],
  "rationale": "3-4 sentences explaining why this vertical has the highest propensity",
  "structural_fit": "Why this vertical inherently needs the solution",
  "pain_density": "How common and acute the pain is",
  "competitive_landscape": "What the competitive environment looks like",
  "runner_up_verticals": [
    { "vertical": "Second best", "why_not_first": "Why it ranked second" },
    { "vertical": "Third best", "why_not_first": "Why it ranked third" }
  ],
  "micro_verticals": ["Hyper-specific sub-segments (e.g., 'Custom metal fabricators serving aerospace with lot traceability requirements')"]
}

Be specific. 'Manufacturing' is too broad. 'Custom metal fabricators serving aerospace with lot traceability requirements' is the right level.`;

  const overrideInstruction = targetVertical
    ? `\nThe user has suggested targeting: "${targetVertical}"\nValidate this choice. If it's strong, confirm it. If there's a significantly better vertical, override and explain why.`
    : '';

  const userPrompt = `Given this solution profile, identify the best industry vertical to prospect into.
${overrideInstruction}

=== SOLUTION PROFILE ===
Name: ${solutionData.name}
Type: ${solutionData.type || ''}
Description: ${solutionData.description || ''}
Capabilities: ${(solutionData.capabilities || []).join(', ')}
Target Market: ${solutionData.targetMarket || ''}

Use web search if needed to validate your vertical selection against real market data.`;

  console.log('[Vertical Selector] Running...');
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 3000 });
  console.log(`[Vertical Selector] Selected: ${result.selected_vertical}`);
  return result;
}


// --- PAIN MAPPER AGENT (bridges Vertical Selector and Account Prospector) ---
async function runPainMapper(solutionData, verticalData) {
  const systemPrompt = `You are the Pain Mapper Agent in a B2B lead prospecting engine.

You receive a SOLUTION PROFILE and a SELECTED INDUSTRY VERTICAL. Your job is to produce a surgical pain map: the specific operational pains that companies in this vertical experience that this solution directly addresses.

This is NOT generic marketing. Each pain must be:
1. SPECIFIC to the vertical — not "inefficiency" but "manual lot traceability across multi-supplier raw material intake"
2. TIED to a real business consequence — revenue loss, compliance risk, customer churn, employee burnout
3. OBSERVABLE from the outside — what signals would indicate a company is suffering from this pain?
4. MAPPED to a specific solution capability — which feature solves this exact pain?

Return JSON:
{
  "pain_map": [
    {
      "pain": "Specific operational pain in plain language",
      "severity": "critical | high | moderate",
      "who_feels_it": "Specific job title(s) who experience this pain daily",
      "business_cost": "What this pain actually costs — dollars, time, risk, or opportunity",
      "observable_signals": ["External signals indicating this pain"],
      "solution_capability": "Which feature solves this",
      "trigger_events": ["Events making this urgent"]
    }
  ],
  "ideal_prospect_profile": {
    "company_size": "Employee range where this pain is most acute",
    "revenue_range": "Revenue range if relevant",
    "tech_maturity": "low | mixed | high",
    "complexity_indicators": ["What makes a company complex enough to need this"],
    "disqualifiers": ["Signs they do NOT have this pain or already solved it"]
  },
  "search_terms": ["Terms for Account Prospector to search"],
  "vertical_context": "2-3 sentences of industry context"
}

Produce 5-8 pain points. Quality over quantity.`;

  const userPrompt = `Map the specific pain points for this solution + vertical combination:

=== SOLUTION ===
Name: ${solutionData.name}
Type: ${solutionData.type || ''}
Description: ${solutionData.description || ''}
Capabilities: ${(solutionData.capabilities || []).join(', ')}
Target Market: ${solutionData.targetMarket || ''}
Key Benefits: ${(solutionData.keyBenefits || []).join(', ')}

=== SELECTED VERTICAL ===
Vertical: ${verticalData.selected_vertical}
Rationale: ${verticalData.rationale || ''}
Structural Fit: ${verticalData.structural_fit || ''}
Pain Density: ${verticalData.pain_density || ''}
Micro-Verticals: ${(verticalData.micro_verticals || []).join(', ')}`;

  console.log(`[Pain Mapper] Mapping pains for ${solutionData.name} x ${verticalData.selected_vertical}...`);
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 5000 });
  console.log(`[Pain Mapper] Mapped ${(result.pain_map || []).length} pain points`);
  return result;
}
// --- METRO CARTOGRAPHER AGENT ---
async function runMetroCartographer(solutionData, verticalData, geoSeed = '') {
  const systemPrompt = `You are the Metro Cartographer Agent in a proactive lead prospecting engine. Given a solution profile and a target vertical, select the BEST metropolitan area for prospecting.

Optimize for prospect DENSITY and SALES EFFICIENCY.

Evaluate metros against:
1. TARGET DENSITY: Minimum 50+ SMB targets in the selected vertical
2. LOGISTICS COMPLEXITY: Multiple counties/suburbs with branch operations = pain amplification
3. COMPETITIVE LANDSCAPE: Known incumbent vendors create competitive framing opportunities
4. ECONOMIC MOMENTUM: Growth indicators, new construction, business expansion signals

Return JSON:
{
  "selected_metro": "Metro name (e.g., Dallas-Fort Worth, TX)",
  "city_core": "Primary city",
  "state": "State abbreviation or country",
  "rationale": "3-4 sentences explaining why this metro is optimal",
  "estimated_target_pool": "Estimated number of qualifying SMBs",
  "key_business_corridors": [
    { "corridor": "Business district or corridor name", "description": "What types of businesses cluster here", "landmark": "Notable landmark for rapport" }
  ],
  "economic_signals": ["Growth indicators specific to this metro"],
  "incumbent_vendors": ["Known technology vendors active here"],
  "adjacent_metros": [
    { "metro": "Nearby metro", "distance": "Drive time", "density": "Additional target pool" }
  ],
  "local_knowledge": {
    "major_highways": ["Key highways"],
    "industrial_zones": ["Named industrial areas"],
    "rapport_references": ["Local references a rep can use — sports teams, landmarks, recent events"]
  }
}

Be specific and local. A sales rep should read this and navigate the metro like they've worked it for months.`;

  const geoInstruction = geoSeed
    ? `\nThe user has suggested targeting: "${geoSeed}"\nValidate that this metro has sufficient target density. If insufficient, suggest expanding or recommend a better metro.`
    : '';

  const userPrompt = `Select the optimal metropolitan area for prospecting.
${geoInstruction}

=== SOLUTION ===
Name: ${solutionData.name}
Type: ${solutionData.type || ''}
Capabilities: ${(solutionData.capabilities || []).join(', ')}
Target Market: ${solutionData.targetMarket || ''}

=== SELECTED VERTICAL ===
Vertical: ${verticalData.selected_vertical}
Rationale: ${verticalData.rationale || ''}
Structural Fit: ${verticalData.structural_fit || ''}
Micro-Verticals: ${(verticalData.micro_verticals || []).join(', ')}

Search the web for business density data, local corridors, economic signals, and known vendors in candidate metros.`;

  console.log('[Metro Cartographer] Running...');
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 3000 });
  console.log(`[Metro Cartographer] Selected: ${result.selected_metro}`);
  return result;
}

// --- ACCOUNT PROSPECTOR AGENT ---
async function runAccountProspector(solutionData, verticalData, metroData, accountVolume = 10, painData = null) {
  const systemPrompt = `You are the Account Prospector Agent in a proactive B2B lead prospecting engine.

Your job: given a solution profile, a target vertical, and a target metro, identify SPECIFIC REAL COMPANIES that are strong candidates to buy the solution RIGHT NOW.

Rules:
1. Every company MUST be real. Use web search to find actual businesses.
2. Never fabricate company names, addresses, phone numbers, or websites.
3. Apply the provided qualification criteria exactly as given.
4. The "who_is_this" narrative must contain specific intel a rep couldn't guess from the name alone.
5. Pain tags must reflect things the prospect would actually say out loud.
6. If you cannot find enough qualifying companies, return what you have honestly. Do NOT pad with fabricated entries.

Return JSON:
{
  "prospects": [
    {
      "id": 1,
      "name": "Exact company name",
      "website": "Company URL or empty string",
      "metro": "Metro area",
      "location": "City, State/Country",
      "landmark": "Specific local landmark or business park",
      "employees": "Estimated range e.g. 150-300",
      "phone": "(XXX) XXX-XXXX or empty string",
      "priority": 85,
      "priority_class": "high | medium | low",
      "who_is_this": "2-3 sentence narrative: company type + local position + current trigger + pain implication",
      "contact_title": "Most likely decision-maker title",
      "lead_module": "The specific solution capability that maps to their top pain",
      "pain_tags": ["Pain 1", "Pain 2", "Pain 3"],
      "growth_signals": ["Specific evidence of growth, hiring, or change"],
      "disqualification_risk": "Any reason this lead might not qualify on deeper inspection"
    }
  ],
  "search_summary": {
    "total_found": 0,
    "high_priority": 0,
    "medium_priority": 0,
    "metros_covered": ["Sub-areas searched"],
    "verticals_represented": ["Micro-verticals found"]
  }
}`;

  // Inject pain map context if available
  let painContext = '';
  if (painData && painData.pain_map) {
    painContext = '\n\n=== PAIN MAP (use to evaluate and score prospects) ===\n' +
      painData.pain_map.map((p, i) => '  ' + (i+1) + '. "' + p.pain + '" (' + p.severity + ') — felt by ' + p.who_feels_it).join('\n') +
      '\nIDEAL PROFILE: Size ' + ((painData.ideal_prospect_profile||{}).company_size||'?') +
      ', Tech ' + ((painData.ideal_prospect_profile||{}).tech_maturity||'mixed') +
      '\nDISQUALIFIERS: ' + ((painData.ideal_prospect_profile||{}).disqualifiers||[]).join(', ') +
      '\nSEARCH HINTS: ' + (painData.search_terms||[]).join(', ');
  }

  // Build dynamic qualification criteria from solution data
  const targetMarket = solutionData.targetMarket || 'SMBs needing this solution';
  const capabilities = (solutionData.capabilities || []).join(', ');
  const microVerticals = (verticalData.micro_verticals || []).map(m => `  - ${m}`).join('\n');

  const userPrompt = `Find ${accountVolume} real companies for this prospecting campaign:

SOLUTION: ${solutionData.name}
Type: ${solutionData.type || ''}
Description: ${solutionData.description || ''}
Capabilities: ${capabilities}
Target Market: ${targetMarket}

TARGET VERTICAL: ${verticalData.selected_vertical}
Structural Fit: ${verticalData.structural_fit || ''}
Pain Density: ${verticalData.pain_density || ''}
Micro-Verticals:
${microVerticals || '  - Use vertical selection to identify sub-segments'}

TARGET METRO: ${metroData.selected_metro}
Key Corridors: ${(metroData.key_business_corridors || []).map(c => c.corridor).join(', ')}

SCORING RUBRIC (0-100):
  90-100: Multiple active switching triggers + size match + no incumbent
  80-89: Strong size match + at least one clear switching trigger
  70-79: Size match, switching triggers inferred but not confirmed
  60-69: Partial fit — matches vertical but borderline
  Below 60: Marginal — include only if pickings are thin

${painContext}

Find ${accountVolume} specific, real companies in or near ${metroData.selected_metro} that operate in the ${verticalData.selected_vertical} vertical. Use web search to verify each company is real. Return valid JSON.`;

  console.log(`[Account Prospector] Finding ${accountVolume} prospects in ${metroData.selected_metro}...`);
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.4, { webSearch: true, maxTokens: 8000 });
  const prospects = result.prospects || [];
  console.log(`[Account Prospector] Found ${prospects.length} prospects (${prospects.filter(p => p.priority_class === 'high').length} high priority)`);
  return result;
}

// --- PROSPECTOR ORCHESTRATOR ENDPOINT ---
app.post('/api/prospector/run', async (req, res) => {
  try {
    const { solutionData, targetVertical, geoSeed, accountVolume } = req.body;
    if (!solutionData) return res.status(400).json({ error: 'solutionData is required' });

    const volume = Math.min(Math.max(accountVolume || 10, 1), 50);

    console.log(`[Prospector] Starting pipeline: vertical=${targetVertical || 'auto'}, geo=${geoSeed || 'auto'}, volume=${volume}`);

    // Stage 1: Select best vertical
    const verticalData = await runVerticalSelector(solutionData, targetVertical || '');

    // Stage 2: Map specific pains for this solution x vertical
    const painData = await runPainMapper(solutionData, verticalData);

    // Stage 3: Select best metro
    const metroData = await runMetroCartographer(solutionData, verticalData, geoSeed || '');

    // Stage 4: Find real companies (pain-informed)
    const prospectData = await runAccountProspector(solutionData, verticalData, metroData, volume, painData);

    res.json({
      vertical: verticalData,
      painMap: painData,
      metro: metroData,
      prospects: prospectData.prospects || [],
      search_summary: prospectData.search_summary || {},
    });

  } catch (error) {
    console.error('[Prospector] Pipeline error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- SSE STREAMING VERSION (for real-time progress) ---
app.get('/api/prospector/stream', async (req, res) => {
  const { targetVertical, geoSeed, accountVolume } = req.query;

  // We need solutionData from the client's state — they must have run the solution agent already
  // So we accept it as a query param (base64-encoded JSON) or they call POST instead
  // For SSE, we'll use the simpler approach: client already has solutionData and POSTs it

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    // This is a simplified SSE — for the full POST-based streaming, see /api/prospector/run
    send({ stage: 'error', detail: 'Use POST /api/prospector/run with solutionData in body' });
  } catch (e) {
    send({ stage: 'error', detail: e.message });
  }
  res.end();
});

// --- BRAIN TRUST PROSPECTOR (advisory panel mode) ---
app.post('/api/prospector/braintrust', async (req, res) => {
  try {
    const { solutionData, targetVertical, geoSeed, accountVolume } = req.body;
    if (!solutionData) return res.status(400).json({ error: 'solutionData is required' });
    const volume = Math.min(Math.max(accountVolume || 10, 1), 50);

    console.log('[Brain Trust Prospector] Starting panel-driven pipeline');

    // Stage 1: Brain Trust Vertical Selection
    const verticalPanel = await runBrainTrustVertical(solutionData, targetVertical || '');
    const verticalConsensus = verticalPanel.consensus || {};

    // Stage 2: Brain Trust Pain Mapping
    const painPanel = await runBrainTrustPainMapper(solutionData, verticalConsensus);
    const painConsensus = painPanel.consensus || {};

    // Stage 3: Brain Trust Metro Selection
    const metroPanel = await runBrainTrustMetro(solutionData, verticalConsensus, geoSeed || '');
    const metroConsensus = metroPanel.consensus || {};

    // Stage 4: Account Prospector (still single agent — it's executing, not advising)
    const prospectData = await runAccountProspector(solutionData, verticalConsensus, metroConsensus, volume, painConsensus);

    res.json({
      mode: 'braintrust',
      vertical: verticalConsensus,
      verticalPanel: { discussion: verticalPanel.panel_discussion, advisors: verticalPanel.advisor_contributions },
      painMap: painConsensus,
      painPanel: { discussion: painPanel.panel_discussion, advisors: painPanel.advisor_contributions },
      metro: metroConsensus,
      metroPanel: { discussion: metroPanel.panel_discussion, advisors: metroPanel.advisor_contributions },
      prospects: prospectData.prospects || [],
      search_summary: prospectData.search_summary || {},
    });

  } catch (error) {
    console.error('[Brain Trust Prospector] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// ===== DEMO EMAIL THREAD GENERATOR =====
app.post('/api/generate-demo-thread', async (req, res) => {
  try {
    const { companyName, pain_context } = req.body;
    if (!companyName) return res.status(400).json({ error: 'companyName required' });

    const painInfo = pain_context || {};
    const messages = [
      {
        role: 'system',
        content: `You generate realistic email threads for sales demo purposes.
Create a realistic 4-6 email back-and-forth thread between a sales rep and a prospect at the given company.
The thread should feel natural — include some positive signals, some hesitations, mentions of budget/timeline concerns, and a competitor reference.
Format it exactly like a forwarded email thread (newest first), with From/To/Date/Subject headers for each email.
Use realistic names and titles. Make it 400-800 words total.`
      },
      {
        role: 'user',
        content: `Generate a demo email thread for: ${companyName}
${painInfo.primaryLead ? 'Contact: ' + painInfo.primaryLead.title + ' — ' + (painInfo.primaryLead.topic || '') : ''}
${painInfo.painIndicators ? 'Known pain points: ' + (painInfo.painIndicators.map(p => typeof p === 'string' ? p : p.label).join(', ')) : ''}
${painInfo.whoIsThis ? 'Company context: ' + painInfo.whoIsThis : ''}

Make the thread realistic — the prospect should show some interest but also raise typical objections (timing, budget, competitor evaluation). Include 4-6 emails.`
      }
    ];

    const thread = await callOpenRouter(MODELS.painpoints, messages, 0.7);
    res.json({ thread });
  } catch (error) {
    console.error('[Demo Thread] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// ===== CONTACT INTELLIGENCE — Apollo + CPP + Draft =========================
// ============================================================================

const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';

function extractDomain(url) {
  return (url || '').toLowerCase()
    .replace(/https?:\/\//, '').replace(/www\./, '').split('/')[0].trim();
}

// POST /api/contact/lookup
// Gets all available contacts from Apollo then uses AI to pick the best one
// based on the solution being sold and the company's profile.
// Never relies on a pre-defined title list — always AI-selected.
app.post('/api/contact/lookup', async (req, res) => {
  const { customer_url, solution_context, company_context } = req.body;
  if (!customer_url) return res.status(400).json({ error: 'customer_url required' });
  if (!APOLLO_API_KEY) return res.status(503).json({ error: 'APOLLO_API_KEY not configured' });

  const domain = extractDomain(customer_url);
  console.log(`[ContactLookup] domain=${domain}`);

  try {
    // Pull up to 25 contacts — no title filter, let AI decide
    const r = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
      api_key: APOLLO_API_KEY,
      q_organization_domains: domain,
      per_page: 25, page: 1
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });

    let people = r.data?.people || [];

    if (!people.length) {
      console.log(`[ContactLookup] No contacts found for ${domain}`);
      return res.json({ found: false, reason: 'No contacts found in Apollo for this domain' });
    }

    console.log(`[ContactLookup] Apollo returned ${people.length} contacts — asking AI to pick best`);

    // Build a concise people list for the AI
    const peopleList = people.map((p, i) => ({
      idx: i,
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      title: p.title || 'Unknown',
      seniority: p.seniority || '',
      has_email: ['verified','likely'].includes(p.email_status)
    }));

    const systemPrompt = `You are a B2B sales intelligence expert. Given a list of people at a company and the context of what is being sold, identify the single best person to contact for a first outreach.

Consider:
- Who has budget authority or technical decision-making power for this type of solution
- Seniority and relevance of their role to the problem being solved
- Prefer someone with a verified email if relevant roles are tied

Return ONLY valid JSON: { "idx": <number>, "reasoning": "<one sentence why this person>" }`;

    const userPrompt = `We are selling: ${solution_context || 'a B2B software solution'}
Company profile: ${company_context || 'a business company'}

People available at this company:
${peopleList.map(p => `[${p.idx}] ${p.name} — ${p.title}${p.seniority ? ' (' + p.seniority + ')' : ''}${p.has_email ? ' ✓email' : ''}`).join('\n')}

Who is the single best person to contact first? Return JSON with idx and one-sentence reasoning.`;

    let bestIdx = 0;
    let reasoning = '';
    try {
      const aiResp = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.1, { maxTokens: 150 });
      bestIdx = typeof aiResp.idx === 'number' ? aiResp.idx : 0;
      reasoning = aiResp.reasoning || '';
      // Bounds check
      if (bestIdx < 0 || bestIdx >= people.length) bestIdx = 0;
    } catch (aiErr) {
      console.log(`[ContactLookup] AI selection failed, using first result: ${aiErr.message}`);
      bestIdx = 0;
    }

    const best = people[bestIdx];
    const email = ['verified','likely'].includes(best.email_status) ? (best.email || '') : '';

    console.log(`[ContactLookup] AI selected: ${best.first_name} ${best.last_name} | ${best.title} | reasoning: ${reasoning}`);

    res.json({
      found: true,
      name: `${best.first_name || ''} ${best.last_name || ''}`.trim(),
      first_name: best.first_name || '',
      last_name: best.last_name || '',
      title: best.title || '',
      email,
      email_status: best.email_status || 'unknown',
      linkedin_url: best.linkedin_url || '',
      source: 'apollo',
      ai_reasoning: reasoning,
      candidates_reviewed: people.length
    });

  } catch (err) {
    console.error('[ContactLookup] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contact/cpp
app.post('/api/contact/cpp', async (req, res) => {
  const { contact_name, contact_title, company_name, linkedin_url } = req.body;
  if (!contact_name) return res.status(400).json({ error: 'contact_name required' });

  console.log(`[ContactCPP] ${contact_name} | ${contact_title} | ${company_name}`);

  // Firecrawl LinkedIn interact — richer than web search alone
  let linkedinScraped = '';
  if (linkedin_url && fcAvailable()) {
    linkedinScraped = await fcInteractLinkedIn(linkedin_url) || '';
    if (linkedinScraped) console.log(`[ContactCPP] LinkedIn scraped: ${linkedinScraped.length} chars`);
  }

  const linkedinHint = (linkedin_url && !linkedinScraped) ? `\nLinkedIn URL: ${linkedin_url}` : '';

  const systemPrompt = `You are a Communication Intelligence Analyst building a first-outreach CPP for a B2B sales rep.
Search the web for this person public digital footprint: LinkedIn, company bio, conference bios, articles, press.
Return ONLY valid JSON:
{
  "contact_name": "name",
  "title": "title",
  "company": "company",
  "headline": "linkedin headline if found",
  "confidence": "high | medium | low | none",
  "sources_found": [],
  "dimensions": {
    "directness": { "score": 5, "label": "direct | balanced | diplomatic", "justification": "", "signal": "" },
    "formality": { "score": 5, "label": "formal | professional | conversational | casual", "justification": "", "signal": "" },
    "decision_style": { "score": 5, "label": "analytical | intuitive | relationship-driven | process-driven", "justification": "", "signal": "" },
    "persuasion_receptivity": { "score": 5, "label": "data/ROI | social proof | authority | narrative | relationship", "justification": "", "signal": "" },
    "risk_tolerance": { "score": 5, "label": "conservative | moderate | aggressive", "justification": "", "signal": "" },
    "emotional_expressiveness": { "score": 5, "label": "stoic | measured | expressive | passionate", "justification": "", "signal": "" }
  },
  "signature_language": [],
  "rep_guidance": {
    "opening_tone": "",
    "what_to_lead_with": "",
    "what_to_avoid": "",
    "subject_line_style": "",
    "one_sentence_briefing": ""
  },
  "insufficient_data_flags": []
}
Never score above 4 on pure inference. No public footprint is itself signal.`;

  const scrapedBlock = linkedinScraped
    ? `\n\nSCRAPED LINKEDIN PROFILE (highest-quality signal):\n${linkedinScraped}`
    : '';

  const userPrompt = `Build a first-outreach CPP for:
Name: ${contact_name}
Title: ${contact_title || 'Unknown'}
Company: ${company_name || 'Unknown'}${linkedinHint}
${scrapedBlock}

${linkedinScraped
  ? 'Scraped LinkedIn above is your primary source. Use web search for additional content: company bio, conference bios, articles.'
  : 'Search the web for their public digital footprint. Focus on HOW to approach them cold.'
}`;

  try {
    const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 2000 });
    res.json(result);
  } catch (err) {
    console.error('[ContactCPP] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contact/draft
app.post('/api/contact/draft', async (req, res) => {
  const { contact_name, contact_title, company_name, contact_email, cpp, pain_context } = req.body;
  if (!contact_name) return res.status(400).json({ error: 'contact_name required' });

  console.log(`[ContactDraft] ${contact_name} | cpp_confidence=${cpp?.confidence || 'none'}`);

  const dims = cpp?.dimensions || {};
  const guidance = cpp?.rep_guidance || {};
  const confidence = cpp?.confidence || 'none';

  let cppBlock = '';
  if (!['none','low'].includes(confidence) && Object.keys(dims).length) {
    const lines = [`CPP for ${contact_name} (${confidence} confidence):`];
    const d = dims.directness?.score || 5;
    if (d >= 7) lines.push('- DIRECTNESS: High — lead with the problem in sentence one, no warm-up.');
    else if (d <= 4) lines.push('- DIRECTNESS: Low — two sentences of context before the pitch.');
    else lines.push('- DIRECTNESS: Balanced — brief setup then the point.');
    const f = dims.formality?.score || 5;
    if (f >= 7) lines.push('- FORMALITY: High — professional vocabulary, no contractions.');
    else if (f <= 3) lines.push('- FORMALITY: Low — conversational, peer-to-peer tone.');
    else lines.push('- FORMALITY: Professional standard tone.');
    const ds = dims.decision_style?.label || '';
    if (ds.includes('analytical')) lines.push('- DECISION STYLE: Analytical — include a specific metric or data point.');
    else if (ds.includes('relationship')) lines.push('- DECISION STYLE: Relationship-driven — lead with shared context.');
    const ps = dims.persuasion_receptivity?.label || '';
    if (ps.toLowerCase().includes('roi') || ps.includes('data')) lines.push('- PERSUASION: Lead with ROI or cost impact.');
    else if (ps.includes('social')) lines.push('- PERSUASION: Reference peer companies or outcomes.');
    else if (ps.includes('narrative')) lines.push('- PERSUASION: Tell a short story — situation, problem, resolution.');
    if (guidance.what_to_avoid) lines.push(`- AVOID: ${guidance.what_to_avoid}`);
    if (guidance.subject_line_style) lines.push(`- SUBJECT LINE: ${guidance.subject_line_style}`);
    if (guidance.what_to_lead_with) lines.push(`- LEAD WITH: ${guidance.what_to_lead_with}`);
    const sig = cpp?.signature_language || [];
    if (sig.length) lines.push(`- MIRROR THEIR LANGUAGE: ${sig.slice(0,4).join(', ')}`);
    cppBlock = lines.join('\n');
  } else {
    cppBlock = 'No CPP available. Write a professional, direct outreach email.';
  }

  const pc = pain_context || {};

  const systemPrompt = `You are an elite B2B sales email writer. Write a cold outreach email under 150 words.
Open with one specific observation about their business. Lead with what it means for THEM. One low-commitment ask.
Never use: "I hope this finds you well", "I wanted to reach out", "synergy", "exciting opportunity".
Follow CPP instructions precisely.
Return ONLY valid JSON: { "subject_line": "...", "body": "...", "ps_hook": "..." }`;

  const userPrompt = `Write a cold outreach email.
RECIPIENT: ${contact_name}, ${contact_title || 'unknown title'} at ${company_name || 'their company'}
CPP INSTRUCTIONS:\n${cppBlock}
COMPANY CONTEXT: ${pc.whoIsThis || ''}
${pc.primaryLead ? 'Topic: ' + (pc.primaryLead.topic || '') : ''}
${(pc.painIndicators || []).length ? 'Pain points: ' + pc.painIndicators.map(p => p.label || p).join(', ') : ''}
Return only valid JSON.`;

  try {
    const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.4, { maxTokens: 800 });
    res.json({
      contact_name, contact_title, company_name,
      contact_email: contact_email || '',
      cpp_applied: !['none','low'].includes(confidence),
      draft: result
    });
  } catch (err) {
    console.error('[ContactDraft] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================================
// ===== PROSPEO + FIRECRAWL LEADERSHIP — Two-Layer Hydration ================
// ============================================================================
// Layer 1: Firecrawl scrapes company sites for leadership + tech signals
// Layer 2: Prospeo discovers new companies + provides verified contacts
// ============================================================================

const PROSPEO_API_KEY = process.env.PROSPEO_API_KEY || '';
const PROSPEO_BASE = 'https://api.prospeo.io';

function prospeoAvailable() { return !!PROSPEO_API_KEY; }

async function prospeoPost(endpoint, body) {
  const r = await axios.post(`${PROSPEO_BASE}/${endpoint}`, body, {
    headers: { 'Content-Type': 'application/json', 'X-KEY': PROSPEO_API_KEY },
    timeout: 20000
  });
  return r.data;
}

// ── Layer 1: Firecrawl Leadership Scraper ──────────────────────────────────

// POST /api/agent/leadership-scrape
// Scrapes a company website for leadership names, titles, and org signals.
// No Prospeo credits spent — purely Firecrawl + LLM.
app.post('/api/agent/leadership-scrape', async (req, res) => {
  try {
    const { companyName, website } = req.body;
    if (!website) return res.json({ found: false, leaders: [], reason: 'no website' });

    const domain = (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    console.log(`[Leadership] Scraping ${companyName} (${domain})`);

    const pagePaths = ['', '/ueber-uns', '/about', '/about-us', '/team', '/management',
      '/unternehmen', '/impressum', '/karriere', '/company', '/leadership'];
    let combined = '';

    if (fcAvailable()) {
      for (const p of pagePaths) {
        if (combined.length > 15000) break;
        const md = await fcScrape('https://' + domain + p);
        if (md) combined += '\n---PAGE: ' + p + '---\n' + md;
      }
    } else {
      for (const p of pagePaths) {
        if (combined.length > 15000) break;
        try {
          const r = await axios.get('https://' + domain + p, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydration/1.0)' },
            timeout: 8000, maxRedirects: 3
          });
          if (r.data && typeof r.data === 'string') combined += '\n---PAGE: ' + p + '---\n' + r.data.substring(0, 5000);
        } catch (e) { /* skip */ }
      }
    }

    if (!combined || combined.length < 100) {
      console.log(`[Leadership] ${companyName}: No usable content scraped`);
      return res.json({ found: false, leaders: [], reason: 'no content scraped' });
    }

    const systemPrompt = `You are a B2B sales intelligence analyst. Extract leadership information from company website content.

Return ONLY valid JSON:
{
  "leaders": [
    {
      "name": "Full Name",
      "title": "Job Title (keep original language, also provide English translation if German)",
      "title_en": "English translation of title",
      "department": "executive|finance|operations|it|sales|hr|production|other",
      "seniority": "c-suite|director|manager|head|other",
      "email": "if visible on page, otherwise null",
      "phone": "if visible on page, otherwise null",
      "source_page": "which page path this was found on"
    }
  ],
  "company_signals": {
    "employee_estimate": "estimated headcount if mentioned",
    "erp_mentions": ["any ERP/software systems mentioned on the site"],
    "certifications": ["ISO, DIN, etc. if mentioned"],
    "locations": ["cities/addresses mentioned"],
    "products_summary": "1-sentence summary of what they make/do"
  }
}

Rules:
- Extract EVERY person whose name + title appears on the site
- If the Impressum lists a Geschäftsführer, include them
- If career/jobs pages mention departments, note them in company_signals
- Do NOT invent people — only extract what's actually on the pages
- Return empty arrays if no leaders found`;

    const userPrompt = `Extract all leadership and company signals from this website content for: ${companyName}

WEBSITE CONTENT:
${combined.substring(0, 12000)}`;

    const response = await callOpenRouter(MODELS.prequalify, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], 0.1, { maxTokens: 2000 });

    let result;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      result = JSON.parse(jsonString.trim());
    } catch {
      result = { leaders: [], company_signals: {} };
    }

    const leaderCount = (result.leaders || []).length;
    console.log(`[Leadership] ${companyName}: Found ${leaderCount} leaders via Firecrawl`);

    res.json({
      found: leaderCount > 0,
      leaders: result.leaders || [],
      company_signals: result.company_signals || {},
      source: 'firecrawl',
      pages_scraped: pagePaths.filter(p => combined.includes('---PAGE: ' + p + '---')).length
    });

  } catch (error) {
    console.error('[Leadership] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// ── Layer 2: Prospeo Company Discovery ─────────────────────────────────────

app.post('/api/prospeo/discover-companies', async (req, res) => {
  try {
    if (!prospeoAvailable()) return res.status(503).json({ error: 'PROSPEO_API_KEY not configured' });

    const { industries, location, headcountRanges, technologies, keywords,
            seniorities, departments, page, maxPages } = req.body;

    const filters = {};
    if (industries?.length) filters.company_industry = { include: industries };
    if (location) filters.company_location_search = { include: Array.isArray(location) ? location : [location] };
    if (headcountRanges?.length) filters.company_headcount_range = headcountRanges;
    if (technologies?.include?.length || technologies?.exclude?.length) {
      filters.company_technology = {};
      if (technologies.include?.length) filters.company_technology.include = technologies.include;
      if (technologies.exclude?.length) filters.company_technology.exclude = technologies.exclude;
    }
    if (keywords?.length) filters.company_keywords = { include: keywords };
    if (seniorities?.length) filters.person_seniority = { include: seniorities };
    if (departments?.length) filters.person_department = { include: departments };

    console.log(`[Prospeo:Discover] Searching with filters:`, JSON.stringify(filters).substring(0, 300));

    const startPage = page || 1;
    const pagesToFetch = Math.min(maxPages || 1, 10);
    const allResults = [];
    let totalCount = 0;
    let totalPages = 0;

    for (let p = startPage; p < startPage + pagesToFetch; p++) {
      const data = await prospeoPost('search-person', { page: p, filters });
      if (data.error) {
        if (data.error_code === 'NO_RESULTS') break;
        return res.status(400).json({ error: data.error_code, detail: data.filter_error || 'Prospeo search failed' });
      }
      totalCount = data.pagination?.total_count || 0;
      totalPages = data.pagination?.total_page || 0;
      for (const r of (data.results || [])) {
        allResults.push({
          person_id: r.person?.person_id,
          person_name: r.person?.full_name,
          person_title: r.person?.current_job_title,
          person_headline: r.person?.headline,
          person_linkedin: r.person?.linkedin_url,
          person_location: r.person?.location,
          person_seniority: r.person?.job_history?.[0]?.seniority,
          has_verified_email: r.person?.email?.status === 'VERIFIED',
          has_verified_mobile: r.person?.mobile?.status === 'VERIFIED',
          company_id: r.company?.company_id,
          company_name: r.company?.name,
          company_website: r.company?.website,
          company_domain: r.company?.domain,
          company_industry: r.company?.industry,
          company_description: r.company?.description_ai || r.company?.description_seo || '',
          company_employee_count: r.company?.employee_count,
          company_employee_range: r.company?.employee_range,
          company_location: r.company?.location,
          company_revenue_range: r.company?.revenue_range_printed,
          company_founded: r.company?.founded,
          company_type: r.company?.type,
          company_linkedin: r.company?.linkedin_url,
          company_phone_hq: r.company?.phone_hq?.phone_hq_international,
          company_tech_count: r.company?.technology?.count || 0,
          company_tech_names: r.company?.technology?.technology_names || [],
          company_keywords: r.company?.keywords || [],
          company_is_b2b: r.company?.attributes?.is_b2b,
          company_job_postings: r.company?.job_postings?.active_count || 0,
          company_job_titles: r.company?.job_postings?.active_titles || [],
          company_mx_provider: r.company?.email_tech?.mx_provider,
          company_logo: r.company?.logo_url,
          company_sic: r.company?.sic_codes || [],
          company_naics: r.company?.naics_codes || []
        });
      }
      if (p >= totalPages) break;
    }

    console.log(`[Prospeo:Discover] Got ${allResults.length} results (${totalCount} total across ${totalPages} pages)`);
    res.json({
      results: allResults,
      pagination: { fetched: allResults.length, total_count: totalCount, total_pages: totalPages },
      credits_used: Math.min(pagesToFetch, totalPages - startPage + 1)
    });
  } catch (error) {
    console.error('[Prospeo:Discover] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/prospeo/enrich-contact', async (req, res) => {
  try {
    if (!prospeoAvailable()) return res.status(503).json({ error: 'PROSPEO_API_KEY not configured' });
    const { person_id, first_name, last_name, full_name, company_website,
            company_name, linkedin_url, only_verified_email } = req.body;
    const body = { only_verified_email: only_verified_email !== false, enrich_mobile: true, data: {} };
    if (person_id) { body.data.person_id = person_id; }
    else if (linkedin_url) { body.data.linkedin_url = linkedin_url; }
    else if ((first_name && last_name) || full_name) {
      if (full_name && !first_name) { body.data.full_name = full_name; }
      else { body.data.first_name = first_name; body.data.last_name = last_name; }
      if (company_website) body.data.company_website = company_website;
      if (company_name) body.data.company_name = company_name;
    } else { return res.status(400).json({ error: 'Need person_id, linkedin_url, or name + company' }); }

    console.log(`[Prospeo:Enrich] Enriching: ${JSON.stringify(body.data).substring(0, 200)}`);
    const data = await prospeoPost('enrich-person', body);
    if (data.error) { return res.json({ found: false, error_code: data.error_code, source: 'prospeo' }); }
    const person = data.person || {};
    const company = data.company || {};
    console.log(`[Prospeo:Enrich] Found: ${person.full_name} | ${person.email?.email || 'no email'}`);
    res.json({
      found: true, source: 'prospeo', free_enrichment: data.free_enrichment || false,
      name: person.full_name, first_name: person.first_name, last_name: person.last_name,
      title: person.current_job_title, headline: person.headline, linkedin_url: person.linkedin_url,
      location: person.location,
      email: person.email?.revealed ? person.email.email : null, email_status: person.email?.status,
      email_verified: person.email?.status === 'VERIFIED' && person.email?.revealed,
      mobile: person.mobile?.revealed ? person.mobile.mobile : null, mobile_status: person.mobile?.status,
      mobile_verified: person.mobile?.status === 'VERIFIED' && person.mobile?.revealed,
      company_name: company.name, company_website: company.website,
      company_industry: company.industry, company_employee_count: company.employee_count,
      company_tech: company.technology?.technology_names || []
    });
  } catch (error) {
    console.error('[Prospeo:Enrich] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/prospeo/bulk-enrich', async (req, res) => {
  try {
    if (!prospeoAvailable()) return res.status(503).json({ error: 'PROSPEO_API_KEY not configured' });
    const { contacts } = req.body;
    if (!contacts?.length) return res.status(400).json({ error: 'contacts array required' });
    const batch = contacts.slice(0, 50).map((c, i) => ({
      identifier: c.identifier || String(i + 1),
      ...(c.person_id ? { person_id: c.person_id } : {}),
      ...(c.linkedin_url ? { linkedin_url: c.linkedin_url } : {}),
      ...(c.full_name ? { full_name: c.full_name } : {}),
      ...(c.first_name ? { first_name: c.first_name } : {}),
      ...(c.last_name ? { last_name: c.last_name } : {}),
      ...(c.company_website ? { company_website: c.company_website } : {}),
      ...(c.company_name ? { company_name: c.company_name } : {}),
      ...(c.email ? { email: c.email } : {})
    }));
    console.log(`[Prospeo:BulkEnrich] Enriching ${batch.length} contacts`);
    const data = await prospeoPost('bulk-enrich-person', { only_verified_email: true, enrich_mobile: true, data: batch });
    if (data.error) { return res.status(400).json({ error: data.error_code, detail: data }); }
    const results = (data.results || []).map(r => ({
      identifier: r.identifier, found: !r.error,
      name: r.person?.full_name, title: r.person?.current_job_title,
      email: r.person?.email?.revealed ? r.person.email.email : null, email_status: r.person?.email?.status,
      mobile: r.person?.mobile?.revealed ? r.person.mobile.mobile : null, mobile_status: r.person?.mobile?.status,
      linkedin_url: r.person?.linkedin_url, company_name: r.company?.name
    }));
    const enriched = results.filter(r => r.found).length;
    console.log(`[Prospeo:BulkEnrich] ${enriched}/${batch.length} enriched successfully`);
    res.json({ results, enriched_count: enriched, invalid: data.invalid_datapoints || [], source: 'prospeo' });
  } catch (error) {
    console.error('[Prospeo:BulkEnrich] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/prospeo/search-suggestions', async (req, res) => {
  try {
    if (!prospeoAvailable()) return res.status(503).json({ error: 'PROSPEO_API_KEY not configured' });
    const { location_search, job_title_search } = req.body;
    const data = await prospeoPost('search-suggestions', location_search ? { location_search } : { job_title_search });
    res.json(data);
  } catch (error) {
    console.error('[Prospeo:Suggestions] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/prospeo/account-info', async (req, res) => {
  try {
    if (!prospeoAvailable()) return res.status(503).json({ error: 'PROSPEO_API_KEY not configured' });
    const data = await prospeoPost('account-information', {});
    res.json(data.response || data);
  } catch (error) {
    console.error('[Prospeo:AccountInfo] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// ── Cascade Contact Lookup: Firecrawl → Prospeo → Apollo ───────────────────

app.post('/api/contact/smart-lookup', async (req, res) => {
  try {
    const { companyName, website, solution_context, company_context,
            prefer_department, prefer_seniority } = req.body;
    if (!companyName && !website) return res.status(400).json({ error: 'companyName or website required' });

    const domain = extractDomain(website || '');
    const steps = [];
    let bestContact = null;

    // ── Step 1: Firecrawl Leadership Scrape (FREE) ──
    if (website) {
      console.log(`[SmartLookup] Step 1: Firecrawl leadership scrape for ${companyName}`);
      try {
        const lRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/agent/leadership-scrape`, {
          companyName, website
        }, { timeout: 60000 });
        const lData = lRes.data;
        if (lData.found && lData.leaders?.length) {
          steps.push({ source: 'firecrawl', found: lData.leaders.length, status: 'success' });
          const preferDept = prefer_department || 'it|operations|executive';
          const preferSen = prefer_seniority || 'c-suite|director|head';
          let scored = lData.leaders.map(l => {
            let score = 0;
            const dept = (l.department || '').toLowerCase();
            const sen = (l.seniority || '').toLowerCase();
            const title = (l.title_en || l.title || '').toLowerCase();
            if (preferDept.split('|').some(d => dept.includes(d) || title.includes(d))) score += 10;
            if (preferSen.split('|').some(s => sen.includes(s))) score += 10;
            if (title.match(/geschäftsführ|managing director|ceo|cto|cio|cfo|inhaber|owner/i)) score += 15;
            if (title.match(/leiter|head of|director|vp|vice president/i)) score += 8;
            if (l.email) score += 5;
            return { ...l, _score: score };
          });
          scored.sort((a, b) => b._score - a._score);
          const topLeader = scored[0];
          bestContact = {
            source: 'firecrawl', name: topLeader.name, title: topLeader.title,
            title_en: topLeader.title_en, email: topLeader.email || null,
            phone: topLeader.phone || null, linkedin_url: null, email_verified: false,
            department: topLeader.department, seniority: topLeader.seniority,
            ai_reasoning: `Best match from ${lData.leaders.length} leaders found on website (score: ${topLeader._score})`,
            company_signals: lData.company_signals
          };
          if (bestContact.email) {
            console.log(`[SmartLookup] Firecrawl found: ${bestContact.name} with email — done`);
            return res.json({ ...bestContact, steps, cascade_stopped: 'firecrawl_with_email' });
          }
          console.log(`[SmartLookup] Firecrawl found: ${bestContact.name} (no email) — continuing to Prospeo`);
        } else {
          steps.push({ source: 'firecrawl', found: 0, status: 'no_leaders' });
        }
      } catch (e) {
        steps.push({ source: 'firecrawl', found: 0, status: 'error', detail: e.message });
      }
    }

    // ── Step 2: Prospeo Enrichment (verified contacts) ──
    if (prospeoAvailable()) {
      console.log(`[SmartLookup] Step 2: Prospeo enrichment for ${companyName}`);
      try {
        let prospeoBody = {};
        if (bestContact?.name) {
          const nameParts = bestContact.name.trim().split(/\s+/);
          prospeoBody = { first_name: nameParts[0], last_name: nameParts.slice(1).join(' '), company_website: domain };
        } else if (domain) {
          const searchRes = await prospeoPost('search-person', {
            page: 1, filters: {
              company: { websites: { include: [domain] } },
              person_seniority: { include: ['C-Suite', 'Director'] },
              max_person_per_company: 3
            }
          });
          if (!searchRes.error && searchRes.results?.length) {
            const topPerson = searchRes.results[0].person;
            steps.push({ source: 'prospeo_search', found: searchRes.results.length, status: 'success' });
            prospeoBody = { person_id: topPerson.person_id };
            bestContact = { source: 'prospeo', name: topPerson.full_name, title: topPerson.current_job_title,
              linkedin_url: topPerson.linkedin_url, seniority: topPerson.job_history?.[0]?.seniority };
          } else {
            steps.push({ source: 'prospeo_search', found: 0, status: searchRes.error_code || 'no_results' });
          }
        }
        if (Object.keys(prospeoBody).length) {
          const enrichRes = await prospeoPost('enrich-person', { only_verified_email: true, enrich_mobile: true, data: prospeoBody });
          if (!enrichRes.error && enrichRes.person) {
            const p = enrichRes.person;
            steps.push({ source: 'prospeo_enrich', status: 'success' });
            bestContact = {
              source: 'prospeo', name: p.full_name, first_name: p.first_name, last_name: p.last_name,
              title: p.current_job_title,
              email: p.email?.revealed ? p.email.email : null, email_status: p.email?.status,
              email_verified: p.email?.status === 'VERIFIED' && p.email?.revealed,
              mobile: p.mobile?.revealed ? p.mobile.mobile : null,
              mobile_verified: p.mobile?.status === 'VERIFIED' && p.mobile?.revealed,
              linkedin_url: p.linkedin_url, seniority: p.job_history?.[0]?.seniority,
              ai_reasoning: `Prospeo verified contact for ${companyName}`
            };
            if (bestContact.email) {
              console.log(`[SmartLookup] Prospeo found: ${bestContact.name} | ${bestContact.email} — done`);
              return res.json({ ...bestContact, steps, cascade_stopped: 'prospeo' });
            }
          } else {
            steps.push({ source: 'prospeo_enrich', status: enrichRes.error_code || 'no_match' });
          }
        }
      } catch (e) {
        steps.push({ source: 'prospeo', status: 'error', detail: e.message });
      }
    }

    // ── Step 3: Apollo Fallback ──
    if (APOLLO_API_KEY && domain) {
      console.log(`[SmartLookup] Step 3: Apollo fallback for ${domain}`);
      try {
        const r = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
          api_key: APOLLO_API_KEY, q_organization_domains: domain, per_page: 10, page: 1
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        const people = r.data?.people || [];
        if (people.length) {
          steps.push({ source: 'apollo', found: people.length, status: 'success' });
          const best = people[0];
          bestContact = {
            source: 'apollo', name: `${best.first_name || ''} ${best.last_name || ''}`.trim(),
            title: best.title || '',
            email: ['verified', 'likely'].includes(best.email_status) ? (best.email || '') : null,
            email_status: best.email_status, linkedin_url: best.linkedin_url || '',
            ai_reasoning: `Apollo first result of ${people.length} contacts`
          };
        } else { steps.push({ source: 'apollo', found: 0, status: 'no_results' }); }
      } catch (e) { steps.push({ source: 'apollo', status: 'error', detail: e.message }); }
    }

    if (bestContact) {
      console.log(`[SmartLookup] Final: ${bestContact.name} via ${bestContact.source}`);
      res.json({ ...bestContact, steps, cascade_stopped: bestContact.source });
    } else {
      res.json({ found: false, steps, reason: 'No contacts found across Firecrawl, Prospeo, or Apollo' });
    }
  } catch (error) {
    console.error('[SmartLookup] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    models: MODELS,
    apiKeyConfigured: !!OPENROUTER_API_KEY,
    clearSignalsConfigured: !!CLEARSIGNALS_VENDOR_KEY,
    firecrawlConfigured: fcAvailable(),
    prospeoConfigured: prospeoAvailable(),
    tdeConfigured: tdeAvailable(),
    tdeUrl: TDE_BASE_URL,
    signalScanLocales: Object.keys(LOCALE_CONFIG),
    industryCodes: ['SIC', 'NAICS', 'local']
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Lead Hydration Engine - LLM Agents               ║
╠════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║                                                            ║
║  Agent Models:                                             ║
║    Solution:    ${MODELS.solution.padEnd(40)} ║
║    Industry:    ${MODELS.industry.padEnd(40)} ║
║    Pain Points: ${MODELS.painpoints.padEnd(40)} ║
║    Customer:    ${MODELS.customer.padEnd(40)} ║
║                                                            ║
║  API Keys:                                                 ║
║    OpenRouter:   ${OPENROUTER_API_KEY ? '✓ Configured' : '✗ NOT CONFIGURED'}                        ║
║    ClearSignals: ${CLEARSIGNALS_VENDOR_KEY ? '✓ Configured' : '✗ NOT CONFIGURED'}                        ║
╚════════════════════════════════════════════════════════════╝
  `);
});
