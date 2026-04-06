const fs = require('fs');
const file = 'C:\\Users\\steve\\Documents\\LeadHydration\\public\\index.html';
let c = fs.readFileSync(file, 'utf8');

// Replace emoji icons with clean styled divs
c = c.replace('<div class="card-icon">&#x1F4A7;</div>', '<div class="card-icon" style="font-family:\'IBM Plex Mono\',monospace;font-size:18px;font-weight:700;color:var(--hydrate);">H</div>');
c = c.replace('<div class="card-icon">&#x1F50D;</div>', '<div class="card-icon" style="font-family:\'IBM Plex Mono\',monospace;font-size:18px;font-weight:700;color:var(--locate);">L</div>');
c = c.replace('<div class="logo-icon">&#x1F4A7;</div>', '<div class="logo-icon" style="font-family:\'IBM Plex Mono\',monospace;font-size:14px;font-weight:800;color:#0a0e17;">LH</div>');

fs.writeFileSync(file, c);
console.log('Landing page emojis replaced');
