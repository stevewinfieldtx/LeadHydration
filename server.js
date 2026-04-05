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
  customer: process.env.OPENROUTER_MODEL_CUSTOMER || 'anthropic/claude-haiku-4.5'
};

// Helper function to call OpenRouter
async function callOpenRouter(model, messages, temperature = 0.3) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  try {
    const response = await axios.post(
      OPENROUTER_BASE_URL,
      {
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title': 'Lead Hydration Engine'
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('OpenRouter API error:', error.response?.data || error.message);
    throw new Error(`API call failed: ${error.response?.data?.error?.message || error.message}`);
  }
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

    const response = await callOpenRouter(MODELS.painpoints, messages, 0.5);

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
