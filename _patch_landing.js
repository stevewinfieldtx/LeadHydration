const fs = require('fs');
const file = 'C:\\Users\\steve\\Documents\\LeadHydration\\public\\index.html';
let c = fs.readFileSync(file, 'utf8');

// Replace the stats section with Brain Trust Brief branding
const oldStats = `<div class="stats">
        <div class="stat"><div class="stat-value">6</div><div class="stat-label">AI Agents</div></div>
        <div class="stat"><div class="stat-value">4</div><div class="stat-label">Pipeline Stages</div></div>
        <div class="stat"><div class="stat-value">&lt;3min</div><div class="stat-label">Per Company</div></div>
        <div class="stat"><div class="stat-value">100%</div><div class="stat-label">Real Companies</div></div>
    </div>`;

const newStats = `<div style="text-align:center;padding:48px 0 20px;border-top:1px solid var(--border);animation:fadeUp 1.2s ease-out 0.4s both;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;">Intelligence Engine</div>
        <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;margin-bottom:8px;">Powered by <span style="color:var(--locate);">Brain Trust Brief</span></div>
        <p style="font-size:14px;color:var(--text-dim);max-width:480px;margin:0 auto;line-height:1.7;">Expert advisory panels debate every recommendation. Three AI advisors analyze, disagree, and reach consensus — so you see the reasoning, not just the answer.</p>
    </div>
    <div class="stats" style="border-top:none;padding-top:24px;">
        <div class="stat"><div class="stat-value">3</div><div class="stat-label">Advisors Per Stage</div></div>
        <div class="stat"><div class="stat-value">4</div><div class="stat-label">Pipeline Stages</div></div>
        <div class="stat"><div class="stat-value">12</div><div class="stat-label">Expert Perspectives</div></div>
        <div class="stat"><div class="stat-value">1</div><div class="stat-label">Consensus Brief</div></div>
    </div>`;

if (c.includes(oldStats)) {
    c = c.replace(oldStats, newStats);
    console.log('Stats replaced with Brain Trust Brief branding');
} else {
    console.log('ERROR: Could not find stats section');
}

fs.writeFileSync(file, c);
