// Contract Drafter — Template-Based + AI Fallback
// Template flow: gather data → ask for missing → merge → generate .docx (3-8 seconds)
// AI fallback: full subagent loop for non-templated types (30-60 seconds)

const Anthropic = require("@anthropic-ai/sdk");
const contracts = require("../contracts");
const pipeline = require("../pipeline");
const files = require("../files");
const drive = require("../drive");
const templateEngine = require("../template-engine");
let rag;
try { rag = require("../rag"); } catch { rag = null; }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Deal name to project directory mapping ---
const DIR_MAPPINGS = {
  cumley: "la-pine-or", forest: "la-pine-or", forrest: "la-pine-or",
  sims: "la-pine-or", sim: "la-pine-or", "la pine": "la-pine-or",
  traditions: "traditions-north", brio: "brio-vista",
  columbia: "columbia-view-estates", sage: "sage-creek",
  wasem: "wasem-lot-3", coffer: "tomi-coffe", tomi: "tomi-coffe",
  idaho: "idaho-county-154ac", roberts: "roberts-park-place",
  fraser: "fraser-roy", burnham: "burnham-ridge",
  stavrianakis: "stavrianakis", cloverdale: "cloverdale",
  meadow: "meadow-vista", vancouver: "vancouver-sale",
  innes: "george-innes",
};

function guessProjectDir(dealName) {
  const q = dealName.toLowerCase();
  for (const [key, dir] of Object.entries(DIR_MAPPINGS)) {
    if (q.includes(key)) return dir;
  }
  return null;
}

// --- GHL field mapping (for future GHL integration) ---
// Maps GHL contact fields to our template merge fields
const GHL_FIELD_MAP = {
  "contact.first_name": "seller_first_name",
  "contact.last_name": "seller_last_name",
  "contact.mailing_address": "seller_mailing_address",
  "contact.mailing_city": "seller_mailing_city",
  "contact.mailing_state": "seller_mailing_state",
  "contact.mailing_zip_code": "seller_mailing_zip",
  "contact.property_county": "property_county",
  "contact.property_state": "property_state",
  "contact.offer_amount": "purchase_price",
  "contact.parcel_number": "parcel_number",
  "contact.acreage": "acreage",
  "contact.short_legal": "short_legal",
  "contact.earnest_money_deposit": "earnest_money",
  "contact.contract_closed_date": "closing_days",
  "contact.feasibility_period": "feasibility_days",
};

// =============================================================================
// STEP 1: GATHER — Pull data from pipeline + project files, identify missing
// =============================================================================

async function initDraft(dealName, docType, state) {
  const gathered = {};
  const sources = [];

  // Check if template exists
  const template = await templateEngine.loadTemplate(docType, state || "wa");
  if (!template) {
    return { templateFound: false, gathered: {}, missing: [], note: `No template for ${docType}/${state}. Will use AI drafting.` };
  }

  // Get required fields from template
  const requiredFields = templateEngine.getRequiredFields(template.content);

  // Look up deal in pipeline
  try {
    const dealData = await pipeline.lookupDeal(dealName);
    if (dealData && !dealData.error) {
      if (dealData.price) gathered.purchase_price = dealData.price;
      if (dealData.market) {
        // Try to infer state from market
        const marketState = {
          "Idaho": "ID", "Nevada": "NV", "Washington": "WA",
          "Oregon": "OR", "California": "CA",
          "Boise": "ID", "Dayton": "NV", "Reno": "NV",
          "Spokane": "WA", "Vancouver": "WA", "La Pine": "OR",
        };
        for (const [market, st] of Object.entries(marketState)) {
          if (String(dealData.market).includes(market)) {
            gathered.property_state = market;
            gathered.state_abbrev = st;
            break;
          }
        }
      }
      sources.push("pipeline");
    }
  } catch (err) {
    console.error(`[ContractDrafter] Pipeline lookup failed: ${err.message}`);
  }

  // Read project file if it exists
  const projectDir = guessProjectDir(dealName);
  if (projectDir) {
    try {
      const projFile = await files.readProjectFile(`projects/${projectDir}/README.md`);
      if (projFile && !projFile.error) {
        sources.push("project-file");
      }
    } catch { /* ok */ }
  }

  // GHL CRM contact lookup
  try {
    const ghl = require("../ghl");
    if (ghl.isConfigured()) {
      const ghlData = await ghl.searchByDeal(dealName);
      if (ghlData.contacts.length > 0) {
        const contact = ghlData.contacts[0];
        const ghlFields = ghl.extractContractFields(contact);
        // Merge GHL fields into gathered (GHL wins over pipeline for contact info)
        for (const [key, val] of Object.entries(ghlFields)) {
          if (val) gathered[key] = val;
        }
        sources.push("ghl");
      }
    }
  } catch (err) {
    console.error(`[ContractDrafter] GHL lookup failed: ${err.message}`);
  }

  // For extensions: search Drive/knowledge base for the original contract
  if (docType === "extension") {
    try {
      // Search knowledge base for original contract details
      if (rag) {
        const ragResults = await rag.search(`${dealName} purchase agreement contract`, { deal: dealName }, 3);
        if (ragResults && ragResults.results && ragResults.results.length > 0) {
          for (const result of ragResults.results) {
            const text = result.text || result.content || "";
            // Extract property address
            if (!gathered.property_address) {
              const addrMatch = text.match(/(?:Property\s*(?:Address)?|Located\s*at)[:\s]+([^\n,]+)/i);
              if (addrMatch) gathered.property_address = addrMatch[1].trim();
            }
            // Extract parcel number
            if (!gathered.parcel_number) {
              const parcelMatch = text.match(/(?:Parcel|APN|Tax\s*(?:Lot|ID))[:\s#]*([A-Z0-9\-\.]+)/i);
              if (parcelMatch) gathered.parcel_number = parcelMatch[1].trim();
            }
            // Extract seller name
            if (!gathered.seller_name) {
              const sellerMatch = text.match(/(?:SELLER|Seller)[:\s]+([^\n]+?)(?:\n|$)/);
              if (sellerMatch) gathered.seller_name = sellerMatch[1].trim();
            }
            // Extract original agreement date
            if (!gathered.original_agreement_date) {
              const dateMatch = text.match(/(?:dated|executed|entered\s*into)[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
              if (dateMatch) gathered.original_agreement_date = dateMatch[1].trim();
            }
          }
          sources.push("knowledge-base");
        }
      }
    } catch (err) {
      console.error(`[ContractDrafter] Knowledge base search failed: ${err.message}`);
    }

    // Search Drive for original contract file
    try {
      const driveResults = await drive.searchFiles(`${dealName} purchase agreement`);
      if (driveResults && driveResults.files && driveResults.files.length > 0) {
        sources.push("drive-search");
        // Store file IDs for reference
        gathered._original_contract_files = driveResults.files.slice(0, 3).map(f => ({
          name: f.name, id: f.id, modified: f.modifiedTime,
        }));
      }
    } catch (err) {
      console.error(`[ContractDrafter] Drive search failed: ${err.message}`);
    }
  }

  // Set defaults
  gathered.buyer_name = "GF Development LLC";
  gathered.today_date = templateEngine.formatDate(new Date());
  gathered.effective_date = gathered.today_date;

  // Doc-type-specific defaults
  if (docType === "extension") {
    gathered.earnest_money_deposit_days = gathered.earnest_money_deposit_days || "5";
  } else {
    gathered.acceptance_days = gathered.acceptance_days || "2";
    gathered.feasibility_days = gathered.feasibility_days || "30";
    gathered.closing_days = gathered.closing_days || "30";
  }

  // Determine missing fields
  const missing = requiredFields.filter((f) => !gathered[f]);

  return {
    templateFound: true,
    templatePath: template.path,
    gathered,
    missing,
    requiredFields,
    sources,
    state: state || (gathered.state_abbrev ? gathered.state_abbrev.toLowerCase() : null),
  };
}

// =============================================================================
// STEP 2: GENERATE — Merge fields into template, create .docx, upload to Drive
// =============================================================================

async function generateFromTemplate(docType, state, rawFields, options = {}) {
  // Extension agreements don't include cover letter or about-me
  const isExtension = docType === "extension";
  const {
    includeCoverLetter = !isExtension,
    includeAboutMe = !isExtension,
    customTerms,
  } = options;

  // Build computed fields (price words, date formatting, etc.)
  const fields = templateEngine.buildStandardFields(rawFields);

  // Compose seller_name from first + last if not provided directly
  if (!fields.seller_name && fields.seller_first_name && fields.seller_last_name) {
    fields.seller_name = `${fields.seller_first_name} ${fields.seller_last_name}`;
  }

  // Load and merge the contract template
  const template = await templateEngine.loadTemplate(docType, state);
  if (!template) {
    return { error: `No template found for ${docType}/${state}.` };
  }

  let contractBody = templateEngine.mergeFields(template.content, fields);

  // If custom terms provided, append as special conditions (offer-type docs only)
  if (customTerms && !isExtension) {
    contractBody += `\n\n15. Special Conditions\n\n  - ${customTerms}\n`;
  }

  // Load signature block and append
  const sigBlock = await templateEngine.loadSharedSection("signature-block");
  if (sigBlock) {
    contractBody += "\n\n" + templateEngine.mergeFields(sigBlock, fields);
  }

  // Validate no unfilled fields remain
  const unfilled = templateEngine.validateMerge(contractBody);

  // Build sections array for multi-section doc
  const sections = [];

  if (includeCoverLetter) {
    const coverLetter = await templateEngine.loadSharedSection("cover-letter");
    if (coverLetter) {
      sections.push({ type: "cover-letter", content: templateEngine.mergeFields(coverLetter, fields) });
    }
  }

  sections.push({ type: "contract", content: contractBody });

  if (includeAboutMe) {
    const aboutMe = await templateEngine.loadSharedSection("about-me");
    if (aboutMe) {
      sections.push({ type: "about-me", content: templateEngine.mergeFields(aboutMe, fields) });
    }
  }

  // Generate the .docx
  const dealName = rawFields.deal_name || rawFields.seller_last_name || "Contract";
  const docTypeLabel = isExtension ? "Extension Agreement" : "Purchase Offer";
  const fileName = `${dealName} - ${docTypeLabel}`;

  const result = await contracts.generateMultiSectionDoc(sections, fileName, docType, dealName);

  return {
    ...result,
    unfilled: unfilled.length > 0 ? unfilled : undefined,
    sections: sections.map((s) => s.type),
    state: state.toUpperCase(),
  };
}

// =============================================================================
// AI FALLBACK — Full subagent for non-templated contract types
// =============================================================================

const CONTRACT_DRAFTER_PROMPT = `You are a real estate attorney specializing in raw land acquisition, entitlements, and builder lot sales. You represent the BUYER: GF Development LLC.

Draft production-quality real estate contracts. Every draft should be attorney-grade.

## WORKFLOW
1. GATHER CONTEXT — search precedent, lookup deal, read project file
2. DRAFT — full contract with UPPERCASE headers, numbered clauses, specific dates/amounts
3. VALIDATE — check all required clauses present
4. FLAG ISSUES — assumptions, borrowed clauses, items for attorney review
5. GENERATE — create .docx and upload to Drive

## GF DEVELOPMENT STANDARD TERMS
- Always include assignment rights
- Due diligence: 30-60 days
- Earnest money: 1-3%, refundable during DD
- Closing: 30-60 days after DD
- Default: earnest money as liquidated damages (buyer), specific performance (seller)
- Governing law: state where property is located
- GF Development LLC is a Washington LLC

Today's date: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

const SUBAGENT_TOOLS = [
  { name: "search_precedent", description: "Search Drive for past contracts.", input_schema: { type: "object", properties: { deal_type: { type: "string" }, market: { type: "string" }, keywords: { type: "string" } } } },
  { name: "read_drive_file", description: "Read a Drive file by ID.", input_schema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] } },
  { name: "lookup_deal", description: "Look up deal from pipeline.", input_schema: { type: "object", properties: { deal_name: { type: "string" } }, required: ["deal_name"] } },
  { name: "read_project_file", description: "Read a project file.", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "search_knowledge_base", description: "Search indexed Drive docs.", input_schema: { type: "object", properties: { query: { type: "string" }, deal_filter: { type: "string" } }, required: ["query"] } },
  { name: "generate_contract_doc", description: "Create .docx and upload to Drive.", input_schema: { type: "object", properties: { contract_text: { type: "string" }, file_name: { type: "string" }, doc_type: { type: "string" }, deal_name: { type: "string" } }, required: ["contract_text"] } },
];

async function executeSubagentTool(toolName, toolInput) {
  switch (toolName) {
    case "search_precedent": return await contracts.searchPrecedent(toolInput.deal_type, toolInput.market, toolInput.keywords);
    case "read_drive_file": return await drive.readFile(toolInput.file_id);
    case "lookup_deal": return await pipeline.lookupDeal(toolInput.deal_name);
    case "read_project_file": return await files.readProjectFile(toolInput.file_path);
    case "search_knowledge_base": {
      if (!rag) return { error: "Knowledge base not available." };
      return await rag.search(toolInput.query, toolInput.deal_filter ? { deal: toolInput.deal_filter } : {}, 3);
    }
    case "generate_contract_doc": return await contracts.generateContractDoc(toolInput.contract_text, toolInput.file_name, toolInput.doc_type, toolInput.deal_name);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

async function runContractDrafter(dealName, docType, additionalTerms) {
  const MAX_ITERATIONS = 15;

  let taskMessage = `Draft a ${docType || "contract"} for deal: "${dealName}".`;
  if (additionalTerms) taskMessage += `\n\nGreg's instructions:\n${additionalTerms}`;
  taskMessage += `\n\nFollow your workflow: gather context, draft, validate, flag issues, generate .docx.`;

  const projectDir = guessProjectDir(dealName);
  if (projectDir) taskMessage += `\n\nProject file: projects/${projectDir}/README.md`;

  const messages = [{ role: "user", content: taskMessage }];
  const cachedSystem = [{ type: "text", text: CONTRACT_DRAFTER_PROMPT, cache_control: { type: "ephemeral" } }];

  let totalTokens = { input: 0, output: 0 };
  let generatedDoc = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: cachedSystem,
        tools: SUBAGENT_TOOLS,
        messages,
      });
    } catch (err) {
      if (err.status === 429) {
        await new Promise((r) => setTimeout(r, 30000));
        try {
          response = await anthropic.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 4096, system: cachedSystem, tools: SUBAGENT_TOOLS, messages });
        } catch (retryErr) { return { error: `Rate limit retry failed: ${retryErr.message}` }; }
      } else { return { error: `API error: ${err.message}` }; }
    }

    if (response.usage) {
      totalTokens.input += response.usage.input_tokens || 0;
      totalTokens.output += response.usage.output_tokens || 0;
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const finalText = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      let summary = `*Contract Draft Complete*\n`;
      if (generatedDoc) summary += `Document: ${generatedDoc.name}\nDrive: ${generatedDoc.link}\nFolder: ${generatedDoc.folder}\n\n`;
      summary += finalText;
      console.log(`[ContractDrafter] AI fallback done in ${i + 1} iterations. Tokens: ${totalTokens.input} in, ${totalTokens.output} out.`);
      return summary;
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`[ContractDrafter] Tool: ${block.name}`);
        try {
          const result = await executeSubagentTool(block.name, block.input);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          if (block.name === "generate_contract_doc" && result && result.link) generatedDoc = result;
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultStr.length > 6000 ? resultStr.substring(0, 6000) + "... [truncated]" : resultStr });
        } catch (err) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true });
        }
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { error: "Contract drafter hit iteration limit." };
}

module.exports = { initDraft, generateFromTemplate, runContractDrafter, GHL_FIELD_MAP };
