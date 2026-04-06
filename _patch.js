// Surgical patch: add painData parameter to runAccountProspector and inject pain context
const fs = require('fs');
const file = 'C:\\Users\\steve\\Documents\\LeadHydration\\server.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Update function signature
content = content.replace(
  'async function runAccountProspector(solutionData, verticalData, metroData, accountVolume = 10) {',
  'async function runAccountProspector(solutionData, verticalData, metroData, accountVolume = 10, painData = null) {'
);

// 2. Inject pain context builder right after the function opens
const oldLine = `  // Build dynamic qualification criteria from solution data`;
const painInjection = `  // Inject pain map context if available
  let painContext = '';
  if (painData && painData.pain_map) {
    painContext = '\\n\\n=== PAIN MAP (use to evaluate and score prospects) ===\\n' +
      painData.pain_map.map((p, i) => '  ' + (i+1) + '. "' + p.pain + '" (' + p.severity + ') — felt by ' + p.who_feels_it).join('\\n') +
      '\\nIDEAL PROFILE: Size ' + ((painData.ideal_prospect_profile||{}).company_size||'?') +
      ', Tech ' + ((painData.ideal_prospect_profile||{}).tech_maturity||'mixed') +
      '\\nDISQUALIFIERS: ' + ((painData.ideal_prospect_profile||{}).disqualifiers||[]).join(', ') +
      '\\nSEARCH HINTS: ' + (painData.search_terms||[]).join(', ');
  }

  // Build dynamic qualification criteria from solution data`;

content = content.replace(oldLine, painInjection);

// 3. Inject ${painContext} into the user prompt before the final "Find N specific" instruction
content = content.replace(
  'Find ${accountVolume} specific, real companies in or near ${metroData.selected_metro}',
  '${painContext}\n\nFind ${accountVolume} specific, real companies in or near ${metroData.selected_metro}'
);

fs.writeFileSync(file, content);
console.log('Done - Account Prospector patched');
