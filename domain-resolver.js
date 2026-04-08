/**
 * COSIB Lead Domain Resolver
 * ─────────────────────────────────────────────
 * Takes the raw partner list and resolves/validates all domains.
 * - If Final Domain exists and is NOT forsaledomain.net → use it
 * - If Final Domain is forsaledomain.net → domain is dead, search by name+city
 * - If no Final Domain → try http/https with/without www
 * - If all fail → search company name + city via web
 * 
 * Usage: node domain-resolver.js [input.tsv] [output.tsv]
 * Default: cosib_leads.tsv → cosib_leads_resolved.tsv
 */

const axios = require('axios');
const fs = require('fs');

const INPUT_FILE = process.argv[2] || 'cosib_leads.tsv';
const OUTPUT_FILE = process.argv[3] || 'cosib_leads_resolved.tsv';

const DEAD_DOMAINS = ['forsaledomain.net', 'forsaledomain.com', 'parked.com', 'sedoparking.com', 'hier-im-netz.de', 'chayns.site', 'odoo.com', 'banggood.com'];

// ── Try a URL and see if it resolves ──
async function tryUrl(url, timeout = 8000) {
  try {
    const resp = await axios.get(url, {
      timeout,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: (s) => s < 500,
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || url;
    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    
    if (DEAD_DOMAINS.some(d => host.includes(d))) {
      return { alive: false, url: finalUrl, reason: 'parked_domain' };
    }
    
    const bodyLen = (typeof resp.data === 'string' ? resp.data : '').length;
    if (bodyLen < 200) {
      return { alive: false, url: finalUrl, reason: 'empty_page' };
    }
    
    return { alive: true, url: finalUrl, finalHost: host, status: resp.status };
  } catch (err) {
    return { alive: false, url, reason: err.code || err.message };
  }
}

// ── Resolve a domain by trying multiple URL patterns ──
async function resolveDomain(domain) {
  if (!domain) return null;
  
  const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  
  const variants = [
    `https://${clean}`,
    `https://www.${clean}`,
    `http://${clean}`,
    `http://www.${clean}`,
  ];
  
  for (const url of variants) {
    const result = await tryUrl(url);
    if (result.alive) return { resolved: result.finalHost || clean, url: result.url, method: 'direct' };
  }
  
  return null;
}

// ── Search for a company by name + city using DuckDuckGo ──
async function searchForDomain(companyName, city) {
  try {
    const query = encodeURIComponent(`${companyName} ${city || ''} Germany`);
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
          const check = await tryUrl(`https://${host}`, 5000);
          if (check.alive) return { resolved: host, url: `https://${host}`, method: 'search' };
        }
      } catch {}
    }
  } catch (err) {
    console.log(`  [Search] Failed for "${companyName}": ${err.message}`);
  }
  return null;
}

// ── Main ──
async function main() {
  console.log(`\n🔍 COSIB Lead Domain Resolver`);
  console.log(`   Input:  ${INPUT_FILE}`);
  console.log(`   Output: ${OUTPUT_FILE}\n`);
  
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ File not found: ${INPUT_FILE}`);
    process.exit(1);
  }
  
  const raw = fs.readFileSync(INPUT_FILE, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const headers = lines[0].split('\t');
  
  const colMap = {};
  headers.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (key.includes('company') && !key.includes('domain')) colMap.company = i;
    if (key === 'company domain' || key === 'companydomain') colMap.domain = i;
    if (key === 'final domain' || key === 'finaldomain') colMap.final = i;
    if (key === 'city') colMap.city = i;
    if (key.includes('propensity') || key.includes('manufacturing')) colMap.propensity = i;
  });
  
  console.log(`📋 Found ${lines.length - 1} companies`);
  console.log(`   Columns: company=${colMap.company}, domain=${colMap.domain}, final=${colMap.final}, city=${colMap.city}\n`);
  
  const results = [];
  let resolved = 0, dead = 0, searched = 0, failed = 0;
  
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const company = (cols[colMap.company] || '').trim();
    const domain = (cols[colMap.domain] || '').trim();
    const finalDomain = (cols[colMap.final] || '').trim();
    const city = (cols[colMap.city] || '').trim();
    const propensity = (cols[colMap.propensity] || '').trim();
    
    if (!company) continue;
    
    process.stdout.write(`  [${i}/${lines.length-1}] ${company.substring(0,45).padEnd(45)}`);
    
    let resolvedDomain = '';
    let status = '';
    
    // Case 1: Final Domain exists and is a REAL domain (not parked/dead)
    if (finalDomain && !DEAD_DOMAINS.some(d => finalDomain.includes(d))) {
      const check = await resolveDomain(finalDomain);
      if (check) {
        resolvedDomain = check.resolved;
        status = 'FINAL_VERIFIED';
        resolved++;
      } else {
        // Final domain didn't resolve, try original
        const origCheck = await resolveDomain(domain);
        if (origCheck) {
          resolvedDomain = origCheck.resolved;
          status = 'ORIGINAL_VERIFIED';
          resolved++;
        } else {
          // Both failed, try search
          const searchResult = await searchForDomain(company, city);
          if (searchResult) {
            resolvedDomain = searchResult.resolved;
            status = 'SEARCHED';
            searched++;
          } else {
            status = 'FAILED';
            failed++;
          }
        }
      }
    }
    // Case 2: Final Domain is a dead/parked domain
    else if (finalDomain && DEAD_DOMAINS.some(d => finalDomain.includes(d))) {
      const searchResult = await searchForDomain(company, city);
      if (searchResult) {
        resolvedDomain = searchResult.resolved;
        status = 'DEAD_SEARCHED';
        searched++;
      } else {
        resolvedDomain = '';
        status = 'DEAD';
        dead++;
      }
    }
    // Case 3: No Final Domain — try original domain first
    else {
      const check = await resolveDomain(domain);
      if (check) {
        resolvedDomain = check.resolved;
        status = 'RESOLVED';
        resolved++;
      } else {
        const searchResult = await searchForDomain(company, city);
        if (searchResult) {
          resolvedDomain = searchResult.resolved;
          status = 'SEARCHED';
          searched++;
        } else {
          resolvedDomain = '';
          status = 'FAILED';
          failed++;
        }
      }
    }
    
    console.log(` → ${status.padEnd(18)} ${resolvedDomain || '(none)'}`);
    
    results.push({
      company, originalDomain: domain, finalDomain, resolvedDomain,
      status, city, propensity
    });
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Write output as TSV
  const outHeaders = 'Company Name\tWebsite\tDomain_Status\tOriginal_Domain\tFinal_Domain\tLocation\tManufacturing_Propensity\n';
  const outRows = results.map(r => 
    `${r.company}\t${r.resolvedDomain}\t${r.status}\t${r.originalDomain}\t${r.finalDomain}\t${r.city}, North Rhine-Westphalia, Germany\t${r.propensity}`
  ).join('\n');
  
  fs.writeFileSync(OUTPUT_FILE, outHeaders + outRows, 'utf8');
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Resolved: ${resolved}`);
  console.log(`🔍 Found via search: ${searched}`);
  console.log(`💀 Dead/parked: ${dead}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📄 Output: ${OUTPUT_FILE}`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(console.error);
