// Patch prospect.html: remove emojis, add score justification, add action buttons
const fs = require('fs');
const file = 'C:\\Users\\steve\\Documents\\LeadHydration\\public\\prospect.html';
let c = fs.readFileSync(file, 'utf8');

// 1. Replace emoji icons with clean text throughout
c = c.replace('&#x1F50D; Solution Analyzed', 'SOLUTION ANALYZED');
c = c.replace('&#x1F3ED; Vertical', 'VERTICAL');
c = c.replace('&#x1F4CD; Metro', 'METRO');
c = c.replace('&#x1F3AF; Pain Map', 'PAIN MAP');
c = c.replace("'&#x1F3AF; Pain Map'", "'PAIN MAP'");
c = c.replace('&#x1F3E2; Discovered Prospects', 'DISCOVERED PROSPECTS');
c = c.replace('&#x270F;&#xFE0F; Review Vertical Selection', 'REVIEW VERTICAL SELECTION');
c = c.replace('&#x270F;&#xFE0F; Review Pain Map', 'REVIEW PAIN MAP');
c = c.replace('&#x270F;&#xFE0F; Review Metro Selection', 'REVIEW METRO SELECTION');
c = c.replace('&#x26D4; ', '');
c = c.replace("'&#x26D4; '", "''");
c = c.replace('&#x1F504; Re-run with override', 'Re-run with override');
c = c.replace(/&#x1F504; Re-run with override/g, 'Re-run with override');
c = c.replace('&#x26A0; User-influenced', 'USER-INFLUENCED');
c = c.replace("'&#x26A0; User-influenced'", "'USER-INFLUENCED'");

// Replace emoji in logo
c = c.replace('<div class="logo-icon">&#x1F50D;</div>', '<div class="logo-icon" style="font-size:14px;font-weight:800;color:#0a0e17;">LH</div>');

// Replace section header emojis in the result display functions
c = c.replace("'&#x1F50D; Solution Analyzed'", "'SOLUTION ANALYZED'");
c = c.replace("'&#x1F3ED; Vertical'", "'VERTICAL'");
c = c.replace("'&#x1F4CD; Metro'", "'METRO'");
c = c.replace("'&#x1F3E2; Discovered Prospects", "'DISCOVERED PROSPECTS");

// Kill the contact_title emoji
c = c.replace(/&#x1F464; /g, '');

// 2. Replace showProspects function with enhanced version including score justification and actions
const oldShowProspects = `function showProspects() {
    var prospects = prospectResults.prospects || [];
    var html = '<h3 style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:16px;">&#x1F3E2; Discovered Prospects <span style="font-weight:400;color:var(--text-dim);">(' + prospects.length + ')</span></h3>';
    if (!prospects.length) { html += '<p style="color:var(--text-dim);padding:20px 0;">No prospects found. Try a different metro or broader vertical.</p>'; }
    prospects.forEach(function(p) {
        var scoreClass = p.priority >= 80 ? 'score-high' : p.priority >= 60 ? 'score-med' : 'score-low';
        html += '<div class="prospect-card">';
        html += '<h4>' + p.name + ' <span class="score-badge ' + scoreClass + '">' + p.priority + '</span></h4>';
        html += '<div class="meta">' + (p.location||'') + (p.employees ? ' &#xB7; ' + p.employees + ' employees' : '') + (p.website ? ' &#xB7; <a href="' + p.website + '" target="_blank">' + p.website + '</a>' : '') + '</div>';
        html += '<div class="narrative">' + (p.who_is_this||'') + '</div>';
        html += '<div>' + (p.pain_tags||[]).map(function(t){return '<span class="tag tag-amber">'+t+'</span>';}).join('') + (p.contact_title ? ' <span class="tag tag-purple">&#x1F464; ' + p.contact_title + '</span>' : '') + '</div>';
        if (p.matched_pains && p.matched_pains.length) html += '<div style="margin-top:8px;font-size:12px;color:var(--text-dim);"><strong>Matched pains:</strong> ' + p.matched_pains.join(' | ') + '</div>';
        if (p.trigger_events_detected && p.trigger_events_detected.length) html += '<div style="margin-top:4px;font-size:12px;color:var(--amber);"><strong>Active triggers:</strong> ' + p.trigger_events_detected.join(', ') + '</div>';
        html += '</div>';
    });
    document.getElementById('resProspects').innerHTML = html;
}`;

const newShowProspects = `function showProspects() {
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

        // Header with score
        html += '<h4>' + p.name + ' <span class="score-badge ' + scoreClass + '">' + p.priority + ' / 100</span></h4>';
        html += '<div class="meta">' + (p.location||'') + (p.employees ? ' &middot; ' + p.employees + ' employees' : '') + (p.website ? ' &middot; <a href="' + p.website + '" target="_blank">' + p.website + '</a>' : '') + '</div>';

        // Narrative
        html += '<div class="narrative">' + (p.who_is_this||'') + '</div>';

        // Pain tags + contact
        html += '<div style="margin:10px 0;">' + (p.pain_tags||[]).map(function(t){return \'<span class="tag tag-amber">\'+t+\'</span>\';}).join(\'\') + (p.contact_title ? \' <span class="tag tag-purple">\' + p.contact_title + \'</span>\' : \'\') + \'</div>\';

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
        html += '<button class="btn btn-sm btn-outline" onclick="emailSingle(' + idx + ')" style="font-size:11px;flex:1;">Email</button>';
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
    a.download = 'prospects_' + (verticalData.selected_vertical||'leads').replace(/[^a-z0-9]/gi,'_') + '_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    log('Exported ' + prospects.length + ' prospects to CSV', 'ok');
}

function emailResults() {
    var prospects = prospectResults.prospects || [];
    var subject = 'Lead Hydration - ' + prospects.length + ' Prospects Found: ' + (verticalData.selected_vertical||'');
    var body = 'Prospect report from Lead Hydration\\n\\n';
    body += 'Solution: ' + solutionData.name + '\\n';
    body += 'Vertical: ' + verticalData.selected_vertical + '\\n';
    body += 'Metro: ' + metroData.selected_metro + '\\n';
    body += 'Prospects found: ' + prospects.length + '\\n\\n';
    prospects.forEach(function(p, i) {
        body += (i+1) + '. ' + p.name + ' (Score: ' + p.priority + ')\\n';
        body += '   ' + (p.location||'') + ' | ' + (p.website||'') + '\\n';
        body += '   ' + (p.who_is_this||'') + '\\n\\n';
    });
    window.open('mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body));
    log('Opened email client with report', 'ok');
}

function emailSingle(idx) {
    var p = (prospectResults.prospects||[])[idx];
    if (!p) return;
    var subject = 'Prospect: ' + p.name + ' (Score ' + p.priority + ') - ' + solutionData.name;
    var body = 'Prospect Intelligence Card\\n\\n';
    body += 'Company: ' + p.name + '\\n';
    body += 'Location: ' + (p.location||'') + '\\n';
    body += 'Website: ' + (p.website||'') + '\\n';
    body += 'Employees: ' + (p.employees||'') + '\\n';
    body += 'Score: ' + p.priority + '/100\\n';
    body += 'Contact: ' + (p.contact_title||'') + '\\n\\n';
    body += 'About: ' + (p.who_is_this||'') + '\\n\\n';
    body += 'Pain Tags: ' + (p.pain_tags||[]).join(', ') + '\\n';
    if (p.matched_pains) body += 'Matched Pains: ' + p.matched_pains.join(' | ') + '\\n';
    if (p.trigger_events_detected) body += 'Active Triggers: ' + p.trigger_events_detected.join(', ') + '\\n';
    window.open('mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body));
}

function sendToHydration() {
    var prospects = prospectResults.prospects || [];
    if (!prospects.length) return;
    // Store prospects in sessionStorage so hydrate.html can pick them up
    var leads = prospects.map(function(p) {
        return { name: p.name, url: p.website||'', address: p.location||'', employees: p.employees||'', phone: p.phone||'' };
    });
    sessionStorage.setItem('prospectorLeads', JSON.stringify(leads));
    sessionStorage.setItem('prospectorSolutionUrl', document.getElementById('solUrl').value);
    window.location.href = '/hydrate.html?from=prospector';
    log('Sending ' + leads.length + ' leads to Hydration...', 'ok');
}

function hydrateOne(idx) {
    var p = (prospectResults.prospects||[])[idx];
    if (!p) return;
    sessionStorage.setItem('prospectorLeads', JSON.stringify([{ name: p.name, url: p.website||'', address: p.location||'', employees: p.employees||'', phone: p.phone||'' }]));
    sessionStorage.setItem('prospectorSolutionUrl', document.getElementById('solUrl').value);
    window.location.href = '/hydrate.html?from=prospector';
}`;

if (c.includes(oldShowProspects)) {
    c = c.replace(oldShowProspects, newShowProspects);
    console.log('showProspects replaced with enhanced version');
} else {
    console.log('ERROR: Could not find showProspects to replace');
    // Try to find it
    var idx = c.indexOf('function showProspects');
    console.log('showProspects found at char index:', idx);
}

fs.writeFileSync(file, c);
console.log('Patch complete');
