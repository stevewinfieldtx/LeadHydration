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
  customer: process.env.OPENROUTER_MODEL_CUSTOMER || 'anthropic/claude-haiku-4.5'
};

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
      let content = raw.trim();
      if (content.startsWith('```json')) content = content.slice(7);
      else if (content.startsWith('```')) content = content.slice(3);
      if (content.endsWith('```')) content = content.slice(0, -3);
      content = content.trim();
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd > jsonStart) content = content.substring(jsonStart, jsonEnd + 1);
      content = content.replace(/,\s*([}\]])/g, '$1');
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
    try {
      const fullUrl = url.startsWith('http') ? url : 'https://' + url;
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
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim().slice(0, 8000);
      console.log(`[Solution Agent] Fetched ${pageContent.length} chars from ${fullUrl}`);
    } catch (fetchErr) {
      console.log(`[Solution Agent] Could not fetch URL: ${fetchErr.message}. Using LLM knowledge only.`);
    }

    const messages = [
      { role: 'system', content: `You are a solution research expert. Your job is to analyze a product/solution and extract key information.

CRITICAL RULE: If WEBSITE CONTENT is provided below, that is the SOURCE OF TRUTH. Base your analysis primarily on what the website actually says the product does. If your own knowledge contradicts the website content, TRUST THE WEBSITE.

Return your response in this exact JSON format:
{
  "name": "Product Name",
  "type": "Type of solution (e.g., NDR, CRM, ERP, SIEM, EDR, etc.)",
  "description": "Brief description of what the solution actually does based on the website",
  "capabilities": ["capability 1", "capability 2", "capability 3", "capability 4", "capability 5"],
  "targetMarket": "Who typically buys this solution",
  "keyBenefits": ["benefit 1", "benefit 2", "benefit 3"],
  "confidence": "high if from website content, low if from knowledge only"
}` },
      { role: 'user', content: `Analyze this solution: ${url}\n\n${pageContent ? 'WEBSITE CONTENT (SOURCE OF TRUTH):\n' + pageContent : 'NOTE: Could not fetch website content. Use your knowledge but indicate low confidence.'}\n\nReturn ONLY valid JSON, no markdown formatting, no explanations.` }
    ];

    const response = await callOpenRouter(MODELS.solution, messages, 0.3);
    let solutionData;
    try {
      const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/) || response.match(/```\n?([\s\S]*?)\n?```/);
      const jsonString = jsonMatch ? jsonMatch[1] : response;
      solutionData = JSON.parse(jsonString.trim());
    } catch (parseError) {
      console.error('Failed to parse solution response:', response);
      return res.json({ raw: response, name: 'Unknown Solution', type: 'Business Software', description: 'Could not parse solution details', capabilities: [], targetMarket: 'Unknown', keyBenefits: [] });
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
      { role: 'system', content: `You are an industry classification expert. Return ONLY a JSON object: {"industry": "Industry Name", "subIndustry": "Sub-category", "confidence": "High/Medium/Low", "reasoning": "Brief explanation"}` },
      { role: 'user', content: `Analyze: ${companyName} (${website})${address ? ' at ' + address : ''}. Return only JSON.` }
    ];
    const response = await callOpenRouter(MODELS.industry, messages, 0.2);
    let industryData;
    try {
      const clean = response.replace(/```json/g, '').replace(/```/g, '').trim();
      industryData = JSON.parse(clean);
    } catch { industryData = { industry: 'Unknown', subIndustry: null, confidence: 'Low', reasoning: 'Could not parse response' }; }
    console.log(`[Industry Agent] Result: ${industryData.industry}`);
    res.json(industryData);
  } catch (error) {
    console.error('[Industry Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== PAIN POINT AGENT (for hydration flow — maps solution to industry pain points) =====
app.post('/api/agent/painpoints', async (req, res) => {
  try {
    const { industry, solution } = req.body;
    if (!industry || !solution) return res.status(400).json({ error: 'Industry and solution data are required' });
    console.log(`[Pain Point Agent] Mapping: ${industry} + ${solution.name}`);
    const messages = [
      { role: 'system', content: `You are a business analyst specializing in industry pain points. Return ONLY JSON: {"painPoints": [{"pain": "...", "solution": "...", "impact": "..."}]}. Provide 4-6 specific pain points.` },
      { role: 'user', content: `Industry: ${industry}\nSolution: ${solution.name} (${solution.type})\nDescription: ${solution.description}\nCapabilities: ${solution.capabilities?.join(', ') || 'N/A'}\nReturn ONLY valid JSON.` }
    ];
    const response = await callOpenRouter(MODELS.painpoints, messages, 0.4);
    let painData;
    try {
      const clean = response.replace(/```json/g, '').replace(/```/g, '').trim();
      painData = JSON.parse(clean);
    } catch { painData = { painPoints: [{ pain: 'Could not parse', solution: 'N/A', impact: 'N/A' }] }; }
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
    const messages = [
      { role: 'system', content: `You are a company research expert. Return ONLY JSON: {"companyName":"","industry":"","companySize":"","headquarters":"","description":"","keyDecisionMakers":[],"potentialUseCases":[],"researchNotes":""}` },
      { role: 'user', content: `Research: ${companyName} (${website})${address ? ' at ' + address : ''}. Return only JSON.` }
    ];
    const response = await callOpenRouter(MODELS.customer, messages, 0.3);
    let customerData;
    try {
      const clean = response.replace(/```json/g, '').replace(/```/g, '').trim();
      customerData = JSON.parse(clean);
    } catch { customerData = { companyName, industry: 'Unknown', companySize: 'Unknown', headquarters: address || 'Unknown', description: 'Could not retrieve', keyDecisionMakers: [], potentialUseCases: [], researchNotes: response }; }
    console.log(`[Customer Agent] Completed: ${customerData.companyName}`);
    res.json(customerData);
  } catch (error) {
    console.error('[Customer Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== BATCH INDUSTRIES =====
app.post('/api/batch/industries', async (req, res) => {
  try {
    const { companies } = req.body;
    if (!Array.isArray(companies) || !companies.length) return res.status(400).json({ error: 'Companies array required' });
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
        try { result = JSON.parse(response.replace(/```json/g, '').replace(/```/g, '').trim()); }
        catch { result = { industry: 'Unknown', confidence: 'Low' }; }
        results.push({ name: company.name, url: company.url, ...result });
        await new Promise(r => setTimeout(r, 100));
      } catch (err) { results.push({ name: company.name, url: company.url, industry: 'Error', confidence: 'Low', error: err.message }); }
    }
    res.json({ results });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================================
// ===== CLEARSIGNALS AI ENGINE (BUILT-IN) =================================
// ============================================================================
const csSessions = new Map();
const crypto = require('crypto');

app.post('/api/coaching-session', async (req, res) => {
  const { companyName, contactName, contactTitle, contactEmail, dealValue, stage } = req.body;
  try {
    const sessionToken = 'cs_sess_' + crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    csSessions.set(sessionToken, {
      lead: { company: companyName || 'Unknown Prospect', contact_name: contactName || null, contact_title: contactTitle || null, contact_email: contactEmail || null, estimated_value: dealValue || null, stage: stage || 'Discovery' },
      created_at: new Date().toISOString(), expires_at: expiresAt
    });
    console.log(`[ClearSignals] Session created for: ${companyName}`);
    res.json({ session_token: sessionToken, expires_at: expiresAt });
  } catch (error) { res.status(500).json({ error: 'Failed to create session' }); }
});

app.post('/api/coaching-analyze', async (req, res) => {
  const { session_token, thread_text } = req.body;
  if (!session_token || !thread_text) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'session_token and thread_text required', status: 400 } });
  if (thread_text.length < 100) return res.status(422).json({ error: { code: 'THREAD_TOO_SHORT', message: 'Thread must be 100+ chars', status: 422 } });
  const session = csSessions.get(session_token);
  if (!session) return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Invalid or expired session', status: 401 } });
  if (new Date(session.expires_at) < new Date()) { csSessions.delete(session_token); return res.status(401).json({ error: { code: 'AUTH_FAILED', message: 'Session expired', status: 401 } }); }
  const lead = session.lead;
  const analysisId = 'ca_' + crypto.randomBytes(8).toString('hex');
  try {
    const storedLead = leadStore.get(lead.company);
    const painCtx = req.body.pain_context;
    const solutionCtx = painCtx ? `Known intelligence: ${JSON.stringify(painCtx)}` : storedLead ? `Known lead data: ${JSON.stringify(storedLead)}` : 'No prior context.';
    const messages = [
      { role: 'system', content: `You are ClearSignals AI — an elite email thread analyst for B2B sales coaching. Analyze the thread, assess deal health (0-100), provide next steps and coaching tips. LEAD: ${lead.company} / ${lead.contact_name || 'Unknown'} (${lead.contact_title || 'Unknown'}). CONTEXT: ${solutionCtx}. Return ONLY valid JSON with: analysis_id, deal_health (score, label, sentiment_trend), intelligence, timeline[], next_steps[], coaching_tips[].` },
      { role: 'user', content: `Analyze this thread:\n\n${thread_text}` }
    ];
    const llmResponse = await callOpenRouter(MODELS.painpoints, messages, 0.3);
    let analysis;
    try { const clean = llmResponse.replace(/```json/g, '').replace(/```/g, '').trim(); analysis = JSON.parse(clean); }
    catch { return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to parse analysis', status: 500 } }); }
    analysis.analysis_id = analysisId;
    analysis.generated_at = new Date().toISOString();
    console.log(`[ClearSignals] Complete: ${analysisId} — ${analysis.deal_health?.score}/100`);
    res.json(analysis);
  } catch (error) { res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: error.message, status: 500 } }); }
});

setInterval(() => { const now = new Date(); for (const [t, s] of csSessions) { if (new Date(s.expires_at) < now) csSessions.delete(t); } }, 1800000);

// ===== PAM CALL BELL =====
app.post('/api/leads/:companyName/ring-bell', (req, res) => {
  const lead = leadStore.get(req.params.companyName) || { companyName: req.params.companyName };
  lead.is_pam_alert_active = true; lead.pam_alert_start_time = new Date();
  leadStore.set(req.params.companyName, lead);
  res.json({ status: 'success', is_pam_alert_active: true });
});
app.post('/api/leads/:companyName/clear-bell', (req, res) => {
  const lead = leadStore.get(req.params.companyName);
  if (lead) { lead.is_pam_alert_active = false; leadStore.set(req.params.companyName, lead); }
  res.json({ status: 'success', is_pam_alert_active: false });
});
app.get('/api/leads/:companyName/status', (req, res) => {
  res.json(leadStore.get(req.params.companyName) || { is_pam_alert_active: false });
});

// ===== PER-COMPANY PAIN AGENT (hydration flow) =====
app.post('/api/agent/company-pain', async (req, res) => {
  try {
    const { companyName, website, address, industry, solution } = req.body;
    if (!companyName || !solution) return res.status(400).json({ error: 'companyName and solution required' });
    console.log(`[Company Pain Agent] Generating intelligence for: ${companyName}`);
    const result = await callOpenRouterJSON(MODELS.painpoints,
      `You are an elite B2B sales strategist. Given a target company and solution, generate specific sales intelligence. Return JSON with: score (1-100), whoIsThis, primaryLead {title, topic}, painIndicators [{label, explanation}], questions [{stage, question, purpose, pain_point, positive_responses [{response, next_step}], neutral_negative_responses [{response, pivot}]}], strategicInsight, extraBackground, emailCampaign [{step, label, sendDay, subject, body}].`,
      `Company: ${companyName}\nWebsite: ${website || 'Unknown'}\nLocation: ${address || 'Unknown'}\nIndustry: ${industry || 'Unknown'}\nSolution: ${solution.name} (${solution.type})\nDescription: ${solution.description}\nCapabilities: ${solution.capabilities?.join(', ') || 'N/A'}\nGenerate highly specific intelligence. Return ONLY JSON.`,
      0.5, { maxTokens: 4000 });
    console.log(`[Company Pain Agent] Complete for: ${companyName} (score: ${result.score})`);
    res.json(result);
  } catch (error) {
    console.error('[Company Pain Agent] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ===== PROSPECTOR MODULE =====
// Pipeline: Solution → Vertical Selector → Pain Mapper → Metro Cartographer → Account Prospector
// ============================================================================

// --- VERTICAL SELECTOR AGENT ---
async function runVerticalSelector(solutionData, targetVertical = '') {
  const overrideInstruction = targetVertical ? `\nThe user has suggested: "${targetVertical}". Validate or override.` : '';
  console.log('[Vertical Selector] Running...');
  const result = await callOpenRouterJSON(MODELS.painpoints,
    `You are the Vertical Selector Agent. Given a solution profile, identify the BEST industry vertical to target — deepest pain, not broadest market. Evaluate: structural complexity, fragmented landscape, pain density, accessibility. Return JSON: {selected_vertical, naics_codes[], rationale, structural_fit, pain_density, competitive_landscape, runner_up_verticals[{vertical, why_not_first}], micro_verticals[]}. Be specific — not "Manufacturing" but "Custom metal fabricators serving aerospace with lot traceability requirements".`,
    `Solution: ${solutionData.name}\nType: ${solutionData.type || ''}\nDescription: ${solutionData.description || ''}\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\nTarget Market: ${solutionData.targetMarket || ''}${overrideInstruction}\nUse web search to validate.`,
    0.3, { webSearch: true, maxTokens: 3000 });
  console.log(`[Vertical Selector] Selected: ${result.selected_vertical}`);
  return result;
}

// --- PAIN MAPPER AGENT (NEW — bridges Vertical Selector and Account Prospector) ---
async function runPainMapper(solutionData, verticalData) {
  console.log(`[Pain Mapper] Mapping pains for ${solutionData.name} x ${verticalData.selected_vertical}...`);
  const result = await callOpenRouterJSON(MODELS.painpoints,
    `You are the Pain Mapper Agent. Given a SOLUTION and a SELECTED VERTICAL, produce a surgical pain map.

Each pain must be:
1. SPECIFIC to the vertical — not "inefficiency" but "manual lot traceability across multi-supplier raw material intake"
2. TIED to a business consequence — revenue loss, compliance risk, churn, burnout
3. OBSERVABLE from outside — job postings, tech stack clues, compliance issues
4. MAPPED to a specific solution capability

Return JSON:
{
  "pain_map": [
    {
      "pain": "Specific operational pain in plain language",
      "severity": "critical | high | moderate",
      "who_feels_it": "Specific job title(s)",
      "business_cost": "What this costs — dollars, time, risk",
      "observable_signals": ["External signals indicating this pain"],
      "solution_capability": "Which feature solves this",
      "trigger_events": ["Events making this urgent"]
    }
  ],
  "ideal_prospect_profile": {
    "company_size": "Employee range",
    "revenue_range": "Revenue range",
    "tech_maturity": "low | mixed | high",
    "complexity_indicators": ["What makes them need this"],
    "disqualifiers": ["Signs they do NOT have this pain"]
  },
  "search_terms": ["Terms for Account Prospector to search"],
  "vertical_context": "2-3 sentences of industry context"
}

Produce 5-8 pain points. Each should make a sales rep say "that is exactly what I hear on discovery calls."`,
    `Solution: ${solutionData.name} (${solutionData.type || ''})\nDescription: ${solutionData.description || ''}\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\nKey Benefits: ${(solutionData.keyBenefits || []).join(', ')}\n\nVertical: ${verticalData.selected_vertical}\nRationale: ${verticalData.rationale || ''}\nStructural Fit: ${verticalData.structural_fit || ''}\nMicro-Verticals: ${(verticalData.micro_verticals || []).join(', ')}`,
    0.3, { webSearch: true, maxTokens: 5000 });
  console.log(`[Pain Mapper] Mapped ${(result.pain_map || []).length} pain points`);
  return result;
}

// --- METRO CARTOGRAPHER AGENT ---
async function runMetroCartographer(solutionData, verticalData, geoSeed = '') {
  const geoInstruction = geoSeed ? `\nUser suggested: "${geoSeed}". Validate density or suggest better.` : '';
  console.log('[Metro Cartographer] Running...');
  const result = await callOpenRouterJSON(MODELS.painpoints,
    `You are the Metro Cartographer Agent. Select the BEST metro for prospecting. Optimize for density and sales efficiency. Return JSON: {selected_metro, city_core, state, rationale, estimated_target_pool, key_business_corridors[{corridor, description, landmark}], economic_signals[], incumbent_vendors[], adjacent_metros[{metro, distance, density}], local_knowledge{major_highways[], industrial_zones[], rapport_references[]}}. Be specific and local.`,
    `Solution: ${solutionData.name}\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\nVertical: ${verticalData.selected_vertical}\nStructural Fit: ${verticalData.structural_fit || ''}${geoInstruction}\nSearch web for density data and corridors.`,
    0.3, { webSearch: true, maxTokens: 3000 });
  console.log(`[Metro Cartographer] Selected: ${result.selected_metro}`);
  return result;
}

// --- ACCOUNT PROSPECTOR AGENT (pain-informed) ---
async function runAccountProspector(solutionData, verticalData, metroData, painData, accountVolume = 10) {
  const painMap = painData.pain_map || [];
  const prospectProfile = painData.ideal_prospect_profile || {};
  const painBlock = painMap.map((p, i) =>
    `  ${i+1}. "${p.pain}" (${p.severity}) — felt by ${p.who_feels_it}\n     Signals: ${(p.observable_signals || []).join(', ')}\n     Triggers: ${(p.trigger_events || []).join(', ')}`
  ).join('\n');

  console.log(`[Account Prospector] Finding ${accountVolume} in ${metroData.selected_metro} using ${painMap.length} mapped pains...`);
  const result = await callOpenRouterJSON(MODELS.painpoints,
    `You are the Account Prospector Agent. Given a solution, vertical, metro, and DETAILED PAIN MAP, find SPECIFIC REAL COMPANIES.

USE the pain map. Check for observable signals. Reference specific pains in narratives. Pull pain_tags from mapped pains. Score higher when multiple pain signals observable. Check DISQUALIFIERS.

Rules: Every company MUST be real. Use web search. Never fabricate. Return JSON:
{
  "prospects": [{
    "id": 1, "name": "...", "website": "...", "metro": "...", "location": "...",
    "landmark": "...", "employees": "...", "phone": "...",
    "priority": 85, "priority_class": "high|medium|low",
    "who_is_this": "2-3 sentences referencing SPECIFIC pains from pain map",
    "contact_title": "...", "lead_module": "...",
    "pain_tags": ["from pain map"], "matched_pains": ["which mapped pains and why"],
    "growth_signals": ["..."], "trigger_events_detected": ["..."],
    "disqualification_risk": "..."
  }],
  "search_summary": { "total_found": 0, "high_priority": 0, "medium_priority": 0, "metros_covered": [], "verticals_represented": [] }
}`,
    `Find ${accountVolume} real companies:\n\nSOLUTION: ${solutionData.name} (${solutionData.type || ''})\nCapabilities: ${(solutionData.capabilities || []).join(', ')}\n\nVERTICAL: ${verticalData.selected_vertical}\nMETRO: ${metroData.selected_metro}\nCorridors: ${(metroData.key_business_corridors || []).map(c => c.corridor).join(', ')}\n\n=== PAIN MAP ===\n${painBlock}\n\nPROFILE: Size ${prospectProfile.company_size || '?'}, Tech ${prospectProfile.tech_maturity || 'mixed'}\nDISQUALIFIERS: ${(prospectProfile.disqualifiers || []).join(', ')}\nSEARCH HINTS: ${(painData.search_terms || []).join(', ')}\n\nScoring: 90-100 = multiple pains + trigger, 80-89 = 2+ pains + profile match, 70-79 = 1-2 inferred, 60-69 = weak signals`,
    0.4, { webSearch: true, maxTokens: 8000 });
  const prospects = result.prospects || [];
  console.log(`[Account Prospector] Found ${prospects.length} (${prospects.filter(p => p.priority_class === 'high').length} high)`);
  return result;
}

// --- PROSPECTOR ORCHESTRATOR ---
app.post('/api/prospector/run', async (req, res) => {
  try {
    const { solutionData, targetVertical, geoSeed, accountVolume } = req.body;
    if (!solutionData) return res.status(400).json({ error: 'solutionData is required' });
    const volume = Math.min(Math.max(accountVolume || 10, 1), 50);
    console.log(`[Prospector] 4-stage pipeline: vertical=${targetVertical || 'auto'}, geo=${geoSeed || 'auto'}, volume=${volume}`);

    // Stage 1: Vertical
    const verticalData = await runVerticalSelector(solutionData, targetVertical || '');
    // Stage 2: Pain Map (NEW)
    const painData = await runPainMapper(solutionData, verticalData);
    // Stage 3: Metro
    const metroData = await runMetroCartographer(solutionData, verticalData, geoSeed || '');
    // Stage 4: Prospects (pain-informed)
    const prospectData = await runAccountProspector(solutionData, verticalData, metroData, painData, volume);

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

// --- SSE STUB ---
app.get('/api/prospector/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ stage: 'error', detail: 'Use POST /api/prospector/run' })}\n\n`);
  res.end();
});

// ===== DEMO EMAIL THREAD GENERATOR =====
app.post('/api/generate-demo-thread', async (req, res) => {
  try {
    const { companyName, pain_context } = req.body;
    if (!companyName) return res.status(400).json({ error: 'companyName required' });
    const painInfo = pain_context || {};
    const messages = [
      { role: 'system', content: `Generate a realistic 4-6 email back-and-forth thread for sales demo. Include positive signals, hesitations, budget/timeline concerns, competitor reference. Format with From/To/Date/Subject headers. 400-800 words.` },
      { role: 'user', content: `Company: ${companyName}\n${painInfo.primaryLead ? 'Contact: ' + painInfo.primaryLead.title : ''}${painInfo.whoIsThis ? '\nContext: ' + painInfo.whoIsThis : ''}` }
    ];
    const thread = await callOpenRouter(MODELS.painpoints, messages, 0.7);
    res.json({ thread });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', models: MODELS, apiKeyConfigured: !!OPENROUTER_API_KEY, pipeline: 'Solution → Vertical → Pain Map → Metro → Prospects' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Lead Hydration Engine - LLM Agents               ║
╠════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  Pipeline: Solution → Vertical → Pain Map → Metro → Find   ║
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
