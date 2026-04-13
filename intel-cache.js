/**
 * LeadHydration — Intel Cache Middleware
 * ═══════════════════════════════════════════════════════════════════
 * Cache layer wrapping agent calls with TDE intelligence cache lookups.
 * Check TDE first → use cached data if fresh → only research stale/missing → write back.
 *
 * Usage:
 *   const { intelCache } = require('./intel-cache');
 *   const cached = await intelCache.getCompany(domain);
 *   await intelCache.storeCompanySection(domain, name, 'industry', result, meta);
 */

const axios = require('axios');

const TDE_BASE_URL = process.env.TDE_BASE_URL || 'https://targeteddecomposition-production.up.railway.app';
const TDE_API_KEY = process.env.TDE_API_KEY || '';

function available() { return !!TDE_API_KEY && !!TDE_BASE_URL; }

async function tdeIntelRequest(method, path, body) {
  const opts = {
    method, url: `${TDE_BASE_URL}${path}`,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': TDE_API_KEY },
    timeout: 15000,
  };
  if (body) opts.data = body;
  const r = await axios(opts);
  return r.data;
}

function domainFromUrl(url) {
  return (url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase().trim();
}

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 120);
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPANY CACHE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function getCompany(domainOrUrl) {
  if (!available()) return { found: false, reason: 'tde_not_configured' };
  const domain = domainFromUrl(domainOrUrl);
  try {
    return await tdeIntelRequest('GET', `/intel/company/${encodeURIComponent(domain)}`);
  } catch (e) {
    console.log(`[Intel Cache] Company lookup failed for ${domain}: ${e.message}`);
    return { found: false, reason: 'lookup_error', error: e.message };
  }
}

async function storeCompanySection(domainOrUrl, companyName, section, data, meta = {}) {
  if (!available()) return { ok: false, reason: 'tde_not_configured' };
  const domain = domainFromUrl(domainOrUrl);
  try {
    const body = { company_name: companyName, website: domainOrUrl, sections: { [section]: data }, ...meta };
    const result = await tdeIntelRequest('PUT', `/intel/company/${encodeURIComponent(domain)}`, body);
    console.log(`[Intel Cache] Stored ${section} for ${domain}`);
    return result;
  } catch (e) {
    console.log(`[Intel Cache] Store failed for ${domain}:${section}: ${e.message}`);
    return { ok: false, reason: 'store_error', error: e.message };
  }
}

async function storeCompanyFull(domainOrUrl, companyName, allSections, meta = {}) {
  if (!available()) return { ok: false, reason: 'tde_not_configured' };
  const domain = domainFromUrl(domainOrUrl);
  try {
    const body = { company_name: companyName, website: domainOrUrl, sections: allSections, ...meta };
    const result = await tdeIntelRequest('PUT', `/intel/company/${encodeURIComponent(domain)}`, body);
    console.log(`[Intel Cache] Full store for ${domain} (${Object.keys(allSections).length} sections)`);
    return result;
  } catch (e) {
    console.log(`[Intel Cache] Full store failed for ${domain}: ${e.message}`);
    return { ok: false, reason: 'store_error', error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INDUSTRY CACHE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function getIndustry(industryName, solutionKey) {
  if (!available()) return { found: false, reason: 'tde_not_configured' };
  const key = slugify(industryName);
  try {
    let path = `/intel/industry/${encodeURIComponent(key)}`;
    if (solutionKey) path += `?solution_key=${encodeURIComponent(solutionKey)}`;
    return await tdeIntelRequest('GET', path);
  } catch (e) {
    console.log(`[Intel Cache] Industry lookup failed for ${key}: ${e.message}`);
    return { found: false, reason: 'lookup_error', error: e.message };
  }
}

async function storeIndustry(industryName, data, solutionPains = null) {
  if (!available()) return { ok: false, reason: 'tde_not_configured' };
  const key = slugify(industryName);
  try {
    const body = { industry_name: industryName, ...data };
    if (solutionPains) body.solution_pains = solutionPains;
    const result = await tdeIntelRequest('PUT', `/intel/industry/${encodeURIComponent(key)}`, body);
    console.log(`[Intel Cache] Industry stored: ${key}`);
    return result;
  } catch (e) {
    console.log(`[Intel Cache] Industry store failed for ${key}: ${e.message}`);
    return { ok: false, reason: 'store_error', error: e.message };
  }
}

async function storeIndustrySolutionPains(industryName, solutionKey, painPointsData) {
  if (!available()) return { ok: false, reason: 'tde_not_configured' };
  const key = slugify(industryName);
  try {
    const body = { industry_name: industryName, solution_pains: { [solutionKey]: painPointsData } };
    const result = await tdeIntelRequest('PUT', `/intel/industry/${encodeURIComponent(key)}`, body);
    console.log(`[Intel Cache] Solution pains stored: ${key} x ${solutionKey}`);
    return result;
  } catch (e) {
    console.log(`[Intel Cache] Solution pains store failed: ${e.message}`);
    return { ok: false, reason: 'store_error', error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SMART AGENT WRAPPERS — cache-first, auto-store on miss
// ═══════════════════════════════════════════════════════════════════════════

async function smartIndustryAgent(agentFn, params) {
  const domain = domainFromUrl(params.website);
  const cached = await getCompany(domain);
  if (cached.found && cached.freshness?.sections?.industry?.fresh) {
    const data = cached.sections?.industry?.data;
    if (data && data.industry) {
      console.log(`[Intel Cache] CACHE HIT: industry for ${domain} -> ${data.industry}`);
      return { ...data, _cache: 'hit', _cache_age: cached.sections.industry.researched_at };
    }
  }
  console.log(`[Intel Cache] CACHE MISS: industry for ${domain} — calling agent`);
  const result = await agentFn(params);
  await storeCompanySection(domain, params.companyName, 'industry', result, {
    industry: result.industry, sub_industry: result.subIndustry,
    sic_code: result.sicCode, naics_code: result.naicsCode,
    local_code: result.localCode, local_code_system: result.localCodeSystem,
    country: params.country, address: params.address,
    classification_confidence: result.confidence, classification_source: result.contentSource,
  });
  return { ...result, _cache: 'miss' };
}

async function smartPainPointsAgent(agentFn, params) {
  const { industry, solution } = params;
  const solutionKey = slugify(solution?.name || solution?.url || 'unknown');
  const cached = await getIndustry(industry, solutionKey);
  if (cached.found && cached.solution_pain_cache?.found && cached.solution_pain_cache?.fresh) {
    console.log(`[Intel Cache] CACHE HIT: pain points for ${industry} x ${solutionKey}`);
    return { ...cached.solution_pain_cache, _cache: 'hit' };
  }
  console.log(`[Intel Cache] CACHE MISS: pain points for ${industry} x ${solutionKey} — calling agent`);
  const result = await agentFn(params);
  await storeIndustrySolutionPains(industry, solutionKey, result);
  if (!cached.found) await storeIndustry(industry, { pain_points: result.painPoints || [] });
  return { ...result, _cache: 'miss' };
}

async function smartCompanyPainAgent(agentFn, params) {
  const domain = domainFromUrl(params.website);
  const cached = await getCompany(domain);
  if (cached.found && cached.freshness?.sections?.company_pain?.fresh) {
    const data = cached.sections?.company_pain?.data;
    if (data) {
      console.log(`[Intel Cache] CACHE HIT: company pain for ${domain}`);
      return { ...data, _cache: 'hit', _cache_age: cached.sections.company_pain.researched_at };
    }
  }
  console.log(`[Intel Cache] CACHE MISS: company pain for ${domain} — calling agent`);
  const result = await agentFn(params);
  await storeCompanySection(domain, params.companyName, 'company_pain', result);
  return { ...result, _cache: 'miss' };
}

async function smartCustomerAgent(agentFn, params) {
  const domain = domainFromUrl(params.website);
  const cached = await getCompany(domain);
  if (cached.found && cached.freshness?.sections?.customer?.fresh) {
    const data = cached.sections?.customer?.data;
    if (data) {
      console.log(`[Intel Cache] CACHE HIT: customer research for ${domain}`);
      return { ...data, _cache: 'hit' };
    }
  }
  console.log(`[Intel Cache] CACHE MISS: customer research for ${domain} — calling agent`);
  const result = await agentFn(params);
  await storeCompanySection(domain, params.companyName, 'customer', result);
  return { ...result, _cache: 'miss' };
}

async function smartCompeteAgent(agentFn, params) {
  const domain = domainFromUrl(params.website);
  const cached = await getCompany(domain);
  if (cached.found && cached.freshness?.sections?.compete?.fresh) {
    const data = cached.sections?.compete?.data;
    if (data) {
      console.log(`[Intel Cache] CACHE HIT: compete-detect for ${domain}`);
      return { ...data, _cache: 'hit' };
    }
  }
  console.log(`[Intel Cache] CACHE MISS: compete-detect for ${domain} — calling agent`);
  const result = await agentFn(params);
  await storeCompanySection(domain, params.companyName, 'compete', result);
  return { ...result, _cache: 'miss' };
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH HELPER — Pre-check all companies against cache
// ═══════════════════════════════════════════════════════════════════════════

async function batchPrecheck(companies) {
  if (!available()) return { cached: [], uncached: companies, partial: [], stats: { total: companies.length, cache_available: false } };
  const cached = [], uncached = [], partial = [];
  for (const company of companies) {
    const domain = domainFromUrl(company.website || company.url || '');
    if (!domain) { uncached.push(company); continue; }
    try {
      const result = await getCompany(domain);
      if (result.found && result.freshness?.all_fresh) cached.push({ ...company, _cached_intel: result });
      else if (result.found) partial.push({ ...company, _cached_intel: result, _stale_sections: result.freshness?.stale_sections || [] });
      else uncached.push(company);
    } catch { uncached.push(company); }
  }
  const stats = {
    total: companies.length, fully_cached: cached.length, partially_cached: partial.length,
    uncached: uncached.length, estimated_api_calls_saved: cached.length * 4,
  };
  console.log(`[Intel Cache] Batch precheck: ${stats.fully_cached} cached, ${stats.partially_cached} partial, ${stats.uncached} uncached (est. ${stats.estimated_api_calls_saved} API calls saved)`);
  return { cached, uncached, partial, stats };
}

module.exports = {
  intelCache: {
    available, getCompany, storeCompanySection, storeCompanyFull,
    getIndustry, storeIndustry, storeIndustrySolutionPains,
    smartIndustryAgent, smartPainPointsAgent, smartCompanyPainAgent, smartCustomerAgent, smartCompeteAgent,
    batchPrecheck,
  }
};
