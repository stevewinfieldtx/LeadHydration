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

// Helper function to call OpenRouter
async function callOpenRouter(model, messages, temperature = 0.3, options = {}) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');
  const maxTokens = options.maxTokens || 2000;
  const useWebSearch = options.webSearch || false;
  const requestModel = useWebSearch && !model.includes(':online') ? `${model}:online` : model;
  try {
    const response = await axios.post(OPENROUTER_BASE_URL, {
      model: requestModel, messages, temperature, max_tokens: maxTokens
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'Lead Hydration Engine'
      },
      timeout: 120000
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('OpenRouter API error:', error.response?.data || error.message);
    throw new Error(`API call failed: ${error.response?.data?.error?.message || error.message}`);
  }
}

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
      let content = raw.trim();
      if (content.startsWith('```json')) content = content.slice(7);
      else if (content.startsWith('```')) content = content.slice(3);
      if (content.endsWith('```')) content = content.slice(0, -3);
      content = content.trim();
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd > jsonStart) content = content.substring(jsonStart, jsonEnd + 1);
      content = content.replace(/,\s*([}\]])/g, '$1');
      let openBraces = 0, openBrackets = 0, inString = false, escaped = false;
      for (const ch of content) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++; if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++; if (ch === ']') openBrackets--;
      }
      if (openBrackets > 0 || openBraces > 0) {
        content = content.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '');
        for (let b = 0; b < openBrackets; b++) content += ']';
        for (let b = 0; b < openBraces; b++) content += '}';
      }
      return JSON.parse(content);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) console.log(`[JSON Parse] Attempt ${attempt + 1} failed, retrying...`);
    }
  }
  throw new Error(`Failed to parse JSON after ${maxRetries + 1} attempts: ${lastError.message}`);
}

// ===== SOLUTION AGENT =====
app.post('/api/agent/solution', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    console.log(`[Solution Agent] Researching: ${url}`);

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
          .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        console.log(`[Solution Agent] axios: ${pageContent.length} chars`);
      } catch (fetchErr) {
        console.log(`[Solution Agent] fetch failed: ${fetchErr.message}`);
      }
    }

    const messages = [
      { role: 'system', content: `You are a solution research expert. Extract key information about a product/solution.\nIf WEBSITE CONTENT is provided, that is the SOURCE OF TRUTH.\nReturn ONLY valid JSON:\n{\n  "name": "Product Name",\n  "type": "Type of solution",\n  "description": "What it actually does",\n  "capabilities": ["cap1","cap2","cap3","cap4","cap5"],\n  "targetMarket": "Who buys this",\n  "keyBenefits": ["benefit1","benefit2","benefit3"],\n  "confidence": "high if from website, low if from knowledge only"\n}` },
      { role: 'user', content: `Analyze: ${url}\n\n${pageContent ? 'WEBSITE CONTENT (SOURCE OF TRUTH):\n' + pageContent : 'NOTE: Could not fetch. Use knowledge but indicate low confidence.'}\n\nReturn ONLY valid JSON, no markdown.` }
    ];

    const response = await callOpenRouter(MODELS.solution, messages, 0.3);
    let solutionData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      solutionData = JSON.parse(jsonMatch ? jsonMatch[1] : response.trim());
    } catch (e) {
      return res.json({ name: 'Unknown Solution', type: 'Business Software', description: 'Could not parse', capabilities: [], targetMarket: 'Unknown', keyBenefits: [], raw: response });
    }
    console.log(`[Solution Agent] Completed: ${solutionData.name}`);
    res.json(solutionData);
  } catch (error) {
    console.error('[Solution Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== INDUSTRY AGENT =====
app.post('/api/agent/industry', async (req, res) => {
  try {
    const { companyName, website, address } = req.body;
    if (!companyName || !website) return res.status(400).json({ error: 'Company name and website are required' });
    console.log(`[Industry Agent] Analyzing: ${companyName}`);
    const messages = [
      { role: 'system', content: `You are an industry classification expert.\nReturn ONLY valid JSON:\n{\n  "industry": "Primary Industry Name",\n  "subIndustry": "Sub-category if applicable",\n  "confidence": "High/Medium/Low",\n  "reasoning": "Brief explanation"\n}` },
      { role: 'user', content: `Industry for: "${companyName}" (${website})${address ? ', ' + address : ''}\nReturn ONLY valid JSON.` }
    ];
    const response = await callOpenRouter(MODELS.industry, messages, 0.2);
    let industryData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      industryData = JSON.parse(jsonMatch ? jsonMatch[1] : response.trim());
    } catch (e) {
      industryData = { industry: 'Unknown', subIndustry: null, confidence: 'Low', reasoning: 'Could not parse', raw: response };
    }
    console.log(`[Industry Agent] Result: ${industryData.industry} (${industryData.confidence})`);
    res.json(industryData);
  } catch (error) {
    console.error('[Industry Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== PRE-QUALIFY AGENT =====
const DEAD_DOMAINS = ['forsaledomain.net','forsaledomain.com','parked.com','sedoparking.com','hier-im-netz.de','chayns.site','odoo.com','banggood.com'];

async function scrapeUrl(url, timeout = 8000) {
  if (!url) return { alive: false, snippet: '', resolvedDomain: null, reason: 'no_url' };
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  try {
    const resp = await axios.get(fullUrl, { timeout, maxRedirects: 5, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, validateStatus: s => s < 500, responseType: 'text' });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || fullUrl;
    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    if (DEAD_DOMAINS.some(d => host.includes(d))) return { alive: false, snippet: '', resolvedDomain: host, reason: 'parked_domain' };
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (html.length < 200) return { alive: false, snippet: '', resolvedDomain: host, reason: 'empty_page' };
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const bodyText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi,'').replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi,'').replace(/<[^>]+>/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim().slice(0,3000);
    const snippet = `TITLE: ${titleMatch ? titleMatch[1].trim() : ''}\nMETA: ${metaMatch ? metaMatch[1].trim() : ''}\nCONTENT: ${bodyText}`;
    return { alive: true, snippet, resolvedDomain: host, reason: null };
  } catch (err) { return { alive: false, snippet: '', resolvedDomain: null, reason: err.code || err.message }; }
}

async function tryDomainVariants(domain) {
  if (!domain) return null;
  const clean = domain.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/+$/,'');
  for (const prefix of ['https://','https://www.','http://','http://www.']) {
    const result = await scrapeUrl(prefix + clean, 6000);
    if (result.alive) return result;
  }
  return null;
}

async function searchForCompanyDomain(companyName, city) {
  try {
    const query = encodeURIComponent(`${companyName} ${city || ''} Germany official website`);
    const resp = await axios.get(`https://html.duckduckgo.com/html/?q=${query}`, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    const urlMatches = resp.data.match(/href="(https?:\/\/[^"]+)"/g) || [];
    const urls = urlMatches.map(m => m.replace('href="','').replace('"','')).filter(u => !u.includes('duckduckgo') && !u.includes('google') && !u.includes('bing') && !u.includes('wikipedia') && !u.includes('linkedin')).slice(0,5);
    for (const url of urls) {
      try {
        const host = new URL(url).hostname.replace(/^www\./,'');
        if (!DEAD_DOMAINS.some(d => host.includes(d))) {
          const check = await scrapeUrl(`https://${host}`, 5000);
          if (check.alive) return check;
        }
      } catch {}
    }
  } catch (err) { console.log(`  [Search] Failed for "${companyName}": ${err.message}`); }
  return null;
}

app.post('/api/agent/prequalify', async (req, res) => {
  try {
    const { companyName, website, solution, targetIndustries, employeeCount, city, country, pass, lang } = req.body;
    if (!companyName) return res.status(400).json({ error: 'companyName is required' });
    const isSecondPass = pass === 2;
    const effectiveCountry = (country || 'Germany').trim();
    const isGerman = effectiveCountry.toLowerCase().includes('german') || effectiveCountry.toLowerCase() === 'de';
    const responseLang = lang === 'en' ? 'Respond in English.' : 'Respond in German (Deutsch).';
    console.log(`[Pre-Qualify${isSecondPass ? ' P2' : ''}] Screening: ${companyName}`);
    let scrapeResult = null;
    if (website) scrapeResult = await tryDomainVariants(website);
    if (!isSecondPass && !scrapeResult?.alive && website) {
      console.log(`[Pre-Qualify] ${companyName}: URL FAILED → deferred to pass 2`);
      return res.json({ industry: 'Unknown', subIndustry: null, naicsCode: null, wzCode: null, fitScore: 0, fitReason: 'Website could not be reached — deferred to second pass', disqualifyReason: null, sizeEstimate: null, websiteAlive: false, urlFailed: true, qualified: false, failReason: scrapeResult?.reason || 'unreachable' });
    }
    if (isSecondPass && !scrapeResult?.alive) {
      scrapeResult = await searchForCompanyDomain(companyName, city);
      if (scrapeResult?.alive) console.log(`[Pre-Qualify P2] Found: ${scrapeResult.resolvedDomain}`);
    }
    const targetIndustryContext = targetIndustries?.length > 0 ? `\n\nTARGET INDUSTRIES: ${targetIndustries.join(', ')}\nCompanies NOT matching → fitScore below 40.` : '';
    const solutionContext = solution ? `\nSOLUTION: ${solution.name || 'Unknown'} (${solution.type || 'Unknown'}) | Target: ${solution.targetMarket || 'SMB'}` : '';
    const isSAPB1 = solution && (solution.name || '').toLowerCase().includes('sap');
    const sapContext = isSAPB1 ? `\n\nSAP B1 SIGNALS: Manufacturing SMB 11-250 employees = high score. Pure retail/services = low score.` : '';
    const messages = [
      { role: 'system', content: `You are a rapid lead qualification expert. Classify and score fit 0-100.\nReturn ONLY valid JSON:\n{\n  "industry": "name",\n  "subIndustry": "sub",\n  "manufacturingType": "discrete|process|project|job_shop|mixed|none",\n  "naicsCode": "code",\n  "localCode": "WZ/NACE code",\n  "localCodeSystem": "WZ",\n  "fitScore": 75,\n  "fitReason": "explanation",\n  "disqualifyReason": null,\n  "sizeEstimate": "size",\n  "erpSignals": [],\n  "websiteAlive": true\n}${sapContext}${targetIndustryContext}\n${responseLang}` },
      { role: 'user', content: `Pre-qualify:\nCOMPANY: ${companyName}\nWEBSITE: ${scrapeResult?.resolvedDomain || website || 'Unknown'}\nCOUNTRY: ${effectiveCountry}\n${city ? 'CITY: ' + city : ''}\n${employeeCount ? 'EMPLOYEES: ' + employeeCount : ''}${solutionContext}\n\n${scrapeResult?.snippet ? 'WEBSITE CONTENT:\n' + scrapeResult.snippet : 'NOTE: Could not fetch website.'}\n\nReturn ONLY valid JSON.` }
    ];
    const response = await callOpenRouter(MODELS.prequalify, messages, 0.2, { maxTokens: 800 });
    let result;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      result = JSON.parse(jsonMatch ? jsonMatch[1] : response.trim());
    } catch {
      result = { industry: 'Unknown', subIndustry: null, naicsCode: null, localCode: null, fitScore: 50, fitReason: 'Could not parse', disqualifyReason: null, sizeEstimate: null, websiteAlive: !!scrapeResult?.alive };
    }
    result.fitScore = parseInt(result.fitScore) || 50;
    result.qualified = result.fitScore >= 60;
    result.websiteAlive = !!scrapeResult?.alive;
    result.urlFailed = false;
    if (isGerman && result.localCode) result.wzCode = result.localCode;
    if (scrapeResult?.resolvedDomain && scrapeResult.resolvedDomain !== (website || '').replace(/^https?:\/\//,'').replace(/^www\./,'')) result.resolvedDomain = scrapeResult.resolvedDomain;
    console.log(`[Pre-Qualify${isSecondPass ? ' P2' : ''}] ${companyName}: ${result.fitScore}/100 — ${result.qualified ? 'QUALIFIED' : 'DISQUALIFIED'}`);
    res.json(result);
  } catch (error) {
    console.error('[Pre-Qualify] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== PAIN POINT AGENT =====
app.post('/api/agent/painpoints', async (req, res) => {
  try {
    const { industry, solution } = req.body;
    if (!industry || !solution) return res.status(400).json({ error: 'Industry and solution data are required' });
    console.log(`[Pain Point Agent] Mapping: ${industry} + ${solution.name}`);
    const messages = [
      { role: 'system', content: `You are a business analyst. Identify industry pain points.\nReturn ONLY valid JSON:\n{\n  "painPoints": [\n    {"pain": "description", "solution": "how it solves", "impact": "business impact"}\n  ]\n}\nProvide 4-6 specific pain points.` },
      { role: 'user', content: `Pain points for ${industry} + ${solution.name} (${solution.type}):\n${solution.description}\nCapabilities: ${solution.capabilities?.join(', ') || 'N/A'}\nReturn ONLY valid JSON.` }
    ];
    const response = await callOpenRouter(MODELS.painpoints, messages, 0.4);
    let painData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      painData = JSON.parse(jsonMatch ? jsonMatch[1] : response.trim());
    } catch (e) {
      painData = { painPoints: [{ pain: 'Could not parse', solution: 'N/A', impact: 'N/A' }], raw: response };
    }
    console.log(`[Pain Point Agent] Mapped ${painData.painPoints?.length || 0} pain points`);
    res.json(painData);
  } catch (error) {
    console.error('[Pain Point Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== CUSTOMER RESEARCH AGENT =====
app.post('/api/agent/customer', async (req, res) => {
  try {
    const { companyName, website, address } = req.body;
    if (!companyName || !website) return res.status(400).json({ error: 'Company name and website are required' });
    console.log(`[Customer Agent] Researching: ${companyName}`);

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
      { role: 'system', content: `You are a company research expert gathering sales intelligence.\nReturn ONLY valid JSON:\n{\n  "companyName": "Full name",\n  "industry": "Primary industry",\n  "companySize": "Estimated size",\n  "headquarters": "Location",\n  "description": "What they do",\n  "keyDecisionMakers": ["role1","role2"],\n  "potentialUseCases": ["use1","use2"],\n  "researchNotes": "Additional intelligence"\n}` },
      { role: 'user', content: `Research for sales intelligence:\nCompany: ${companyName}\nWebsite: ${website}\n${address ? 'Address: ' + address : ''}\n${fcContext ? fcContext : ''}\n${fcContext ? 'Scraped content is ground truth. Use web search to fill gaps.' : 'Search web for LinkedIn, news, reviews, job postings.'}\nReturn ONLY valid JSON.` }
    ];
    const response = await callOpenRouter(MODELS.customer, messages, 0.3);
    let customerData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      customerData = JSON.parse(jsonMatch ? jsonMatch[1] : response.trim());
    } catch (e) {
      customerData = { companyName, industry: 'Unknown', companySize: 'Unknown', headquarters: address || 'Unknown', description: 'Could not retrieve', keyDecisionMakers: [], potentialUseCases: [], researchNotes: response };
    }
    console.log(`[Customer Agent] Completed: ${customerData.companyName}`);
    res.json(customerData);
  } catch (error) {
    console.error('[Customer Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== BATCH PROCESSING =====
app.post('/api/batch/industries', async (req, res) => {
  try {
    const { companies } = req.body;
    if (!Array.isArray(companies) || companies.length === 0) return res.status(400).json({ error: 'Companies array is required' });
    console.log(`[Batch Industry] Processing ${companies.length} companies`);
    const results = [];
    for (const company of companies) {
      try {
        const messages = [
          { role: 'system', content: `Return ONLY JSON: {"industry": "Industry Name", "confidence": "High/Medium/Low"}` },
          { role: 'user', content: `What industry is "${company.name}" (${company.url}) in?` }
        ];
        const response = await callOpenRouter(MODELS.industry, messages, 0.2);
        let result;
        try { result = JSON.parse(response.replace(/```json/g,'').replace(/```/g,'').trim()); }
        catch { result = { industry: 'Unknown', confidence: 'Low' }; }
        results.push({ name: company.name, url: company.url, ...result });
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        results.push({ name: company.name, url: company.url, industry: 'Error', confidence: 'Low', error: err.message });
      }
    }
    res.json({ results });
  } catch (error) {
    console.error('[Batch Industry] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ===== CLEARSIGNALS AI ENGINE (BUILT-IN) ====================================
// ============================================================================
const csSessions = new Map();
const crypto = require('crypto');

app.post('/api/coaching-session', async (req, res) => {
  const { companyName, contactName, contactTitle, contactEmail, dealValue, stage } = req.body;
  try {
    const sessionToken = 'cs_sess_' + crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    csSessions.set(sessionToken, { lead: { company: companyName || 'Unknown', contact_name: contactName || null, contact_title: contactTitle || null, contact_email: contactEmail || null, estimated_value: dealValue || null, stage: stage || 'Discovery' }, created_at: new Date().toISOString(), expires_at: expiresAt });
    console.log(`[ClearSignals] Session created for: ${companyName}`);
    res.json({ session_token: sessionToken, expires_at: expiresAt });
  } catch (error) {
    console.error('[ClearSignals Session Error]:', error.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.post('/api/coaching-analyze', async (req, res) => {
  const { session_token, thread_text } = req.body;
  if (!session_token || !thread_text) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'session_token and thread_text are required', status: 400 } });
  if (thread_text.length < 100) return res.status(422).json({ error: { code: 'THREAD_TOO_SHORT', message: 'Thread text must contain at least 100 characters.', status: 422 } });
  const session = csSessions.get(session_token);
  if (!session) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid or expired session token', status: 401 } });
  if (new Date(session.expires_at) < new Date()) { csSessions.delete(session_token); return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Session token expired', status: 401 } }); }
  const lead = session.lead;
  const analysisId = 'ca_' + crypto.randomBytes(8).toString('hex');
  try {
    const storedLead = leadStore.get(lead.company);
    const painCtx = req.body.pain_context;
    const solutionCtx = painCtx ? `Known intelligence: ${JSON.stringify(painCtx)}` : storedLead ? `Known lead data: ${JSON.stringify(storedLead)}` : 'No prior context.';
    const messages = [
      { role: 'system', content: `You are ClearSignals AI — elite email thread analyst for B2B sales coaching.\nLEAD: ${lead.company} | ${lead.contact_name || 'Unknown'} (${lead.contact_title || 'Unknown'})\nSOLUTION CONTEXT: ${solutionCtx}\nReturn ONLY valid JSON:\n{\n  "analysis_id": "${analysisId}",\n  "generated_at": "${new Date().toISOString()}",\n  "deal_health": {"score": 70, "label": "healthy|neutral|at_risk|critical", "stage": "stage", "days_in_stage": null, "last_activity_days": 2, "response_rate": 0.8, "sentiment_trend": "warming|stable|cooling|cold"},\n  "intelligence": {"company": {"summary": "", "relevance": ""}, "industry": {"summary": "", "relevance": ""}},\n  "timeline": [{"date": "date", "direction": "outbound|inbound|gap", "label": "label", "status": "positive|neutral|concerning", "note": "note"}],\n  "next_steps": [{"priority": 1, "action": "action", "detail": "detail", "timing": "Today", "rationale": "why"}],\n  "coaching_tips": [{"title": "title", "tip": "tip", "in_this_thread": "example"}]\n}` },
      { role: 'user', content: `Analyze this email thread:\n\n${thread_text}` }
    ];
    const llmResponse = await callOpenRouter(MODELS.painpoints, messages, 0.3);
    let analysis;
    try {
      const jsonMatch = llmResponse.match(/```json\n?([\s\S]*?)\n?```/) || llmResponse.match(/```\n?([\s\S]*?)\n?```/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[1] : llmResponse.trim());
    } catch (e) {
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to parse analysis', status: 500 } });
    }
    analysis.analysis_id = analysisId;
    analysis.generated_at = new Date().toISOString();
    analysis.pii_purged_at = new Date(Date.now() + 1000).toISOString();
    console.log(`[ClearSignals] Complete: ${analysisId} — ${analysis.deal_health?.score}/100`);
    res.json(analysis);
  } catch (error) {
    console.error('[ClearSignals Engine Error]:', error.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Analysis failed: ' + error.message, status: 500 } });
  }
});

setInterval(() => {
  const now = new Date();
  for (const [token, session] of csSessions) {
    if (new Date(session.expires_at) < now) csSessions.delete(token);
  }
}, 1800000);

app.post('/api/leads/:companyName/ring-bell', (req, res) => {
  const companyName = req.params.companyName;
  const lead = leadStore.get(companyName) || { companyName };
  lead.is_pam_alert_active = true; lead.pam_alert_start_time = new Date();
  leadStore.set(companyName, lead);
  console.log(`[CALL BELL ACTIVE] PAM Alert triggered for: ${companyName}`);
  res.json({ status: 'success', is_pam_alert_active: true });
});

app.post('/api/leads/:companyName/clear-bell', (req, res) => {
  const companyName = req.params.companyName;
  const lead = leadStore.get(companyName);
  if (lead) { lead.is_pam_alert_active = false; leadStore.set(companyName, lead); }
  res.json({ status: 'success', is_pam_alert_active: false });
});

app.get('/api/leads/:companyName/status', (req, res) => {
  res.json(leadStore.get(req.params.companyName) || { is_pam_alert_active: false });
});

// ===== PER-COMPANY PAIN AGENT =====
app.post('/api/agent/company-pain', async (req, res) => {
  try {
    const { companyName, website, address, industry, solution, lang } = req.body;
    if (!companyName || !solution) return res.status(400).json({ error: 'companyName and solution are required' });
    const responseLang = lang === 'en' ? 'Respond entirely in English.' : 'Respond entirely in German (Deutsch).';
    console.log(`[Company Pain Agent] Generating intelligence for: ${companyName}`);
    const messages = [
      { role: 'system', content: `You are an elite B2B sales strategist. Generate highly specific sales intelligence.\nReturn ONLY valid JSON:\n{\n  "score": 75,\n  "whoIsThis": "2-3 sentence narrative",\n  "primaryLead": {"title": "target title", "topic": "conversation topic"},\n  "painIndicators": [{"label": "2-4 word chip", "explanation": "1-2 sentence explanation"}],\n  "questions": [\n    {"stage": "OPENING — Discovery", "question": "question", "purpose": "purpose", "pain_point": "pain", "positive_responses": [{"response": "ans", "next_step": "step"}], "neutral_negative_responses": [{"response": "ans", "pivot": "pivot"}]},\n    {"stage": "DEEPENING — Pain Exploration", "question": "q", "purpose": "p", "pain_point": "pain", "positive_responses": [{"response": "r", "next_step": "s"}], "neutral_negative_responses": [{"response": "r", "pivot": "p"}]},\n    {"stage": "CLOSING — Business Impact & ROI", "question": "q", "purpose": "p", "pain_point": "pain", "positive_responses": [{"response": "r", "next_step": "s"}], "neutral_negative_responses": [{"response": "r", "pivot": "p"}]}\n  ],\n  "strategicInsight": "AI insight — NOT a question",\n  "extraBackground": "2-3 sentences context",\n  "emailCampaign": [\n    {"step": 1, "label": "Initial Outreach", "sendDay": "Day 1", "subject": "subject", "body": "body"},\n    {"step": 2, "label": "Value-Add Follow-Up", "sendDay": "Day 4", "subject": "subject", "body": "body"},\n    {"step": 3, "label": "Pain-Point Trigger", "sendDay": "Day 8", "subject": "subject", "body": "body"},\n    {"step": 4, "label": "Social Proof & Nudge", "sendDay": "Day 14", "subject": "subject", "body": "body"},\n    {"step": 5, "label": "Breakup / Last Touch", "sendDay": "Day 21", "subject": "subject", "body": "body"}\n  ]\n}\n${responseLang}` },
      { role: 'user', content: `Generate sales intelligence:\nCOMPANY: ${companyName}\nWEBSITE: ${website || 'Unknown'}\nLOCATION: ${address || 'Unknown'}\nINDUSTRY: ${industry || 'Unknown'}\nSOLUTION: ${solution.name} (${solution.type})\nDESCRIPTION: ${solution.description}\nCAPABILITIES: ${solution.capabilities?.join(', ') || 'N/A'}\nReturn ONLY valid JSON, no markdown.` }
    ];
    const response = await callOpenRouter(MODELS.painpoints, messages, 0.5, { maxTokens: 16000, webSearch: true });
    let companyPainData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      companyPainData = JSON.parse(jsonMatch ? jsonMatch[1] : response.trim());
    } catch (e) {
      console.error('[Company Pain Agent] Parse error:', response.substring(0, 200));
      return res.status(500).json({ error: 'Failed to parse company pain response' });
    }
    console.log(`[Company Pain Agent] Complete for: ${companyName} (score: ${companyPainData.score})`);
    res.json(companyPainData);
  } catch (error) {
    console.error('[Company Pain Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Brain Trust advisory panel system
const { BRAIN_TRUST_ROLES, runBrainTrustPanel, runBrainTrustVertical, runBrainTrustPainMapper, runBrainTrustMetro } = require('./brain-trust')(callOpenRouterJSON, MODELS);

// ============================================================================
// ===== PROSPECTOR MODULE ====================================================
// ============================================================================

async function runVerticalSelector(solutionData, targetVertical = '') {
  const systemPrompt = `You are the Vertical Selector Agent. Identify the BEST industry vertical to target.\nReturn JSON:\n{\n  "selected_vertical": "Specific vertical",\n  "naics_codes": [],\n  "rationale": "3-4 sentences",\n  "structural_fit": "why this vertical needs it",\n  "pain_density": "how common/acute",\n  "competitive_landscape": "competitive environment",\n  "runner_up_verticals": [{"vertical": "v", "why_not_first": "reason"}],\n  "micro_verticals": ["hyper-specific sub-segment"]\n}`;
  const override = targetVertical ? `\nUser suggested: "${targetVertical}". Validate or override with explanation.` : '';
  const userPrompt = `Best vertical for:\nName: ${solutionData.name}\nType: ${solutionData.type || ''}\nDescription: ${solutionData.description || ''}\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\nTarget Market: ${solutionData.targetMarket || ''}${override}`;
  console.log('[Vertical Selector] Running...');
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 3000 });
  console.log(`[Vertical Selector] Selected: ${result.selected_vertical}`);
  return result;
}

async function runPainMapper(solutionData, verticalData) {
  const systemPrompt = `You are the Pain Mapper Agent. Produce a surgical pain map.\nReturn JSON:\n{\n  "pain_map": [{"pain": "specific pain", "severity": "critical|high|moderate", "who_feels_it": "title", "business_cost": "cost", "observable_signals": [], "solution_capability": "feature", "trigger_events": []}],\n  "ideal_prospect_profile": {"company_size": "range", "revenue_range": "range", "tech_maturity": "low|mixed|high", "complexity_indicators": [], "disqualifiers": []},\n  "search_terms": [],\n  "vertical_context": "2-3 sentences"\n}`;
  const userPrompt = `Pain map for ${solutionData.name} x ${verticalData.selected_vertical}:\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\nVertical rationale: ${verticalData.rationale || ''}\nMicro-verticals: ${(verticalData.micro_verticals || []).join(', ')}`;
  console.log(`[Pain Mapper] Mapping pains for ${solutionData.name} x ${verticalData.selected_vertical}...`);
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 5000 });
  console.log(`[Pain Mapper] Mapped ${(result.pain_map || []).length} pain points`);
  return result;
}

async function runMetroCartographer(solutionData, verticalData, geoSeed = '') {
  const systemPrompt = `You are the Metro Cartographer Agent. Select the BEST metro for prospecting.\nReturn JSON:\n{\n  "selected_metro": "Metro, State",\n  "city_core": "city",\n  "state": "state",\n  "rationale": "3-4 sentences",\n  "estimated_target_pool": "number",\n  "key_business_corridors": [{"corridor": "name", "description": "desc", "landmark": "landmark"}],\n  "economic_signals": [],\n  "incumbent_vendors": [],\n  "adjacent_metros": [{"metro": "m", "distance": "d", "density": "pool"}],\n  "local_knowledge": {"major_highways": [], "industrial_zones": [], "rapport_references": []}\n}`;
  const geoInstr = geoSeed ? `\nUser suggested: "${geoSeed}". Validate density or suggest better metro.` : '';
  const userPrompt = `Best metro for:\n${solutionData.name} | ${verticalData.selected_vertical}\nMicro-verticals: ${(verticalData.micro_verticals || []).join(', ')}${geoInstr}`;
  console.log('[Metro Cartographer] Running...');
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 3000 });
  console.log(`[Metro Cartographer] Selected: ${result.selected_metro}`);
  return result;
}

async function runAccountProspector(solutionData, verticalData, metroData, accountVolume = 10, painData = null) {
  const systemPrompt = `You are the Account Prospector Agent. Find SPECIFIC REAL COMPANIES.\nNever fabricate. Use web search.\nReturn JSON:\n{\n  "prospects": [{"id": 1, "name": "name", "website": "url", "metro": "metro", "location": "city", "landmark": "landmark", "employees": "range", "phone": "phone", "priority": 85, "priority_class": "high|medium|low", "who_is_this": "narrative", "contact_title": "title", "lead_module": "capability", "pain_tags": [], "growth_signals": [], "disqualification_risk": "risk"}],\n  "search_summary": {"total_found": 0, "high_priority": 0, "medium_priority": 0, "metros_covered": [], "verticals_represented": []}\n}`;
  let painContext = '';
  if (painData?.pain_map) {
    painContext = '\n\nPAIN MAP:\n' + painData.pain_map.map((p, i) => `  ${i+1}. "${p.pain}" (${p.severity}) — ${p.who_feels_it}`).join('\n');
  }
  const userPrompt = `Find ${accountVolume} real companies:\n${solutionData.name} | ${verticalData.selected_vertical} | ${metroData.selected_metro}\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\nMicro-verticals: ${(verticalData.micro_verticals || []).join(', ')}\nCorridors: ${(metroData.key_business_corridors || []).map(c => c.corridor).join(', ')}${painContext}\nReturn valid JSON.`;
  console.log(`[Account Prospector] Finding ${accountVolume} prospects in ${metroData.selected_metro}...`);
  const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.4, { webSearch: true, maxTokens: 8000 });
  console.log(`[Account Prospector] Found ${(result.prospects || []).length} prospects`);
  return result;
}

app.post('/api/prospector/run', async (req, res) => {
  try {
    const { solutionData, targetVertical, geoSeed, accountVolume } = req.body;
    if (!solutionData) return res.status(400).json({ error: 'solutionData is required' });
    const volume = Math.min(Math.max(accountVolume || 10, 1), 50);
    console.log(`[Prospector] Starting: vertical=${targetVertical || 'auto'}, geo=${geoSeed || 'auto'}, volume=${volume}`);
    const verticalData = await runVerticalSelector(solutionData, targetVertical || '');
    const painData = await runPainMapper(solutionData, verticalData);
    const metroData = await runMetroCartographer(solutionData, verticalData, geoSeed || '');
    const prospectData = await runAccountProspector(solutionData, verticalData, metroData, volume, painData);
    res.json({ vertical: verticalData, painMap: painData, metro: metroData, prospects: prospectData.prospects || [], search_summary: prospectData.search_summary || {} });
  } catch (error) {
    console.error('[Prospector] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/prospector/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Use POST /api/prospector/run' })}\n\n`);
  res.end();
});

app.post('/api/prospector/braintrust', async (req, res) => {
  try {
    const { solutionData, targetVertical, geoSeed, accountVolume } = req.body;
    if (!solutionData) return res.status(400).json({ error: 'solutionData is required' });
    const volume = Math.min(Math.max(accountVolume || 10, 1), 50);
    console.log('[Brain Trust Prospector] Starting panel-driven pipeline');
    const verticalPanel = await runBrainTrustVertical(solutionData, targetVertical || '');
    const verticalConsensus = verticalPanel.consensus || {};
    const painPanel = await runBrainTrustPainMapper(solutionData, verticalConsensus);
    const painConsensus = painPanel.consensus || {};
    const metroPanel = await runBrainTrustMetro(solutionData, verticalConsensus, geoSeed || '');
    const metroConsensus = metroPanel.consensus || {};
    const prospectData = await runAccountProspector(solutionData, verticalConsensus, metroConsensus, volume, painConsensus);
    res.json({ mode: 'braintrust', vertical: verticalConsensus, verticalPanel: { discussion: verticalPanel.panel_discussion, advisors: verticalPanel.advisor_contributions }, painMap: painConsensus, painPanel: { discussion: painPanel.panel_discussion, advisors: painPanel.advisor_contributions }, metro: metroConsensus, metroPanel: { discussion: metroPanel.panel_discussion, advisors: metroPanel.advisor_contributions }, prospects: prospectData.prospects || [], search_summary: prospectData.search_summary || {} });
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
      { role: 'system', content: `Generate realistic 4-6 email sales threads. Format as forwarded thread (newest first) with From/To/Date/Subject headers. Include positive signals, hesitations, budget/timeline concerns, competitor reference. 400-800 words total.` },
      { role: 'user', content: `Demo thread for: ${companyName}\n${painInfo.primaryLead ? 'Contact: ' + painInfo.primaryLead.title : ''}\n${painInfo.painIndicators ? 'Pain points: ' + painInfo.painIndicators.map(p => p.label || p).join(', ') : ''}\n${painInfo.whoIsThis ? 'Context: ' + painInfo.whoIsThis : ''}` }
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

const PREFERRED_TITLES = ['ciso','chief information security','cto','chief technology','cio','chief information officer','vp of it','vp it','it director','director of it','head of it','it manager','ceo','chief executive','president','owner','founder','co-founder','operations','coo'];

function scoreTitle(title) {
  const t = (title || '').toLowerCase();
  for (let i = 0; i < PREFERRED_TITLES.length; i++) { if (t.includes(PREFERRED_TITLES[i])) return i; }
  return PREFERRED_TITLES.length;
}

function extractDomain(url) {
  return (url || '').toLowerCase().replace(/https?:\/\//, '').replace(/www\./, '').split('/')[0].trim();
}

app.post('/api/contact/lookup', async (req, res) => {
  const { customer_url, title_hint } = req.body;
  if (!customer_url) return res.status(400).json({ error: 'customer_url required' });
  if (!APOLLO_API_KEY) return res.status(503).json({ error: 'APOLLO_API_KEY not configured' });
  const domain = extractDomain(customer_url);
  const titles = title_hint ? [title_hint] : ['CISO','CTO','CIO','VP of IT','IT Director','CEO'];
  console.log(`[ContactLookup] domain=${domain} hint=${title_hint || 'none'}`);
  try {
    let people = [];
    const r1 = await axios.post('https://api.apollo.io/v1/mixed_people/search', { api_key: APOLLO_API_KEY, q_organization_domains: domain, person_titles: titles, contact_email_status: ['verified','likely'], per_page: 10, page: 1 }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    people = r1.data?.people || [];
    if (!people.length) {
      const r2 = await axios.post('https://api.apollo.io/v1/mixed_people/search', { api_key: APOLLO_API_KEY, q_organization_domains: domain, contact_email_status: ['verified','likely'], per_page: 10, page: 1 }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      people = r2.data?.people || [];
    }
    if (!people.length) return res.json({ found: false, reason: 'No contacts found' });
    const best = people.sort((a, b) => scoreTitle(a.title) - scoreTitle(b.title))[0];
    const email = ['verified','likely'].includes(best.email_status) ? (best.email || '') : '';
    console.log(`[ContactLookup] Found: ${best.first_name} ${best.last_name} | ${best.title} | email=${!!email}`);
    res.json({ found: true, name: `${best.first_name || ''} ${best.last_name || ''}`.trim(), first_name: best.first_name || '', last_name: best.last_name || '', title: best.title || '', email, email_status: best.email_status || 'unknown', linkedin_url: best.linkedin_url || '', source: 'apollo' });
  } catch (err) {
    console.error('[ContactLookup] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contact/cpp', async (req, res) => {
  const { contact_name, contact_title, company_name, linkedin_url } = req.body;
  if (!contact_name) return res.status(400).json({ error: 'contact_name required' });
  console.log(`[ContactCPP] ${contact_name} | ${contact_title} | ${company_name}`);
  let linkedinScraped = '';
  if (linkedin_url && fcAvailable()) {
    linkedinScraped = await fcInteractLinkedIn(linkedin_url) || '';
    if (linkedinScraped) console.log(`[ContactCPP] LinkedIn scraped: ${linkedinScraped.length} chars`);
  }
  const linkedinHint = (linkedin_url && !linkedinScraped) ? `\nLinkedIn URL: ${linkedin_url}` : '';
  const systemPrompt = `You are a Communication Intelligence Analyst building a first-outreach CPP for a B2B sales rep.\nSearch the web for this person's public digital footprint: LinkedIn, company bio, conference bios, articles, press.\nReturn ONLY valid JSON:\n{\n  "contact_name": "name", "title": "title", "company": "company", "headline": "headline",\n  "confidence": "high|medium|low|none", "sources_found": [],\n  "dimensions": {\n    "directness": {"score": 5, "label": "direct|balanced|diplomatic", "justification": "", "signal": ""},\n    "formality": {"score": 5, "label": "formal|professional|conversational|casual", "justification": "", "signal": ""},\n    "decision_style": {"score": 5, "label": "analytical|intuitive|relationship-driven|process-driven", "justification": "", "signal": ""},\n    "persuasion_receptivity": {"score": 5, "label": "data/ROI|social proof|authority|narrative|relationship", "justification": "", "signal": ""},\n    "risk_tolerance": {"score": 5, "label": "conservative|moderate|aggressive", "justification": "", "signal": ""},\n    "emotional_expressiveness": {"score": 5, "label": "stoic|measured|expressive|passionate", "justification": "", "signal": ""}\n  },\n  "signature_language": [],\n  "rep_guidance": {"opening_tone": "", "what_to_lead_with": "", "what_to_avoid": "", "subject_line_style": "", "one_sentence_briefing": ""},\n  "insufficient_data_flags": []\n}\nNever score above 4 on pure inference.`;
  const scrapedBlock = linkedinScraped ? `\n\nSCRAPED LINKEDIN PROFILE (highest-quality signal):\n${linkedinScraped}` : '';
  const userPrompt = `Build first-outreach CPP for:\nName: ${contact_name}\nTitle: ${contact_title || 'Unknown'}\nCompany: ${company_name || 'Unknown'}${linkedinHint}${scrapedBlock}\n\n${linkedinScraped ? 'Scraped LinkedIn is primary source. Use web search for additional content.' : 'Search web for their public digital footprint. Focus on HOW to approach them cold.'}`;
  try {
    const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.3, { webSearch: true, maxTokens: 2000 });
    res.json(result);
  } catch (err) {
    console.error('[ContactCPP] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    if (d >= 7) lines.push('- DIRECTNESS: High — lead with the problem in sentence one.');
    else if (d <= 4) lines.push('- DIRECTNESS: Low — two sentences of context before pitch.');
    else lines.push('- DIRECTNESS: Balanced — brief setup then the point.');
    const f = dims.formality?.score || 5;
    if (f >= 7) lines.push('- FORMALITY: High — professional vocabulary, no contractions.');
    else if (f <= 3) lines.push('- FORMALITY: Low — conversational, peer-to-peer.');
    else lines.push('- FORMALITY: Professional standard tone.');
    const ds = dims.decision_style?.label || '';
    if (ds.includes('analytical')) lines.push('- DECISION STYLE: Analytical — include a specific metric.');
    else if (ds.includes('relationship')) lines.push('- DECISION STYLE: Relationship-driven — lead with shared context.');
    const ps = dims.persuasion_receptivity?.label || '';
    if (ps.toLowerCase().includes('roi') || ps.includes('data')) lines.push('- PERSUASION: Lead with ROI or cost impact.');
    else if (ps.includes('social')) lines.push('- PERSUASION: Reference peer companies or outcomes.');
    else if (ps.includes('narrative')) lines.push('- PERSUASION: Short story — situation, problem, resolution.');
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
  const systemPrompt = `You are an elite B2B sales email writer. Write a cold outreach email under 150 words.\nOpen with one specific observation about their business. Lead with what it means for THEM. One low-commitment ask.\nNever use: "I hope this finds you well", "I wanted to reach out", "synergy", "exciting opportunity".\nFollow CPP instructions precisely.\nReturn ONLY valid JSON: {"subject_line": "...", "body": "...", "ps_hook": "..."}`;
  const userPrompt = `Write cold outreach email.\nRECIPIENT: ${contact_name}, ${contact_title || 'unknown'} at ${company_name || 'their company'}\nCPP:\n${cppBlock}\nCOMPANY: ${pc.whoIsThis || ''}\n${pc.primaryLead ? 'Topic: ' + (pc.primaryLead.topic || '') : ''}\n${(pc.painIndicators || []).length ? 'Pain: ' + pc.painIndicators.map(p => p.label || p).join(', ') : ''}\nReturn only valid JSON.`;
  try {
    const result = await callOpenRouterJSON(MODELS.painpoints, systemPrompt, userPrompt, 0.4, { maxTokens: 800 });
    res.json({ contact_name, contact_title, company_name, contact_email: contact_email || '', cpp_applied: !['none','low'].includes(confidence), draft: result });
  } catch (err) {
    console.error('[ContactDraft] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', models: MODELS,
    apiKeyConfigured: !!OPENROUTER_API_KEY,
    clearSignalsConfigured: !!CLEARSIGNALS_VENDOR_KEY,
    apolloConfigured: !!APOLLO_API_KEY,
    firecrawlConfigured: fcAvailable()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Lead Hydration Engine - LLM Agents               ║
╠════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  Apollo: ${APOLLO_API_KEY ? '✓' : '✗'}  Firecrawl: ${FIRECRAWL_API_KEY ? '✓' : '✗'}                           ║
╚════════════════════════════════════════════════════════════╝
  `);
});
