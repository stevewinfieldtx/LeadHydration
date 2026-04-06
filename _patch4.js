// Patch: Replace showProspects function by finding its boundaries
const fs = require('fs');
const file = 'C:\\Users\\steve\\Documents\\LeadHydration\\public\\prospect.html';
let c = fs.readFileSync(file, 'utf8');

// Find start and end of showProspects
const start = c.indexOf('function showProspects()');
const afterStart = c.indexOf('\n}', start);
// Find the closing brace - need to count braces
let braceCount = 0;
let funcEnd = -1;
for (let i = start; i < c.length; i++) {
    if (c[i] === '{') braceCount++;
    if (c[i] === '}') { braceCount--; if (braceCount === 0) { funcEnd = i + 1; break; } }
}

if (start === -1 || funcEnd === -1) { console.log('ERROR: Could not find function boundaries'); process.exit(1); }

console.log('Found showProspects at', start, 'to', funcEnd, '(' + (funcEnd-start) + ' chars)');

const replacement = `function showProspects() {
    var prospects = prospectResults.prospects || [];

    // Export actions bar
    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">';
    html += '<h3 style="font-size:18px;font-weight:700;color:var(--text);">DISCOVERED PROSPECTS <span style="font-weight:400;color:var(--text-dim);">(' + prospects.length + ')</span></h3>';
    if (prospects.length) {
        html += '<div style="display:flex;gap:8px;">';
        html += '<button class="btn btn-sm btn-outline" onclick="exportCSV()" style="font-size:12px;">Export CSV</button>';
        html += '<button class="btn btn-sm btn-outline" onclick="emailResults()" style="font-size:12px;">Email Report</button>';
        html += '<button class="btn btn-sm" style="background:var(--cyan);color:#0a0e17;font-size:12px;" onclick="sendToHydration()">Send to Hydration</button>';
        html += '</div>';
    }
    html += '</div>';

    if (!prospects.length) { html += '<p style="color:var(--text-dim);padding:20px 0;">No prospects found. Try a different metro or broader vertical.</p>'; }
    prospects.forEach(function(p, idx) {
        var scoreClass = p.priority >= 80 ? 'score-high' : p.priority >= 60 ? 'score-med' : 'score-low';
        var scoreLabel = p.priority >= 80 ? 'HIGH FIT' : p.priority >= 60 ? 'MODERATE FIT' : 'LOW FIT';

        html += '<div class="prospect-card">';
        html += '<h4>' + p.name + ' <span class="score-badge ' + scoreClass + '">' + p.priority + ' / 100</span></h4>';
        html += '<div class="meta">' + (p.location||'') + (p.employees ? ' &middot; ' + p.employees + ' employees' : '') + (p.website ? ' &middot; <a href="' + p.website + '" target="_blank">' + p.website + '</a>' : '') + '</div>';
        html += '<div class="narrative">' + (p.who_is_this||'') + '</div>';
        html += '<div style="margin:10px 0;">' + (p.pain_tags||[]).map(function(t){return '<span class="tag tag-amber">'+t+'</span>';}).join('') + (p.contact_title ? ' <span class="tag tag-purple">' + p.contact_title + '</span>' : '') + '</div>';

        // Score justification box
        html += '<div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:8px;padding:14px;margin:12px 0;">';
        html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--locate);margin-bottom:8px;">Score Justification (' + scoreLabel + ')</div>';
        if (p.matched_pains && p.matched_pains.length) {
            html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;"><span style="color:var(--green);font-weight:600;">Matched Pains:</span> ' + p.matched_pains.join(' | ') + '</div>';
        }
        if (p.trigger_events_detected && p.trigger_events_detected.length) {
            html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;"><span style="color:var(--amber);font-weight:600;">Active Triggers:</span> ' + p.trigger_events_detected.join(', ') + '</div>';
        }
        if (p.growth_signals && p.growth_signals.length) {
            html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;"><span style="color:var(--cyan);font-weight:600;">Growth Signals:</span> ' + p.growth_signals.join(', ') + '</div>';
        }
        if (p.disqualification_risk) {
            html += '<div style="font-size:12px;color:var(--text-muted);"><span style="color:var(--red);font-weight:600;">Risk:</span> ' + p.disqualification_risk + '</div>';
        }
        if ((!p.matched_pains || !p.matched_pains.length) && (!p.trigger_events_detected || !p.trigger_events_detected.length) && (!p.growth_signals || !p.growth_signals.length)) {
            html += '<div style="font-size:12px;color:var(--text-dim);">Score based on vertical match and company profile alignment.</div>';
        }
        html += '</div>';

        // Per-card actions
        html += '<div style="display:flex;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);">';
        html += '<button class="btn btn-sm btn-outline" onclick="emailSingle(' + idx + ')" style="font-size:11px;flex:1;">Email This Lead</button>';
        html += '<button class="btn btn-sm" style="background:var(--cyan);color:#0a0e17;font-size:11px;flex:1;" onclick="hydrateOne(' + idx + ')">Send to Hydration</button>';
        html += '</div>';

        html += '</div>';
    });
    document.getElementById('resProspects').innerHTML = html;
}

// ===== ACTION FUNCTIONS =====
function exportCSV() {
    var prospects = prospectResults.prospects || [];
    if (!prospects.length) return;
    var headers = ['Name','Website','Location','Employees','Phone','Priority','Contact Title','Pain Tags','Who Is This'];
    var rows = prospects.map(function(p) {
        return [p.name, p.website||'', p.location||'', p.employees||'', p.phone||'', p.priority, p.contact_title||'', (p.pain_tags||[]).join('; '), (p.who_is_this||'').replace(/"/g,"'")].map(function(v){return '"'+v+'"';}).join(',');
    });
    var csv = headers.join(',') + '\\n' + rows.join('\\n');
    var blob = new Blob([csv], {type:'text/csv'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'prospects_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    log('Exported ' + prospects.length + ' prospects to CSV', 'ok');
}

function emailResults() {
    var prospects = prospectResults.prospects || [];
    var subject = 'Lead Hydration - ' + prospects.length + ' Prospects: ' + (verticalData.selected_vertical||'');
    var body = 'Prospect Report from Lead Hydration\\n\\nSolution: ' + solutionData.name + '\\nVertical: ' + verticalData.selected_vertical + '\\nMetro: ' + metroData.selected_metro + '\\nProspects: ' + prospects.length + '\\n\\n';
    prospects.forEach(function(p, i) {
        body += (i+1) + '. ' + p.name + ' (Score: ' + p.priority + ')\\n   ' + (p.location||'') + ' | ' + (p.website||'') + '\\n   ' + (p.who_is_this||'') + '\\n\\n';
    });
    window.open('mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body));
}

function emailSingle(idx) {
    var p = (prospectResults.prospects||[])[idx];
    if (!p) return;
    var subject = 'Prospect: ' + p.name + ' (Score ' + p.priority + ')';
    var body = 'Company: ' + p.name + '\\nLocation: ' + (p.location||'') + '\\nWebsite: ' + (p.website||'') + '\\nEmployees: ' + (p.employees||'') + '\\nScore: ' + p.priority + '/100\\nContact: ' + (p.contact_title||'') + '\\n\\n' + (p.who_is_this||'') + '\\n\\nPains: ' + (p.pain_tags||[]).join(', ');
    window.open('mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body));
}

function sendToHydration() {
    var prospects = prospectResults.prospects || [];
    if (!prospects.length) return;
    var leads = prospects.map(function(p) { return { name: p.name, url: p.website||'', address: p.location||'', employees: p.employees||'', phone: p.phone||'' }; });
    sessionStorage.setItem('prospectorLeads', JSON.stringify(leads));
    sessionStorage.setItem('prospectorSolutionUrl', document.getElementById('solUrl').value);
    window.location.href = '/hydrate.html?from=prospector';
}

function hydrateOne(idx) {
    var p = (prospectResults.prospects||[])[idx];
    if (!p) return;
    sessionStorage.setItem('prospectorLeads', JSON.stringify([{ name: p.name, url: p.website||'', address: p.location||'', employees: p.employees||'', phone: p.phone||'' }]));
    sessionStorage.setItem('prospectorSolutionUrl', document.getElementById('solUrl').value);
    window.location.href = '/hydrate.html?from=prospector';
}`;

c = c.substring(0, start) + replacement + c.substring(funcEnd);

fs.writeFileSync(file, c);
console.log('Done - showProspects replaced with score justification + action buttons');
