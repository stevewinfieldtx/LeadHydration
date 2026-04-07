// Brain Trust Panel System for Lead Hydration
// Advisory panel approach: 3 advisors debate, moderator synthesizes consensus

module.exports = function(callOpenRouterJSON, MODELS) {

// Brain Trust Panel System for Lead Hydration
// Adds to server.js BEFORE the prospector functions
// Each stage runs 3 advisors in parallel, then a moderator synthesizes consensus

const BRAIN_TRUST_ROLES = {
  solution: [
    {
      id: 'technical_analyst',
      name: 'The Technical Analyst',
      prompt: `You are The Technical Analyst on an advisory panel. Your job is to strip a product down to what it ACTUALLY does — no marketing fluff. Evaluate the architecture, integration capabilities, technical limitations, and real-world performance. You care about what's under the hood, not the brochure.`
    },
    {
      id: 'competitive_strategist', 
      name: 'The Competitive Strategist',
      prompt: `You are The Competitive Strategist on an advisory panel. Your job is to position this product against its alternatives. Where does it win? Where does it lose? What's the switching cost? Who are the real competitors, and what would make a buyer choose this over them? You think in terms of market positioning and competitive moats.`
    },
    {
      id: 'buyers_advocate',
      name: "The Buyer's Advocate",
      prompt: `You are The Buyer's Advocate on an advisory panel. You think like the person writing the check. What objections will they raise? What's the total cost of ownership? What risks are they taking? What does the implementation really look like? You protect the buyer from being oversold and you cut through vendor promises to find the real value.`
    }
  ],
  vertical: [
    {
      id: 'market_analyst',
      name: 'The Market Analyst',
      prompt: `You are The Market Analyst on an advisory panel. You evaluate verticals based on hard data — market density, fragmentation, TAM, growth trajectories, and publicly available business counts. You prefer verticals with large numbers of addressable SMBs where the solution fits structurally. You back your recommendations with reasoning, not gut feel.`
    },
    {
      id: 'field_sales_veteran',
      name: 'The Field Sales Veteran',
      prompt: `You are The Field Sales Veteran on an advisory panel. You have 20+ years closing B2B deals. You evaluate verticals based on which ones actually CLOSE — not which look good on paper. You know that some industries have long procurement cycles, others have budget gatekeepers, and some have a culture of "we've always done it this way." You pick verticals where the pain is urgent enough that deals move.`
    },
    {
      id: 'operations_thinker',
      name: 'The Operations Thinker',
      prompt: `You are The Operations Thinker on an advisory panel. You evaluate verticals based on operational complexity — where the pain is structural and unavoidable, not optional. Multi-location businesses, regulated industries, high-volume transaction environments — these are where technology solutions become necessities rather than nice-to-haves. You look for verticals where NOT having the solution causes real operational breakdowns.`
    }
  ],
  pain: [
    {
      id: 'industry_insider',
      name: 'The Industry Insider',
      prompt: `You are The Industry Insider on an advisory panel. You know where the bodies are buried in this vertical. You've worked in or closely with companies in this industry for years. You know the pain points that never make it into analyst reports — the workarounds, the spreadsheet nightmares, the compliance scrambles. Your pain points are specific and real, not theoretical.`
    },
    {
      id: 'cfo_perspective',
      name: 'The CFO Perspective',
      prompt: `You are The CFO Perspective on an advisory panel. You translate every pain point into dollars. "Manual process" means nothing to you — "420 hours per quarter of analyst time at $85/hour costing $142,800 annually" means everything. You evaluate pain by financial impact: revenue lost, cost incurred, risk exposure valued, opportunity cost quantified. If you can't put a number on it, it's not a real pain.`
    },
    {
      id: 'it_director',
      name: 'The IT Director Perspective',
      prompt: `You are The IT Director Perspective on an advisory panel. You know what the technology landscape actually looks like inside mid-market companies. You know about the legacy systems held together with duct tape, the integration nightmares, the shadow IT, the vendor lock-in. Your pain points are about what the technical reality looks like on the ground — not what the org chart says should be happening.`
    }
  ],
  metro: [
    {
      id: 'territory_planner',
      name: 'The Territory Planner',
      prompt: `You are The Territory Planner on an advisory panel. You optimize for sales efficiency — drive time between prospects, density of targets per square mile, and the ability to book 4-5 meetings in a single day trip. You know that a metro with 200 prospects spread across 100 miles is worse than one with 80 prospects in a 20-mile radius.`
    },
    {
      id: 'economic_analyst',
      name: 'The Economic Analyst',
      prompt: `You are The Economic Analyst on an advisory panel. You evaluate metros based on economic momentum — job growth, business formation rates, construction permits, VC funding, corporate relocations. A metro in growth mode has companies that are scaling, breaking old systems, and buying new ones. Stagnant metros mean stagnant budgets.`
    },
    {
      id: 'local_intelligence',
      name: 'The Local Intelligence Officer',
      prompt: `You are The Local Intelligence Officer on an advisory panel. You know the ground truth about specific metros — which business parks cluster certain industries, which corridors are the real commercial hubs, which neighborhoods are gentrifying and attracting startups. You provide the hyper-local knowledge that makes a rep sound like they've been working the territory for years.`
    }
  ]
};

// Run a Brain Trust panel — 3 advisors in parallel, then moderator synthesizes
async function runBrainTrustPanel(stage, context, outputSchema) {
  const roles = BRAIN_TRUST_ROLES[stage];
  if (!roles) throw new Error('Unknown Brain Trust stage: ' + stage);

  console.log(`[Brain Trust / ${stage}] Convening panel: ${roles.map(r => r.name).join(', ')}`);

  // Run all 3 advisors in parallel
  const advisorPromises = roles.map(async (role) => {
    const startTime = Date.now();
    try {
      const result = await callOpenRouterJSON(
        MODELS.painpoints,
        role.prompt + `\n\nYou are participating in an advisory panel discussion. Provide your analysis as JSON matching this structure:\n${outputSchema}\n\nAlso include a field "advisor_reasoning" with 2-3 sentences explaining your key insight and what others on the panel might miss.`,
        context,
        0.4,
        { webSearch: true, maxTokens: 4000 }
      );
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Brain Trust / ${stage}] ${role.name} responded (${elapsed}s)`);
      return { role: role.id, name: role.name, analysis: result, error: null };
    } catch (e) {
      console.error(`[Brain Trust / ${stage}] ${role.name} failed: ${e.message}`);
      return { role: role.id, name: role.name, analysis: null, error: e.message };
    }
  });

  const advisorResults = await Promise.all(advisorPromises);
  const validResults = advisorResults.filter(r => r.analysis !== null);

  if (validResults.length === 0) throw new Error('All Brain Trust advisors failed for stage: ' + stage);

  // Moderator synthesizes consensus
  console.log(`[Brain Trust / ${stage}] Moderator synthesizing ${validResults.length} perspectives...`);

  const moderatorContext = validResults.map(r => {
    return `=== ${r.name} ===\n${JSON.stringify(r.analysis, null, 2)}`;
  }).join('\n\n');

  const moderatorResult = await callOpenRouterJSON(
    MODELS.painpoints,
    `You are the Moderator of an expert advisory panel called the Brain Trust. You have received analyses from ${validResults.length} advisors. Your job is to:

1. Synthesize their perspectives into a CONSENSUS recommendation
2. Identify where they AGREED (and why that agreement is strong signal)
3. Identify where they DISAGREED (and explain both sides fairly)
4. Produce a final recommendation that takes the best from each perspective
5. Note any dissenting opinions that the user should still consider

Return JSON matching this structure:
{
  "consensus": { ... the main output matching the stage schema ... },
  "panel_discussion": {
    "agreements": ["Points where all advisors aligned — these are high-confidence signals"],
    "disagreements": [
      {
        "topic": "What they disagreed about",
        "perspectives": [
          {"advisor": "Name", "position": "Their view"},
          {"advisor": "Name", "position": "Their opposing view"}
        ],
        "resolution": "How the moderator resolved it and why"
      }
    ],
    "dissenting_opinions": [
      {
        "advisor": "Name",
        "opinion": "Their minority view that was not adopted but should be considered",
        "merit": "Why this dissent has value even though it wasn't the consensus"
      }
    ],
    "confidence_level": "high | medium | low — based on how much the panel agreed",
    "moderator_note": "1-2 sentence summary of the panel dynamic and recommendation strength"
  },
  "advisor_contributions": [
    {
      "advisor": "Name",
      "key_insight": "The most valuable thing this advisor brought to the discussion",
      "reasoning": "Their advisor_reasoning field"
    }
  ]
}

The "consensus" object should contain ALL the fields from the original output schema, synthesized from the best of all advisors.`,
    `Here are the ${validResults.length} advisor analyses for the ${stage} stage:\n\n${moderatorContext}\n\nSynthesize these into a consensus recommendation. The consensus object must include all fields from the stage output schema.`,
    0.3,
    { maxTokens: 6000 }
  );

  console.log(`[Brain Trust / ${stage}] Panel complete. Confidence: ${moderatorResult.panel_discussion?.confidence_level || '?'}`);

  return {
    consensus: moderatorResult.consensus || moderatorResult,
    panel_discussion: moderatorResult.panel_discussion || {},
    advisor_contributions: moderatorResult.advisor_contributions || validResults.map(r => ({ advisor: r.name, key_insight: r.analysis?.advisor_reasoning || '', reasoning: '' })),
    raw_advisors: validResults
  };
}

// ============================================================================
// ===== BRAIN TRUST PROSPECTOR STAGES =====================================
// ============================================================================

// Brain Trust: Vertical Selection
async function runBrainTrustVertical(solutionData, targetVertical) {
  const context = `Analyze this solution and recommend the BEST industry vertical to target for a prospecting campaign.

${targetVertical ? 'The user has suggested targeting: "' + targetVertical + '". Evaluate this choice — confirm if strong, override if there is something significantly better.' : ''}

=== SOLUTION ===
Name: ${solutionData.name}
Type: ${solutionData.type || ''}
Description: ${solutionData.description || ''}
Capabilities: ${(solutionData.capabilities || []).join(', ')}
Target Market: ${solutionData.targetMarket || ''}
Key Benefits: ${(solutionData.keyBenefits || []).join(', ')}

Recommend the vertical where this solution has the highest probability of closing deals. Be specific — not "Manufacturing" but "Custom metal fabricators serving aerospace with lot traceability requirements."`;

  const schema = `{
    "selected_vertical": "Specific vertical name",
    "rationale": "3-4 sentences explaining why",
    "structural_fit": "Why this vertical inherently needs the solution",
    "pain_density": "How common and acute the pain is",
    "runner_up_verticals": [{"vertical": "Name", "why_not_first": "Reason"}],
    "micro_verticals": ["Hyper-specific sub-segments"]
  }`;

  return await runBrainTrustPanel('vertical', context, schema);
}

// Brain Trust: Pain Mapping
async function runBrainTrustPainMapper(solutionData, verticalData) {
  const vertical = verticalData.selected_vertical || verticalData.consensus?.selected_vertical || 'Unknown';
  
  const context = `Map the specific pain points for this solution + vertical combination.

=== SOLUTION ===
Name: ${solutionData.name}
Type: ${solutionData.type || ''}
Description: ${solutionData.description || ''}
Capabilities: ${(solutionData.capabilities || []).join(', ')}

=== VERTICAL ===
${vertical}

For each pain point:
- Be brutally specific to this vertical
- Include observable signals so we can identify companies suffering from it
- Map it to a specific solution capability
- Include trigger events that make the pain urgent

Produce 5-8 pain points.`;

  const schema = `{
    "pain_map": [
      {
        "pain": "Specific operational pain",
        "severity": "critical | high | moderate",
        "who_feels_it": "Job title(s)",
        "business_cost": "Dollar/time/risk cost",
        "observable_signals": ["External signals"],
        "solution_capability": "Which feature solves this",
        "trigger_events": ["Events making this urgent"]
      }
    ],
    "ideal_prospect_profile": {
      "company_size": "Employee range",
      "revenue_range": "Revenue range",
      "tech_maturity": "low | mixed | high",
      "complexity_indicators": ["What makes them need this"],
      "disqualifiers": ["Signs they do NOT have this pain"]
    },
    "search_terms": ["Search terms for finding these companies"],
    "vertical_context": "2-3 sentences of context"
  }`;

  return await runBrainTrustPanel('pain', context, schema);
}

// Brain Trust: Metro Selection
async function runBrainTrustMetro(solutionData, verticalData, geoSeed) {
  const vertical = verticalData.selected_vertical || verticalData.consensus?.selected_vertical || 'Unknown';
  
  const context = `Select the best metropolitan area for a B2B prospecting campaign.

${geoSeed ? 'The user has suggested: "' + geoSeed + '". Evaluate this — validate density or suggest better.' : ''}

=== SOLUTION ===
Name: ${solutionData.name}
Capabilities: ${(solutionData.capabilities || []).join(', ')}
Target Market: ${solutionData.targetMarket || ''}

=== VERTICAL ===
${vertical}

Optimize for prospect density and sales efficiency.`;

  const schema = `{
    "selected_metro": "Metro name (e.g., Dallas-Fort Worth, TX)",
    "city_core": "Primary city",
    "state": "State abbreviation",
    "rationale": "3-4 sentences explaining why",
    "estimated_target_pool": "Estimated qualifying SMBs",
    "key_business_corridors": [{"corridor": "Name", "description": "What clusters here", "landmark": "Local landmark"}],
    "economic_signals": ["Growth indicators"],
    "local_knowledge": {
      "major_highways": ["Key highways"],
      "rapport_references": ["Local references a rep can use"]
    }
  }`;

  return await runBrainTrustPanel('metro', context, schema);
}


return { BRAIN_TRUST_ROLES, runBrainTrustPanel, runBrainTrustVertical, runBrainTrustPainMapper, runBrainTrustMetro };
};
