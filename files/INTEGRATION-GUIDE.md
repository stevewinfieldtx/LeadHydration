# Intel Cache Integration Guide
## Stop re-researching the same companies and industries

### Files Created
1. **TDE:** `src/routes/intel-cache-routes.js` — New Express routes for company/industry intelligence cache
2. **LeadHydration:** `intel-cache.js` — Cache middleware with smart agent wrappers

---

## Step 1: TDE Server — Mount the Cache Routes

Copy `intel-cache-routes.js` to `C:\Users\steve\Documents\Targeted_Deconstruction\src\routes\intel-cache-routes.js`

Then add these 2 lines to `src/server.js`, right after the health endpoint (~line 175):

```javascript
// ── Intel Cache (Company + Industry Knowledge Persistence) ──────────────
require('./routes/intel-cache-routes')(app, auth, engine.store.pg);
```

That's it for TDE. The route file auto-creates the PostgreSQL tables on startup.

### Optional: Set custom TTL via environment variable
```
INTEL_TTL_DAYS=30   # default, change if needed
```

---

## Step 2: LeadHydration — Add Cache Middleware

Copy `intel-cache.js` to `C:\Users\steve\Documents\LeadHydration\intel-cache.js`

Add this require at the top of `server.js` (around line 5):

```javascript
const { intelCache } = require('./intel-cache');
```

---

## Step 3: Wire Cache into Agent Endpoints

### 3a. Industry Agent (line ~722)

**BEFORE** (current — always researches):
```javascript
app.post('/api/agent/industry', async (req, res) => {
  try {
    const { companyName, website, address, country, skipSignalScan } = req.body;
    // ... 150 lines of research ...
    res.json(industryData);
```

**AFTER** (cache-first):
```javascript
app.post('/api/agent/industry', async (req, res) => {
  try {
    const { companyName, website, address, country, skipSignalScan } = req.body;
    
    if (!companyName || !website) {
      return res.status(400).json({ error: 'Company name and website are required' });
    }

    // ── CACHE CHECK ──────────────────────────────────────────────────
    const result = await intelCache.smartIndustryAgent(
      async (params) => {
        // This is your EXISTING agent logic (the ~140 lines currently in this endpoint)
        // Move it into this function body, or extract to a helper:
        return await runIndustryAgent(params);
      },
      { companyName, website, address, country, skipSignalScan }
    );

    if (result._cache === 'hit') {
      console.log(`[Industry Agent] CACHE HIT for ${companyName} — skipped all API calls`);
    }
    res.json(result);
```

### 3b. Pain Points Agent (line ~1126)

This is the BIGGEST win. Pain points for "Discrete Manufacturing + SAP Business One" are
identical across ALL 417 companies in that industry. Research once, serve 416 times from cache.

**AFTER:**
```javascript
app.post('/api/agent/painpoints', async (req, res) => {
  try {
    const { industry, solution } = req.body;
    
    if (!industry || !solution) {
      return res.status(400).json({ error: 'Industry and solution data are required' });
    }

    // ── CACHE CHECK — industry × solution combo ─────────────────────
    const result = await intelCache.smartPainPointsAgent(
      async (params) => {
        // Your existing pain points agent logic goes here
        return await runPainPointsAgent(params);
      },
      { industry, solution }
    );

    if (result._cache === 'hit') {
      console.log(`[Pain Point Agent] CACHE HIT for ${industry} — 0 API calls`);
    }
    res.json(result);
```

### 3c. Company Pain Agent (line ~1604)

```javascript
app.post('/api/agent/company-pain', async (req, res) => {
  try {
    const { companyName, website, address, industry, solution, lang, tier } = req.body;

    // ── CACHE CHECK ──────────────────────────────────────────────────
    const result = await intelCache.smartCompanyPainAgent(
      async (params) => {
        return await runCompanyPainAgent(params);
      },
      { companyName, website, address, industry, solution, lang, tier }
    );

    if (result._cache === 'hit') {
      console.log(`[Company Pain Agent] CACHE HIT for ${companyName}`);
    }
    res.json(result);
```

---

## Step 4: Add Batch Pre-Check (Optional but Powerful)

If you have a batch endpoint that processes multiple companies, add this
at the top to skip fully-cached companies entirely:

```javascript
app.post('/api/batch/hydrate', async (req, res) => {
  const { companies, solution } = req.body;
  
  // Pre-check ALL companies against cache in one pass
  const { cached, uncached, partial, stats } = await intelCache.batchPrecheck(companies);
  
  console.log(`[Batch] ${stats.fully_cached} fully cached, ${stats.uncached} need research`);
  console.log(`[Batch] Estimated ${stats.estimated_api_calls_saved} API calls saved`);
  
  // Process only uncached + partial companies through the agent pipeline
  // Cached companies already have all their data
  const results = [
    ...cached.map(c => ({ ...c, status: 'from_cache', data: c._cached_intel.sections })),
  ];
  
  for (const company of [...uncached, ...partial]) {
    // Run normal hydration pipeline — the smart agents will cache results
    const result = await hydrateCompany(company, solution);
    results.push(result);
  }
  
  res.json({ results, stats });
});
```

---

## API Reference — TDE Intel Cache Endpoints

### Company Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/intel/company/:domain` | Lookup company. Returns freshness per section |
| `GET` | `/intel/company/:domain?sections=industry,painpoints` | Lookup with section filter |
| `PUT` | `/intel/company/:domain` | Store/update company intel |
| `GET` | `/intel/company` | List all cached companies |
| `GET` | `/intel/company?industry=Manufacturing&country=DE&stale=true` | Filter companies |

### Industry Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/intel/industry/:key` | Lookup industry intel |
| `GET` | `/intel/industry/:key?solution_key=sap-b1` | Check solution-pain cache |
| `PUT` | `/intel/industry/:key` | Store/update industry intel |
| `GET` | `/intel/industry` | List all cached industries |

### Management Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/intel/stats` | Cache statistics dashboard |
| `POST` | `/intel/invalidate` | Force-expire a record |

### Invalidate Examples

```bash
# Invalidate entire company
curl -X POST /intel/invalidate -d '{"type":"company","domain":"example.de"}'

# Invalidate just the contacts section (force re-research)
curl -X POST /intel/invalidate -d '{"type":"company","domain":"example.de","section":"contacts"}'

# Invalidate an industry
curl -X POST /intel/invalidate -d '{"type":"industry","key":"discrete-manufacturing"}'
```

---

## What This Saves — Your 417 COSIB Companies

| Agent Call | Without Cache | With Cache | Savings |
|------------|--------------|------------|---------|
| Industry classification | 417 × 30 = **12,510** | 417 × 1 = **417** | **96.7%** |
| Pain points (industry × solution) | 417 × 30 = **12,510** | **1** (same industry!) | **99.99%** |
| Company pain | 417 × 30 = **12,510** | 417 × 1 = **417** | **96.7%** |
| Compete-detect | 417 × 30 = **12,510** | 417 × 1 = **417** | **96.7%** |
| **TOTAL** | **~50,000** | **~1,252** | **97.5%** |

The pain points line is the killer: because ALL 417 companies are in the same
industry buying the same solution, that research happens ONCE and serves
all 417 companies × all 30 runs from cache.

---

## Environment Variables

### TDE (add to Railway if not set)
```
INTEL_TTL_DAYS=30          # Cache TTL in days (default: 30)
```

### LeadHydration (already configured)
```
TDE_BASE_URL=https://targeteddecomposition-production.up.railway.app
TDE_API_KEY=<your key>
```

---

## Future: Phase 2 — Monitoring Agents

Once this cache is populated and running, the next step is monitoring agents that:
1. Watch RSS/news feeds for companies in `company_intel`
2. Watch regulatory feeds for industries in `industry_intel`
3. Auto-invalidate records when breaking news is detected
4. Log observations to the industry `observations` JSONB array

This is a separate build — the cache alone solves the immediate 97.5% waste problem.
