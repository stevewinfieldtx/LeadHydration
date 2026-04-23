# Lead Hydration Engine - Multi-Agent LLM System

A multi-agent system that uses different LLM models via OpenRouter to research solutions, detect industries, and map pain points.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    LEAD HYDRATION ENGINE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │  SOLUTION AGENT │───→│  INDUSTRY AGENT │───→│  PAIN AGENT │ │
│  │                 │    │                 │    │             │ │
│  │ Model:          │    │ Model:          │    │ Model:      │ │
│  │ OPENROUTER_     │    │ OPENROUTER_     │    │ OPENROUTER_ │ │
│  │ MODEL_SOLUTION  │    │ MODEL_INDUSTRY  │    │ MODEL_PAIN  │ │
│  └─────────────────┘    └─────────────────┘    │ POINTS      │ │
│                                                 └─────────────┘ │
│                                                        │        │
│  ┌─────────────────┐                                   │        │
│  │ CUSTOMER AGENT  │←──────────────────────────────────┘        │
│  │                 │                                            │
│  │ Model:          │                                            │
│  │ OPENROUTER_     │                                            │
│  │ MODEL_CUSTOMER  │                                            │
│  └─────────────────┘                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required: Get your API key from https://openrouter.ai/keys
OPENROUTER_API_KEY=your_api_key_here

# Optional: Configure different models for each agent
# See available models at https://openrouter.ai/models

# Solution Research Agent - Analyzes solution URLs
OPENROUTER_MODEL_SOLUTION=anthropic/claude-3.5-sonnet

# Industry Detection Agent - Determines company industries  
OPENROUTER_MODEL_INDUSTRY=anthropic/claude-3.5-sonnet

# Pain Point Mapping Agent - Maps solutions to industry pain points
OPENROUTER_MODEL_PAINPOINTS=anthropic/claude-3.5-sonnet

# Customer Research Agent - Researches individual companies
OPENROUTER_MODEL_CUSTOMER=anthropic/claude-3.5-sonnet
```

### 3. Start the Server

```bash
npm start
```

The server will start on port 3000 (or the PORT specified in .env).

## Usage

1. Open http://localhost:3000 in your browser
2. Enter a **Solution URL** (e.g., https://www.sap.com/products/erp/business-one.html)
3. Upload a **CSV file** or paste a customer list with format: `Company Name, Website URL, Address (optional)`
4. Click **"Deploy LLM Agents"**
5. Watch the agents work in real-time
6. Export results as JSON

## API Endpoints

### Solution Agent
```http
POST /api/agent/solution
Content-Type: application/json

{
  "url": "https://www.example.com"
}
```

### Industry Agent
```http
POST /api/agent/industry
Content-Type: application/json

{
  "companyName": "Acme Corp",
  "website": "https://acme.com",
  "address": "123 Main St"
}
```

### Pain Point Agent
```http
POST /api/agent/painpoints
Content-Type: application/json

{
  "industry": "Manufacturing",
  "solution": {
    "name": "SAP Business One",
    "type": "ERP Software",
    "capabilities": ["Financial Management", "Inventory Control"]
  }
}
```

### Customer Research Agent
```http
POST /api/agent/customer
Content-Type: application/json

{
  "companyName": "Acme Corp",
  "website": "https://acme.com",
  "address": "123 Main St"
}
```

### Health Check
```http
GET /api/health
```

## Model Recommendations

You can use different models for different agents based on your needs:

| Agent | Recommended Models | Cost/Speed |
|-------|-------------------|------------|
| Solution | `anthropic/claude-3.5-sonnet`, `openai/gpt-4o` | Higher quality |
| Industry | `openai/gpt-4o-mini`, `anthropic/claude-3-haiku` | Faster, cheaper |
| Pain Points | `anthropic/claude-3.5-sonnet` | Higher quality |
| Customer | `openai/gpt-4o-mini` | Fast, cost-effective |

## Cost Estimation

Approximate costs per 100 leads (using Claude 3.5 Sonnet at ~$3/M tokens):

- Solution Agent: ~$0.05 (1 call)
- Industry Agents: ~$1.00 (100 calls)
- Pain Point Agents: ~$0.50 (5-10 unique industries)
- **Total: ~$1.55 per 100 leads**

Using cheaper models (GPT-4o-mini) can reduce costs to ~$0.30 per 100 leads.

## Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key | Required |
| `OPENROUTER_MODEL_SOLUTION` | Model for solution research | `anthropic/claude-3.5-sonnet` |
| `OPENROUTER_MODEL_INDUSTRY` | Model for industry detection | `anthropic/claude-3.5-sonnet` |
| `OPENROUTER_MODEL_PAINPOINTS` | Model for pain point mapping | `anthropic/claude-3.5-sonnet` |
| `OPENROUTER_MODEL_CUSTOMER` | Model for customer research | `anthropic/claude-3.5-sonnet` |
| `APP_URL` | Your app URL for OpenRouter analytics | `http://localhost:3000` |
| `PORT` | Server port | `3000` |

## Troubleshooting

### "OPENROUTER_API_KEY not configured"
- Make sure you've created a `.env` file
- Verify your API key is correct at https://openrouter.ai/keys

### API rate limits
- OpenRouter has rate limits based on your tier
- The system processes companies in batches to avoid hitting limits
- Add delays between calls if needed

### Model not found
- Check available models at https://openrouter.ai/models
- Ensure the model name matches exactly (case-sensitive)
# LeadHydration
