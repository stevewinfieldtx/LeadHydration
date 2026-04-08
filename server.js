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
// Fetches the actual URL content first, then uses LLM to analyze it
// URL content is the source of truth — LLM knowledge is secondary
app.post('/api/agent/solution', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`[Solution Agent] Researching: ${url}`);
    console.log(`[Solution Agent] Using model: ${MODELS.solution}`);

    // Step 1: Actually fetch the URL content
    let pageContent = '';
    try {
      const fullUrl = url.startsWith('http') ? url : 'https://' + url;
      const fetchRes = await axios.get(fullUrl, {
        timeout: 15000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadHydrationBot/1.0)' },
        responseType: 'text'
      });
      // Strip HTML tags, scripts, styles to get readable text
      pageContent = fetchRes.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000); // Limit to ~8000 chars to fit in context
      console.log(`[Solution Agent] Fetched ${pageContent.length} chars from ${fullUrl}`);
    } catch (fetchErr) {
      console.log(`[Solution Agent] Could not fetch URL: ${fetchErr.message}. Using LLM knowledge only.`);
      pageContent = '';
    }

    const messages = [
      {
        role: 'system',
        content: `You are a solution research expert. Your job is to analyze a product/solution and extract key information.

CRITICAL RULE: If WEBSITE CONTENT is provided below, that is the SOURCE OF TRUTH. Base your analysis primarily on what the website actually says the product does. If your own knowledge about the company contradicts the website content, TRUST THE WEBSITE. Only supplement with your own knowledge if it is consistent with the website content.

If NO website content could be fetched, use your best knowledge but clearly indicate lower confidence.

Return your response in this exact JSON format:
{
  "name": "Product Name",
  "type": "Type of solution (e.g., NDR, CRM, ERP, SIEM, EDR, etc.)",
  "description": "Brief description of what the solution actually does based on the website",
  "capabilities": ["capability 1", "capability 2", "capability 3", "capability 4", "capability 5"],
  "targetMarket": "Who typically buys this solution",
  "keyBenefits": ["benefit 1", "benefit 2", "benefit 3"],
  "confidence": "high if from website content, low if from knowledge only"
}`
      },
      {
        role: 'user',
        content: `Analyze this solution: ${url}

${pageContent ? 'WEBSITE CONTENT (SOURCE OF TRUTH):\n' + pageContent : 'NOTE: Could not fetch website content. Use your knowledge but indicate low confidence.'}

Based PRIMARILY on the website content above:
1. What is the product name?
2. What category/type of solution is it?
3. What are its main capabilities/features?
4. Who is the target market?
5. What are the key benefits?

Return ONLY valid JSON, no markdown formatting, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.solution, messages, 0.3);
    
    // Parse the JSON response
    let solutionData;
    try {
      // Try to extract JSON if it's wrapped in markdown
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      solutionData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('Failed to parse solution response:', response);
      // Return raw response if parsing fails
      return res.json({
        raw: response,
        name: 'Unknown Solution',
        type: 'Business Software',
        description: 'Could not parse solution details',
        capabilities: [],
        targetMarket: 'Unknown',
        keyBenefits: []
      });
    }

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
    const { companyName, website, address } = req.body;
    
    if (!companyName || !website) {
      return res.status(400).json({ error: 'Company name and website are required' });
    }

    console.log(`[Industry Agent] Analyzing: ${companyName}`);
    console.log(`[Industry Agent] Using model: ${MODELS.industry}`);

    const messages = [
      {
        role: 'system',
        content: `You are an industry classification expert. Your job is to analyze a company and determine its primary industry.

Return your response in this exact JSON format:
{
  "industry": "Primary Industry Name (e.g., Manufacturing, Healthcare, Financial Services, Technology, Retail, etc.)",
  "subIndustry": "More specific sub-category if applicable",
  "confidence": "High/Medium/Low",
  "reasoning": "Brief explanation of why this industry was selected"
}

Be specific but use standard industry names. If uncertain, use "Unknown" with Low confidence.`
      },
      {
        role: 'user',
        content: `Analyze this company and determine its industry:

Company Name: ${companyName}
Website: ${website}
${address ? `Address: ${address}` : ''}

Based on the company name and website domain, what industry does this company operate in?

Return ONLY valid JSON, no markdown formatting, no explanations.`
      }
    ];

    const response = await callOpenRouter(MODELS.industry, messages, 0.2);
    
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
        confidence: 'Low',
        reasoning: 'Could not parse response',
        raw: response
      };
    }

    console.log(`[Industry Agent] Result: ${industryData.industry} (${industryData.confidence})`);
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
    const { companyName, website, solution, targetIndustries, employeeCount, city, country, pass } = req.body;
    if (!companyName) return res.status(400).json({ error: 'companyName is required' });

    const isSecondPass = pass === 2;
    const effectiveCountry = (country || 'Germany').trim();
    const isGerman = effectiveCountry.toLowerCase().includes('german') || effectiveCountry.toLowerCase() === 'de';

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
        industry: 'Unknown', subIndustry: null, naicsCode: null, wzCode: null,
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

    const messages = [
      {
        role: 'system',
        content: `You are a rapid lead qualification expert. Classify this company and score its fit.

ALWAYS return BOTH industry code systems:
- naicsCode: US NAICS code (e.g. "332710" for Machine Shops, "333249" for Industrial Machinery)
- localCode: The local country industry code. For Germany this is the WZ/NACE code (e.g. "28" for Maschinenbau, "25" for Metallerzeugnisse). For other countries use the equivalent national code.

Return ONLY valid JSON:
{
  "industry": "Primary industry name in English",
  "subIndustry": "More specific sub-category",
  "naicsCode": "US NAICS code (4-6 digits)",
  "localCode": "Local industry code (WZ for Germany, SIC for UK, etc.)",
  "localCodeSystem": "WZ" or "NACE" or "SIC" etc.,
  "fitScore": <integer 0-100>,
  "fitReason": "1-2 sentence explanation",
  "disqualifyReason": "If fitScore < 60, explain why. Otherwise null",
  "sizeEstimate": "Estimated company size if detectable",
  "websiteAlive": true/false
}

Scoring: 80-100=strong fit, 60-79=possible, 40-59=weak, 0-39=not a fit.${targetIndustryContext}`
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

    const response = await callOpenRouter(MODELS.prequalify, messages, 0.2, { maxTokens: 500 });

    let result;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      result = JSON.parse(jsonString.trim());
    } catch {
      result = {
        industry: 'Unknown', subIndustry: null, naicsCode: null, localCode: null, localCodeSystem: null,
        fitScore: 50, fitReason: 'Could not parse response',
        disqualifyReason: null, sizeEstimate: null, websiteAlive: !!scrapeResult?.alive
      };
    }

    // Normalize
    result.fitScore = parseInt(result.fitScore) || 50;
    result.qualified = result.fitScore >= 60;
    result.websiteAlive = !!scrapeResult?.alive;
    result.urlFailed = false;
    // Backward compat: keep wzCode for German companies
    if (isGerman && result.localCode) result.wzCode = result.localCode;
    // If domain was resolved via search, include it
    if (scrapeResult?.resolvedDomain && scrapeResult.resolvedDomain !== (website || '').replace(/^https?:\/\//, '').replace(/^www\./, '')) {
      result.resolvedDomain = scrapeResult.resolvedDomain;
    }

    console.log(`[Pre-Qualify${isSecondPass ? ' P2' : ''}] ${companyName}: ${result.fitScore}/100 — ${result.qualified ? 'QUALIFIED' : 'DISQUALIFIED'} (${result.industry}) NAICS:${result.naicsCode || '?'} Local:${result.localCode || '?'}`);
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
            const jsonMatch = llmResponse.match(/```json\n?([\s\S]*?)\n?```/) || llmResponse.match(/```\n?([\s\S]*?)\n?```/);
            const jsonString = jsonMatch ? jsonMatch[1] : llmResponse;
            analysis = JSON.parse(jsonString.trim());
        } catch (parseError) {
            console.error('[ClearSignals] Parse error:', llmResponse.substring(0, 300));
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
    const { companyName, website, address, industry, solution } = req.body;
    if (!companyName || !solution) {
      return res.status(400).json({ error: 'companyName and solution are required' });
    }

    console.log(`[Company Pain Agent] Generating intelligence for: ${companyName}`);

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
  ]
}`
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

Generate highly specific intelligence for a first sales meeting at this company.
Each of the 3 questions must be tailored to their specific industry context.
The first question is the strategic opener, the second drills deeper into pain, the third links to ROI/business impact.
Each question MUST include purpose, pain_point, positive_responses (with next_step), and neutral_negative_responses (with pivot).
Pain indicators should be 2-4 word chips (e.g. "Manual Production Scheduling"), each with a 1-2 sentence explanation.
The strategicInsight should be a short AI insight about the opportunity — NOT a question. It's an observation like "Their recent expansion into Asia without upgrading their ERP suggests they'll hit inventory visibility issues within 6 months."
The emailCampaign should be a 5-step drip sequence: initial outreach, value-add follow-up, pain-point trigger, social proof, and breakup email. Each email should be personalized to this company.
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    models: MODELS,
    apiKeyConfigured: !!OPENROUTER_API_KEY,
    clearSignalsConfigured: !!CLEARSIGNALS_VENDOR_KEY
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
