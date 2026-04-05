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
// ===== CLEARSIGNALS AI & FLIGHT ATTENDANT CALL BELL ENDPOINTS (NEW) =====
// ============================================================================

// 1. Create a ClearSignals Coaching Session
// Generates a short-lived session token for the embedded widget
// Per ClearSignals API spec: POST /v1/sessions with lead context
app.post('/api/coaching-session', async (req, res) => {
    const { companyName, contactName, contactTitle, contactEmail, dealValue, stage } = req.body;
    
    if (!CLEARSIGNALS_VENDOR_KEY) {
        return res.status(500).json({ error: 'CLEARSIGNALS_VENDOR_KEY not configured in .env' });
    }

    try {
        const payload = {
            lead: {
                company: companyName || 'Unknown Prospect',
                contact_name: contactName || null,
                contact_title: contactTitle || null,
                contact_email: contactEmail || null,
                estimated_value: dealValue || null,
                stage: stage || 'Discovery'
            },
            ttl_seconds: 3600
        };

        const headers = {
            'Content-Type': 'application/json',
            'X-CS-Vendor-Key': CLEARSIGNALS_VENDOR_KEY
        };

        // Add HMAC-SHA256 signature if secret is configured
        if (CLEARSIGNALS_SECRET) {
            const crypto = require('crypto');
            const timestamp = new Date().toISOString();
            const bodyStr = JSON.stringify(payload);
            const signature = crypto
                .createHmac('sha256', CLEARSIGNALS_SECRET)
                .update(timestamp + '.' + bodyStr)
                .digest('hex');
            headers['X-CS-Timestamp'] = timestamp;
            headers['X-CS-Signature'] = signature;
        }

        console.log(`[ClearSignals] Creating session for: ${companyName}`);
        const response = await axios.post(
            'https://api.clearsignals.ai/api/v1/sessions',
            payload,
            { headers }
        );

        console.log(`[ClearSignals] Session created, expires: ${response.data.expires_at}`);
        res.json({ session_token: response.data.session_token });
    } catch (error) {
        const errData = error.response?.data;
        console.error('[ClearSignals Auth Error]:', errData || error.message);
        
        // Return structured error from ClearSignals if available
        if (errData?.error) {
            return res.status(error.response.status || 500).json({ 
                error: errData.error.message || 'ClearSignals API error',
                code: errData.error.code 
            });
        }
        res.status(500).json({ error: 'Failed to create ClearSignals session' });
    }
});

// 1b. Proxy Thread Analysis to ClearSignals
// Frontend sends thread + session token -> we forward to ClearSignals /v1/analyze
app.post('/api/coaching-analyze', async (req, res) => {
    const { session_token, thread_text } = req.body;

    if (!session_token || !thread_text) {
        return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'session_token and thread_text are required' } });
    }

    try {
        console.log(`[ClearSignals] Analyzing thread (${thread_text.length} chars)...`);
        const response = await axios.post(
            'https://api.clearsignals.ai/api/v1/analyze',
            {
                thread_text: thread_text,
                options: {
                    include_coaching: true,
                    include_company_research: true,
                    include_industry_research: true
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-CS-Session-Token': session_token
                },
                timeout: 60000 // 60s — analysis can take 15-30s
            }
        );

        console.log(`[ClearSignals] Analysis complete: ${response.data.analysis_id}`);
        res.json(response.data);
    } catch (error) {
        const errData = error.response?.data;
        console.error('[ClearSignals Analyze Error]:', errData || error.message);

        if (errData?.error) {
            return res.status(error.response.status || 500).json(errData);
        }
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to analyze thread: ' + error.message } });
    }
});

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
  "painIndicators": ["<specific pain chip 1>", "<specific pain chip 2>", "<specific pain chip 3>", "<specific pain chip 4>"],
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
  "extraBackground": "<2-3 sentences of extra company context: region, company culture, industry dynamics, or recent trends that help the seller prepare>",
  "emailTemplate": {
    "subject": "<compelling email subject line personalized to this company>",
    "body": "<full cold outreach email body — 3-4 short paragraphs, professional, references their specific industry/pain, ends with soft CTA>"
  }
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
Pain indicators should be 2-4 word chips (e.g. "Manual Production Scheduling").
The email template should be a real cold outreach email ready to send, personalized to this company.
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
