// Patch: Replace deploy buttons with Hydrate/Find split
const fs = require('fs');
const file = 'C:\\Users\\steve\\Documents\\LeadHydration\\public\\index.html';
let content = fs.readFileSync(file, 'utf8');

// Find and replace the button group
const oldBtns = `                    <div class="btn-group">
                        <button class="btn btn-primary" id="startBtn" onclick="startAgentPipeline()">\u{1F680} Deploy LLM Agents</button>
                        <button class="btn" style="background:#605E5C;color:white;" onclick="loadDemoTemplate()">\u{1F4CB} Load Demo Template (10 Companies)</button>
                    </div>`;

const newBtns = `                    <div class="btn-group">
                        <button class="btn btn-primary" id="startBtn" onclick="startAgentPipeline()" style="flex:1;justify-content:center;padding:14px 24px;font-size:15px;">\u{1F4A7} Hydrate My Leads</button>
                        <button class="btn" style="background:#605E5C;color:white;" onclick="loadDemoTemplate()">\u{1F4CB} Load Demo (10 Companies)</button>
                    </div>
                    <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
                        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">Don\u2019t have leads yet?</p>
                        <a href="/prospect.html" class="btn" style="background:#8764B8;color:white;padding:12px 28px;font-size:14px;text-decoration:none;border-radius:4px;">\u{1F50D} Find New Leads Instead</a>
                    </div>`;

if (content.includes(oldBtns)) {
    content = content.replace(oldBtns, newBtns);
    console.log('Buttons replaced');
} else {
    console.log('Could not find button text - checking...');
    // Show what's actually there around btn-group
    const idx = content.indexOf('btn-group');
    if (idx > -1) console.log('Found btn-group at char ' + idx + ': ' + content.substring(idx-50, idx+200));
}

// Also fix the reset function that references removed elements
content = content.replace(
    "document.getElementById('enableProspector').checked = false;",
    "// enableProspector removed - prospector at /prospect.html"
);
content = content.replace(
    "document.getElementById('prospectorOptions').style.display = 'none';",
    "// prospectorOptions removed"
);
content = content.replace(
    "document.getElementById('prospectorAgentStatus').style.display = 'none';",
    "// prospectorAgentStatus removed"
);

fs.writeFileSync(file, content);
console.log('Done');
