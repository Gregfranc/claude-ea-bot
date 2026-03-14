// Contract Drafter Subagent
// Runs its own Claude conversation with specialized system prompt and tools.
// Called by the main bot via the draft_contract tool.
// Returns a finished contract draft + Drive link.

const Anthropic = require("@anthropic-ai/sdk");
const contracts = require("../contracts");
const pipeline = require("../pipeline");
const files = require("../files");
const drive = require("../drive");
let rag;
try {
  rag = require("../rag");
} catch {
  rag = null;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- System Prompt ---
const CONTRACT_DRAFTER_PROMPT = `You are a real estate attorney specializing in raw land acquisition, entitlements, and builder lot sales. You represent the BUYER: GF Development LLC, a lean principal-led land development company operating in Idaho, Nevada, Washington, Oregon, and California.

Your job: draft production-quality real estate contracts, amendments, extensions, and assignments. Every draft should be attorney-grade, ready for review and signature with minimal edits.

## WORKFLOW (follow this order exactly)

1. GATHER CONTEXT
   - Use search_precedent to find similar past contracts in Google Drive
   - Use lookup_deal to get pipeline data (price, dates, parties, market)
   - Use read_project_file to get deal context from project README
   - Use search_knowledge_base for additional deal intelligence
   - Read the most relevant precedent contract with read_drive_file

2. DRAFT THE CONTRACT
   Using gathered context, draft the full contract with:
   - Clean UPPERCASE section headers (ARTICLE 1: PROPERTY, etc.)
   - Numbered clauses and subclauses (1.1, 1.2, (a), (b))
   - Specific dates, amounts, and party names (no placeholders unless truly unknown)
   - Signature blocks with ___ lines
   - Mirror structure and language from precedent where appropriate

3. VALIDATE before generating the document
   Check that your draft includes all required elements for the document type:

   **Purchase Agreement required clauses:**
   - Property description (legal description, APN, address)
   - Purchase price and payment terms
   - Earnest money (amount, holder, timeline)
   - Due diligence period (duration, buyer rights, termination)
   - Closing date and location
   - Title and survey provisions
   - Assignment rights (GF Development always needs assignment rights)
   - Default and remedies
   - Representations and warranties
   - Governing law and jurisdiction
   - Entire agreement / integration clause

   **Amendment required elements:**
   - Reference to original agreement (date, parties)
   - Specific sections being modified (quote original, state new)
   - "All other terms remain in full force and effect"
   - Effective date

   **Extension required elements:**
   - Reference to original agreement
   - Original deadline being extended
   - New deadline
   - Any consideration for the extension
   - "All other terms remain in full force and effect"

   **Assignment required elements:**
   - Reference to original agreement
   - Assignor and assignee identification
   - Terms of assignment (consideration, assumption of obligations)
   - Seller consent (if required by original agreement)
   - Representations by assignor

4. FLAG ISSUES
   After the draft, include a section called "DRAFTER'S NOTES" with:
   - Assumptions made (dates, amounts, terms not explicitly provided)
   - Clauses borrowed from precedent (cite which contract)
   - Optional clauses included (explain why included/excluded)
   - Jurisdiction-specific considerations
   - Items requiring attorney review before execution
   - Missing information that Greg needs to confirm

5. GENERATE DOCUMENT
   Use generate_contract_doc to create the .docx and upload to Drive.

## JURISDICTION RULES

**Idaho:** Community property state. Check for homestead exemptions on residential-adjacent land. Water rights are separate from land rights (must be specifically conveyed or reserved).

**Nevada:** No state income tax (relevant for entity structuring). NRS Chapter 113 governs real property transfers. Subdivisions of 5+ lots require public report.

**Washington:** RCW 64.06 requires seller disclosure (exempt for some land sales). Excise tax on real property transfers. GMA compliance for developments in UGAs.

**Oregon:** ORS 93 governs real property conveyances. Land use governed by statewide planning goals. UGB restrictions. Partition vs subdivision thresholds vary by county.

**California:** Cal. Civ. Code 1102+ seller disclosures. Subdivided Lands Act (5+ lots). Natural hazard disclosures. CEQA for entitlements.

## GF DEVELOPMENT STANDARD TERMS
- Always include assignment rights (GF Development frequently assigns contracts)
- Due diligence period: typically 30-60 days for raw land
- Earnest money: typically 1-3% of purchase price, refundable during DD
- Closing timeline: typically 30-60 days after DD expiration
- Buyer representations: limited (GF Development is sophisticated buyer)
- Seller representations: broad (condition of property, title, environmental, access, utilities)
- Default: earnest money as liquidated damages (buyer default), specific performance available (seller default)
- Governing law: state where property is located
- GF Development LLC is a Washington LLC

## OUTPUT FORMAT
Draft the contract as clean text with:
- UPPERCASE headers for major sections
- Numbered clauses (1., 2., 3. or ARTICLE 1, ARTICLE 2)
- Sub-clauses indented with letters: (a), (b), (c)
- Signature blocks with ___ lines and typed name/title below
- Dates in "Month Day, Year" format within the contract
- Dollar amounts with both numbers and words: "$50,000 (Fifty Thousand Dollars)"

Today's date: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

// --- Subagent Tool Definitions ---
const SUBAGENT_TOOLS = [
  {
    name: "search_precedent",
    description: "Search Google Drive for similar past contracts by deal type, market, or keywords.",
    input_schema: {
      type: "object",
      properties: {
        deal_type: { type: "string", enum: ["purchase-agreement", "amendment", "extension", "assignment", "lot-sale", "option", "earnest-money"] },
        market: { type: "string", enum: ["Idaho", "Nevada", "Washington", "Oregon", "California"] },
        keywords: { type: "string", description: "Search keywords (property name, address, party name)" },
      },
    },
  },
  {
    name: "read_drive_file",
    description: "Read a file from Google Drive by ID. Use to read precedent contracts found by search_precedent.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Google Drive file ID" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "lookup_deal",
    description: "Look up deal data from the pipeline sheet (price, dates, market, stage, contacts).",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string" },
      },
      required: ["deal_name"],
    },
  },
  {
    name: "read_project_file",
    description: "Read a project file from the EA repository (README, deal notes, etc.).",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to project root (e.g., projects/la-pine-or/README.md)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "search_knowledge_base",
    description: "Search indexed Google Drive documents for deal-specific information.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        deal_filter: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_contract_doc",
    description: "Convert contract text to a professional .docx file and upload to Google Drive. Call this LAST after drafting and validating.",
    input_schema: {
      type: "object",
      properties: {
        contract_text: { type: "string", description: "Full contract text with UPPERCASE headers, numbered sections, ___ for signatures" },
        file_name: { type: "string", description: "File name without date prefix or extension" },
        doc_type: { type: "string", enum: ["purchase-agreement", "amendment", "extension", "assignment", "lot-sale", "option", "earnest-money"] },
        deal_name: { type: "string", description: "Deal name for Drive folder organization" },
      },
      required: ["contract_text"],
    },
  },
];

// --- Subagent Tool Executor ---
async function executeSubagentTool(toolName, toolInput) {
  switch (toolName) {
    case "search_precedent":
      return await contracts.searchPrecedent(toolInput.deal_type, toolInput.market, toolInput.keywords);
    case "read_drive_file":
      return await drive.readFile(toolInput.file_id);
    case "lookup_deal":
      return await pipeline.lookupDeal(toolInput.deal_name);
    case "read_project_file":
      return await files.readProjectFile(toolInput.file_path);
    case "search_knowledge_base": {
      if (!rag) return { error: "Knowledge base not available." };
      const filter = toolInput.deal_filter ? { deal: toolInput.deal_filter } : {};
      return await rag.search(toolInput.query, filter, 3);
    }
    case "generate_contract_doc":
      return await contracts.generateContractDoc(
        toolInput.contract_text,
        toolInput.file_name,
        toolInput.doc_type,
        toolInput.deal_name
      );
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// --- Subagent Agent Loop ---
async function runContractDrafter(dealName, docType, additionalTerms) {
  const MAX_ITERATIONS = 15;
  const MAX_TOOL_RESULT = 6000; // Precedent contracts can be long

  // Build the initial user message
  let taskMessage = `Draft a ${docType || "contract"} for deal: "${dealName}".`;
  if (additionalTerms) {
    taskMessage += `\n\nGreg's instructions and terms:\n${additionalTerms}`;
  }
  taskMessage += `\n\nFollow your workflow: gather context first (search precedent, look up the deal, read the project file), then draft, validate, flag issues, and generate the .docx.`;

  // Guess project directory for the deal
  const q = dealName.toLowerCase();
  const dirMappings = {
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
  let projectDir = null;
  for (const [key, dir] of Object.entries(dirMappings)) {
    if (q.includes(key)) { projectDir = dir; break; }
  }
  if (projectDir) {
    taskMessage += `\n\nProject file path: projects/${projectDir}/README.md`;
  }

  const messages = [{ role: "user", content: taskMessage }];

  // Cache system prompt for token efficiency
  const cachedSystem = [
    { type: "text", text: CONTRACT_DRAFTER_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  const cachedTools = SUBAGENT_TOOLS.map((t, i) =>
    i === SUBAGENT_TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
  );

  let totalTokens = { input: 0, output: 0 };
  let generatedDoc = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096, // Contracts need more output space
        system: cachedSystem,
        tools: cachedTools,
        messages,
      });
    } catch (err) {
      if (err.status === 429) {
        const retryAfter = parseInt(err.headers?.["retry-after"] || "30", 10);
        console.log(`[ContractDrafter] Rate limited. Waiting ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        try {
          response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            system: cachedSystem,
            tools: cachedTools,
            messages,
          });
        } catch (retryErr) {
          return { error: `Rate limit retry failed: ${retryErr.message}` };
        }
      } else {
        return { error: `API error: ${err.message}` };
      }
    }

    // Track tokens
    if (response.usage) {
      totalTokens.input += response.usage.input_tokens || 0;
      totalTokens.output += response.usage.output_tokens || 0;
    }

    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // Done: extract final text
    if (response.stop_reason === "end_turn") {
      const textParts = assistantContent
        .filter((b) => b.type === "text")
        .map((b) => b.text);
      const finalText = textParts.join("\n");

      // Build result summary
      const result = {
        draft: finalText,
        document: generatedDoc,
        tokens: totalTokens,
        iterations: i + 1,
      };

      // Format for the parent bot
      let summary = `*Contract Draft Complete*\n`;
      if (generatedDoc) {
        summary += `Document: ${generatedDoc.name}\n`;
        summary += `Drive: ${generatedDoc.link}\n`;
        summary += `Folder: ${generatedDoc.folder}\n\n`;
      }
      summary += finalText;

      console.log(`[ContractDrafter] Done in ${i + 1} iterations. Tokens: ${totalTokens.input} in, ${totalTokens.output} out.`);
      return summary;
    }

    // Process tool calls
    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[ContractDrafter] Tool: ${block.name} | ${JSON.stringify(block.input).substring(0, 150)}`);
        try {
          const result = await executeSubagentTool(block.name, block.input);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          // Capture generated doc info for summary
          if (block.name === "generate_contract_doc" && result && result.link) {
            generatedDoc = result;
          }

          // Truncate large results (precedent contracts can be huge)
          const truncated = resultStr.length > MAX_TOOL_RESULT
            ? resultStr.substring(0, MAX_TOOL_RESULT) + `... [truncated, ${resultStr.length} total chars]`
            : resultStr;

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: truncated,
          });
        } catch (err) {
          console.error(`[ContractDrafter] Tool error (${block.name}):`, err.message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { error: "Contract drafter hit iteration limit. Try with more specific terms." };
}

module.exports = { runContractDrafter };
