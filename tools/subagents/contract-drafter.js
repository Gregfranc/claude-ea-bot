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
// HELPER: Extract contract fields from text (used by initDraft for extensions)
// =============================================================================

function extractContractFields(text, gathered) {
  if (!text) return;

  // Seller name
  if (!gathered.seller_name) {
    const sellerMatch = text.match(/(?:SELLER|Seller)[:\s]+([^\n]+?)(?:\n|$)/);
    if (sellerMatch) {
      let name = sellerMatch[1].trim();
      // Clean up common artifacts
      name = name.replace(/^[:\s]+/, "").replace(/\s{2,}/g, " ");
      if (name.length > 2 && name.length < 100) gathered.seller_name = name;
    }
  }

  // Seller mailing address
  if (!gathered.seller_mailing_address && gathered.seller_name) {
    // Look for address lines after the seller name
    const sellerBlock = text.match(/(?:SELLER|Seller)[:\s]+[^\n]+\n([^\n]+)\n([^\n]+)/i);
    if (sellerBlock) {
      const line1 = sellerBlock[1].trim();
      const line2 = sellerBlock[2].trim();
      // Line1 should look like a street address
      if (/\d+\s+\w/.test(line1)) {
        gathered.seller_mailing_address = line1;
        // Line2 should look like city, state zip
        const cityStateZip = line2.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5})/);
        if (cityStateZip) {
          gathered.seller_mailing_city = cityStateZip[1].trim();
          gathered.seller_mailing_state = cityStateZip[2];
          gathered.seller_mailing_zip = cityStateZip[3];
        }
      }
    }
  }

  // Property address
  if (!gathered.property_address) {
    const addrMatch = text.match(/(?:Property\s*(?:Address)?|property\s*located\s*at|Located\s*at)[:\s]+([^\n,]+)/i);
    if (addrMatch) gathered.property_address = addrMatch[1].trim();
  }

  // Property city, state, zip (from property address line or nearby)
  if (!gathered.property_city) {
    const propLocMatch = text.match(/(?:Property\s*(?:Address)?|property\s*located\s*at|Located\s*at)[:\s]+[^\n]*?,\s*([^,\n]+),\s*([A-Z]{2})\s+(\d{5})/i);
    if (propLocMatch) {
      gathered.property_city = propLocMatch[1].trim();
      gathered.property_state = propLocMatch[2].trim();
      gathered.property_zip = propLocMatch[3].trim();
    }
  }

  // Parcel number
  if (!gathered.parcel_number) {
    const parcelMatch = text.match(/(?:Parcel\s*(?:Number)?|APN|Tax\s*(?:Lot|ID|Parcel)|Assessor'?s?\s*Parcel)[:\s#]*([A-Z0-9][A-Z0-9\-\.]{3,})/i);
    if (parcelMatch) gathered.parcel_number = parcelMatch[1].trim();
  }

  // Original agreement date
  if (!gathered.original_agreement_date) {
    // Try multiple date patterns
    const datePatterns = [
      /(?:dated|executed|entered\s*into\s*(?:a\s*)?(?:Purchase\s*)?(?:Agreement\s*)?(?:dated\s*)?)[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
      /(?:Purchase\s*Agreement\s*dated)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
      /(?:dated|executed)[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    ];
    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        gathered.original_agreement_date = match[1].trim();
        break;
      }
    }
  }

  // Closing date (for reference — the date being extended)
  if (!gathered.old_closing_date) {
    const closingMatch = text.match(/(?:Closing|Close)\s*(?:Date|will\s*occur)[:\s]*.*?(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i);
    if (closingMatch) gathered.old_closing_date = closingMatch[1].trim();
  }

  // Due diligence / feasibility date
  if (!gathered.old_dd_date) {
    const ddMatch = text.match(/(?:Due\s*Diligence|Feasibility)[:\s]*.*?(?:on\s*or\s*before|by)\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i);
    if (ddMatch) gathered.old_dd_date = ddMatch[1].trim();
  }

  // Purchase price (for reference)
  if (!gathered.original_purchase_price) {
    const priceMatch = text.match(/(?:Purchase\s*Price|Price)[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
    if (priceMatch) gathered.original_purchase_price = "$" + priceMatch[1].trim();
  }

  // Earnest money (for reference)
  if (!gathered.original_earnest_money) {
    const emMatch = text.match(/(?:Earnest\s*Money)[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
    if (emMatch) gathered.original_earnest_money = "$" + emMatch[1].trim();
  }
}

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

  // For extensions: find and READ the original signed contract
  if (docType === "extension") {
    // Search Drive for the original contract — try multiple search terms
    const searchTerms = [
      `${dealName} purchase agreement signed`,
      `${dealName} purchase agreement`,
      `${dealName} contract`,
    ];

    let contractText = null;
    let contractFile = null;

    for (const term of searchTerms) {
      if (contractText) break;
      try {
        const driveResults = await drive.searchFiles(term);
        if (driveResults && driveResults.files && driveResults.files.length > 0) {
          // Prefer files with "signed", "executed", or "fully executed" in the name
          const sorted = driveResults.files.sort((a, b) => {
            const aName = (a.name || "").toLowerCase();
            const bName = (b.name || "").toLowerCase();
            const aScore = (aName.includes("signed") || aName.includes("executed")) ? 2 :
                           (aName.includes("purchase") || aName.includes("agreement")) ? 1 : 0;
            const bScore = (bName.includes("signed") || bName.includes("executed")) ? 2 :
                           (bName.includes("purchase") || bName.includes("agreement")) ? 1 : 0;
            return bScore - aScore;
          });

          // Try to read the best match
          for (const file of sorted.slice(0, 3)) {
            try {
              const fileContent = await drive.readFile(file.id);
              if (fileContent && !fileContent.error) {
                contractText = typeof fileContent === "string" ? fileContent :
                               fileContent.text || fileContent.content || JSON.stringify(fileContent);
                contractFile = { name: file.name, id: file.id };
                sources.push("drive-contract");
                break;
              }
            } catch { /* try next file */ }
          }

          // Store all found files for reference
          gathered._original_contract_files = sorted.slice(0, 5).map(f => ({
            name: f.name, id: f.id, modified: f.modifiedTime,
          }));
        }
      } catch (err) {
        console.error(`[ContractDrafter] Drive search "${term}" failed: ${err.message}`);
      }
    }

    // Extract fields from contract text
    if (contractText) {
      gathered._contract_source = contractFile;
      extractContractFields(contractText, gathered);
    }

    // Also try knowledge base if we're still missing key fields
    const keyFieldsMissing = !gathered.seller_name || !gathered.property_address || !gathered.parcel_number;
    if (keyFieldsMissing && rag) {
      try {
        const ragResults = await rag.search(`${dealName} purchase agreement seller property`, { deal: dealName }, 3);
        if (ragResults && ragResults.results && ragResults.results.length > 0) {
          for (const result of ragResults.results) {
            const text = result.text || result.content || "";
            extractContractFields(text, gathered);
          }
          sources.push("knowledge-base");
        }
      } catch (err) {
        console.error(`[ContractDrafter] Knowledge base search failed: ${err.message}`);
      }
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
