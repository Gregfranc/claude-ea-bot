require("dotenv").config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const https = require("https");
const http = require("http");
const gmail = require("./tools/gmail");
const calendar = require("./tools/calendar");
const files = require("./tools/files");
const learning = require("./tools/learning");
const drive = require("./tools/drive");
const pipeline = require("./tools/pipeline");
const { OWNER_TOOLS, TEAM_TOOLS, PUBLIC_TOOLS } = require("./tools/definitions");
const permissions = require("./tools/permissions");
const transcript = require("./tools/transcript");
const meetingNotes = require("./tools/meeting-notes");
const driveTeam = require("./tools/drive-team");
const calendarFreebusy = require("./tools/calendar-freebusy");
const usage = require("./tools/usage");
const sheets = require("./tools/sheets");
const contracts = require("./tools/contracts");
const dealBrief = require("./tools/deal-brief");
const driveWatcher = require("./tools/drive-watcher");
const contractDrafter = require("./tools/subagents/contract-drafter");
const ghl = require("./tools/ghl");
const quo = require("./tools/quo");
const subscriptions = require("./tools/subscriptions");
let rag;
try {
  rag = require("./tools/rag");
} catch (err) {
  console.error("[RAG] Failed to load rag module:", err.message);
  rag = {
    search: async () => ({ error: "RAG module not loaded. Check that @pinecone-database/pinecone and @google/genai are installed." }),
    syncDrive: async () => ({ error: "RAG module not loaded." }),
    fullReindex: async () => ({ error: "RAG module not loaded." }),
    getStats: async () => ({ error: "RAG module not loaded." }),
  };
}

// --- Config ---
const OWNER_USER_ID = "U092AE1836K"; // Greg Francis

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Voice Note Transcription ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const AUDIO_MIME_TYPES = [
  "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav",
  "audio/x-m4a", "audio/mp3", "audio/aac", "audio/flac",
  "video/webm", "video/mp4", // Slack sometimes sends voice notes as video
];

const DOCUMENT_MIME_TYPES = [
  "text/plain", "text/markdown", "text/vtt", "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-subrip",
];

const IMAGE_MIME_TYPES = [
  "image/png", "image/jpeg", "image/gif", "image/webp",
];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB cap

const fs = require("fs");
const path = require("path");
const os = require("os");
const pathMod = require("path");

function downloadSlackFile(url, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const headers = {};
    // Only send auth to Slack URLs, not CDN redirects
    if (url.includes("slack.com") || url.includes("files.slack")) {
      headers.Authorization = `Bearer ${token}`;
    }
    mod.get(url, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        console.log(`[Voice] Redirect: ${res.statusCode} -> ${res.headers.location?.substring(0, 80)}...`);
        return downloadSlackFile(res.headers.location, token).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${url.substring(0, 80)}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function transcribeAudio(fileUrl, fileName) {
  if (!openai) {
    console.error("[Voice] OpenAI client not initialized (missing OPENAI_API_KEY?)");
    return null;
  }
  try {
    console.log(`[Voice] Downloading from: ${fileUrl?.substring(0, 80)}...`);
    const buffer = await downloadSlackFile(fileUrl, process.env.SLACK_BOT_TOKEN);
    console.log(`[Voice] Downloaded ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    if (buffer.length < 100) {
      console.error("[Voice] File too small, likely a download error. First bytes:", buffer.toString("utf-8", 0, 200));
      return null;
    }

    // Write to temp file and use fs.createReadStream (most compatible with Whisper API)
    const ext = pathMod.extname(fileName || "voice.webm") || ".webm";
    const tmpPath = pathMod.join(os.tmpdir(), `voice-${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[Voice] Wrote temp file: ${tmpPath}`);

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpPath),
    });

    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}

    console.log(`[Voice] Transcribed: "${transcription.text.substring(0, 100)}..."`);
    return transcription.text;
  } catch (err) {
    console.error("[Voice] Transcription error:", err.message);
    if (err.response) {
      console.error("[Voice] API response:", JSON.stringify(err.response?.data || err.response?.body || "no body"));
    }
    return null;
  }
}

// --- Document Text Extraction ---
async function extractDocumentText(buffer, fileName) {
  const ext = pathMod.extname(fileName || "").toLowerCase();

  // VTT/SRT: strip timestamps for cleaner transcript
  if (ext === ".vtt" || ext === ".srt") {
    let text = buffer.toString("utf-8");
    text = text.replace(/^WEBVTT\s*\n/, "");
    text = text.replace(/^\d+\s*\n/gm, "");
    text = text.replace(/[\d:.]+ --> [\d:.]+.*\n/g, "");
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  // Text-based formats
  if ([".txt", ".md", ".csv", ".json"].includes(ext)) {
    return buffer.toString("utf-8");
  }

  // PDF: proper text extraction using pdf-parse
  if (ext === ".pdf") {
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      const text = data.text.trim();
      return text.length > 50 ? text : null;
    } catch (err) {
      console.error("[Document] PDF parse error:", err.message);
      return null;
    }
  }

  // DOCX: basic text extraction
  if (ext === ".docx") {
    const text = buffer.toString("utf-8")
      .replace(/[^\x20-\x7E\n\r\t]/g, " ")
      .replace(/ {3,}/g, " ")
      .trim();
    return text.length > 100 ? text : null;
  }

  return null;
}

// --- System Prompts ---
const OWNER_SYSTEM_PROMPT = `You are Claude EA, Greg Francis's executive assistant. CEO of GF Development LLC (land acquisition, entitlements, lot sales). Direct, blunt, no fluff, 2-3 sentences max. No emojis. No dashes.

Use tools proactively. If Greg asks about emails, search immediately. Drafts are always safe. Confirm before sending emails or changing calendar.

Images: You CAN see images and screenshots shared in Slack. When Greg shares a screenshot, read it carefully and extract all visible information (sender names, subject lines, dates, email content, URLs, etc.) before responding. Never say you cannot see images.

Gmail: search by name not email address. If no results, broaden the search automatically. Try at least 2 queries before saying not found.

Triage corrections: when Greg says a sender is "noise" or should be "starred" (e.g. "Upwork is noise", "brian star", "noise zoom"), you MUST call apply_triage_correction as your FIRST tool call. Do not just acknowledge it verbally. The correction is not saved unless the tool is called.

Transcripts: when Greg uploads a document, use process_transcript with the file_ref. Meeting notes are auto-detected and tracked in a Google Sheet tracker (no Slack notifications). Greg reviews and approves them in the sheet. When Greg asks about past meetings (e.g. "what did we discuss about drainage" or "find meeting notes with Knox"), use search_meeting_notes. When Greg says "backfill meeting notes", call the backfill_meeting_notes tool immediately. It scans 6 months of emails + all Gemini Notes from Drive and adds them to the tracker sheet. This takes several minutes.

GHL/CRM: When asked about contacts, leads, deals, or notes, use GHL tools. search_contacts for finding people, get_contact for full details, search_deals for opportunities, get_deal_notes for notes. crm_deal_brief combines all into one call. GHL pulls from Go High Level CRM automatically.

CONTRACT DRAFTING: When Greg asks to draft an offer, extension, or cancellation, use draft_contract with step "gather" FIRST. This pulls deal data from pipeline AND GHL CRM automatically, filling in seller info, property details, and deal terms. It returns what we have and what's still missing. Ask Greg for any missing fields in ONE message (not one at a time). Also confirm: which state? include cover letter? include about me page? any special terms? Then call draft_contract with step "generate" and all the fields to create the .docx. This uses templates and takes 3-5 seconds. For other contract types (amendment, assignment, lot-sale, option, earnest-money), the tool falls back to AI drafting which takes 30-60 seconds. If Greg just wants to format text he already wrote into a .docx, use generate_contract_doc instead.

Deal briefs: When Greg asks about a deal status, what's happening on a deal, or what needs to happen next, use deal_brief FIRST. It pulls recent emails, project files, pipeline sheet, calendar events, meeting notes, and knowledge base results into one comprehensive view. Present the results organized by section and highlight what changed recently and what needs attention next.

Knowledge base: ALWAYS try search_knowledge_base FIRST when Greg asks about document contents, contract terms, deal history, meeting discussions, closing dates, feasibility dates, or anything that might be in Drive files. It semantically searches all indexed Google Drive documents and returns actual text from inside the files. Only fall back to search_drive + read_drive_file if the knowledge base returns no results. Cite sources with Drive links when returning results.

Web search: You have web_search available for real-time research, market data, company lookups, news, and anything not in Greg's files. Use it when the question needs current information from the internet. Multiple searches per response are fine.

SCHEDULED SYSTEMS (running 24/7 on VPS):
Daily Briefings (7am, 12pm, 5pm CST): Consolidated report with inbox triage stats (starred, fyi, noise, newsletters + details), deal activity digest, upcoming subscription renewals, and pending meeting notes. All three are full reports. Greg is actively monitoring these to refine accuracy before trimming down.
Background systems (no DMs unless notable):
- Email Triage: every 15 min (5am-11pm CST), 60 min overnight. Classifies inbox, applies labels, DMs on starred/actionable.
- Email Tasks: every triage cycle. Processes emails to greg+task@gfdevllc.com.
- Drive Watcher: every 30 min (6am-10pm CST). Detects new/changed files in deal folders.
- RAG Knowledge Base Sync: every 1 hour (6am-10pm CST). Re-indexes Drive documents.
- Quo Phone Polling: every 15 min daytime, 60 min overnight. Captures calls and SMS.
- Recovery Doc Backup: daily at 6:05am CST.
When Greg asks about scheduled systems, list these with schedules. All ALWAYS running, not on-demand.

Team: Rachel Rife (PM), Brian Chaplin (Acquisitions, La Pine OR deals), Marwan Mousa (Leads).
Priorities: 1) Cash flow via La Pine deals 2) WASem Lot 3 close 3) Traditions North + Brio Vista long-term.

Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Greg's TZ: CST (Mexico).`;

const TEAM_SYSTEM_PROMPT = `You are Claude EA, the GFDev Brain. Speaking with a team member (not Greg). Direct, helpful, 2-3 sentences max. No emojis. No dashes.

Images: You CAN see images and screenshots shared in Slack. Read them carefully and extract all visible information before responding. Never say you cannot see images.

Can do: search shared Drive files, search knowledge base (contracts, meeting notes, project docs), check calendar availability (busy/free only), read project files, look up deal pipeline, get deal briefs (team_deal_brief), search GHL CRM contacts (search_contacts), search deals (search_deals), get deal notes (get_deal_notes), get full CRM deal brief (crm_deal_brief).
Cannot do: email access, calendar event details, write files, take actions on Greg's behalf. Say so plainly if asked.

GHL/CRM: When asked about contacts, leads, deals, or notes, use GHL tools. search_contacts for finding people, search_deals for opportunities, get_deal_notes for notes, crm_deal_brief for everything at once.

Deal briefs: When asked about a deal status, use team_deal_brief FIRST. It pulls project files, pipeline sheet, meeting notes, and knowledge base results into one view. Present the results organized and highlight what needs attention.

Format: Slack links (<URL|Text>), bullet points, TLDR first. Calendar times in human-readable CST format.

GF Development: land acquisition, entitlements, lot sales. Markets: Idaho, Nevada, Washington.
Team: Greg (CEO), Rachel (PM), Brian (Acquisitions), Marwan (Leads).

Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Greg's TZ: CST (Mexico).`;

// --- Tool Execution ---
async function executeTool(toolName, toolInput, userId) {
  // Track usage for team members
  if (userId && permissions.isTeamOrAbove(userId) && !permissions.isOwner(userId)) {
    usage.trackUsage(userId, toolName).catch((err) =>
      console.error("[Usage] Track error:", err.message)
    );
  }

  switch (toolName) {
    case "search_emails":
      return await gmail.searchEmails(toolInput.query, toolInput.max_results);
    case "read_email":
      return await gmail.readEmail(toolInput.message_id);
    case "create_draft":
      return await gmail.createDraft(
        toolInput.to,
        toolInput.subject,
        toolInput.body
      );
    case "send_email":
      return await gmail.sendEmail(
        toolInput.to,
        toolInput.subject,
        toolInput.body
      );
    case "reply_to_email":
      return await gmail.replyToEmail(toolInput.message_id, toolInput.body);
    case "list_calendar_events":
      return await calendar.listEvents(toolInput.days_ahead);
    case "create_calendar_event":
      return await calendar.createEvent(
        toolInput.summary,
        toolInput.start,
        toolInput.end,
        {
          description: toolInput.description,
          location: toolInput.location,
          attendees: toolInput.attendees,
        }
      );
    case "update_calendar_event": {
      const updates = {};
      if (toolInput.summary) updates.summary = toolInput.summary;
      if (toolInput.start) updates.startDateTime = toolInput.start;
      if (toolInput.end) updates.endDateTime = toolInput.end;
      if (toolInput.description) updates.description = toolInput.description;
      if (toolInput.location) updates.location = toolInput.location;
      return await calendar.updateEvent(toolInput.event_id, updates);
    }
    case "delete_calendar_event":
      return await calendar.deleteEvent(toolInput.event_id);
    case "read_project_file":
      return await files.readProjectFile(toolInput.file_path);
    case "write_project_file":
      return await files.writeProjectFile(toolInput.file_path, toolInput.content);
    case "list_project_files":
      return await files.listProjectFiles(toolInput.directory);
    case "triage_inbox":
      return await gmail.triageInbox(toolInput.hours_back || 6);
    case "apply_email_label":
      return await gmail.applyLabelByName(toolInput.message_id, toolInput.label_name);
    case "list_labels":
      return await gmail.listLabels();
    case "remove_email_label":
      return await gmail.removeLabelByName(toolInput.message_id, toolInput.label_name);
    case "delete_label":
      return await gmail.deleteLabelByName(toolInput.label_name);
    case "learn_from_inbox":
      return await learning.learnFromGreg();
    case "apply_triage_correction":
      return learning.applyTriageCorrection(toolInput.sender, toolInput.action);
    case "upload_to_drive":
      return await drive.uploadFile(toolInput.file_name, toolInput.content, toolInput.mime_type, toolInput.folder_id);
    case "search_drive":
      return await drive.searchFiles(toolInput.query, toolInput.max_results);
    case "create_drive_folder":
      return await drive.findOrCreateFolder(toolInput.folder_name, toolInput.parent_id);
    case "read_drive_file":
      return await drive.readFile(toolInput.file_id);
    case "list_drive_folder":
      return await drive.listFolder(toolInput.folder_id, toolInput.max_results);
    case "backup_recovery_doc":
      return await drive.uploadRecoveryBackup();
    case "get_pipeline":
      return await pipeline.getPipelineSummary();
    case "lookup_deal":
      return await pipeline.lookupDeal(toolInput.deal_name);
    // --- Subscription tracking tools ---
    case "list_subscriptions":
      return subscriptions.listSubscriptions();
    case "upcoming_renewals": {
      const upcoming = subscriptions.getUpcomingRenewals(toolInput.days_ahead || 7);
      if (upcoming.length === 0) return "No subscriptions renewing in that timeframe.";
      return upcoming.map(s => `${s.name}: ${s.amount} (${s.cycle}) — renews ${s.next_renewal} (${s.days_until} days)\n  Cancel: ${s.cancel_url}`).join("\n\n");
    }
    case "mark_subscription_cancel":
      return subscriptions.markForCancellation(toolInput.name);
    case "mark_subscription_cancelled":
      return subscriptions.markCancelled(toolInput.name);
    case "update_deal":
      return await pipeline.updateDeal(toolInput.deal_name, toolInput.field, toolInput.value);
    case "read_spreadsheet":
      return await sheets.readSheet(toolInput.spreadsheet, toolInput.range);
    case "write_spreadsheet":
      return await sheets.writeSheet(toolInput.spreadsheet, toolInput.range, toolInput.values);
    case "append_spreadsheet":
      return await sheets.appendSheet(toolInput.spreadsheet, toolInput.range, toolInput.values);
    case "get_spreadsheet_info":
      return await sheets.getSpreadsheetInfo(toolInput.spreadsheet);
    case "log_decision":
      return await files.appendToDecisionLog(
        toolInput.decision,
        toolInput.reasoning,
        toolInput.context
      );
    // --- GHL CRM tools ---
    case "search_contacts":
      return await ghl.searchContacts(toolInput.query, toolInput.limit);
    case "get_contact":
      return await ghl.getContact(toolInput.contact_id);
    case "search_deals":
      return await ghl.searchOpportunities(toolInput.query, toolInput.pipeline_id);
    case "get_deal_notes": {
      const ghlData = await ghl.searchByDeal(toolInput.deal_name);
      return { contacts: ghlData.contacts, notes: ghlData.notes };
    }
    case "crm_deal_brief":
      return await ghl.crmDealBrief(toolInput.deal_name);
    case "draft_contract": {
      const step = toolInput.step || "gather";
      const docType = toolInput.doc_type || "offer";
      const state = toolInput.state || "WA";

      if (step === "gather") {
        return await contractDrafter.initDraft(toolInput.deal_name, docType, state);
      } else if (step === "generate") {
        const fields = { ...(toolInput.fields || {}), deal_name: toolInput.deal_name };
        return await contractDrafter.generateFromTemplate(docType, state, fields, {
          includeCoverLetter: toolInput.include_cover_letter !== false,
          includeAboutMe: toolInput.include_about_me !== false,
          customTerms: toolInput.custom_terms,
        });
      } else {
        return await contractDrafter.runContractDrafter(toolInput.deal_name, docType, toolInput.custom_terms);
      }
    }
    case "generate_contract_doc":
      return await contracts.generateContractDoc(toolInput.contract_text, toolInput.file_name, toolInput.doc_type, toolInput.deal_name);
    case "process_transcript":
      return await transcript.processTranscript(toolInput);
    case "search_meeting_notes":
      return await meetingNotes.searchMeetingNotes(toolInput.query, permissions.isOwner(userId));
    case "backfill_meeting_notes":
      return await meetingNotes.backfillMeetingNotes((msg) => console.log(`[Backfill] ${msg}`));
    // --- Quo (phone system) tools ---
    case "quo_search":
      return await quo.searchQuoActivity(toolInput.query);
    case "quo_backfill":
      return await quo.backfillQuo(toolInput.days_back || 30, (msg) => console.log(`[Quo Backfill] ${msg}`));
    // --- Deal Brief tools ---
    case "deal_brief":
      return await dealBrief.getDealBrief(toolInput.deal_name, toolInput.days_back || 7);
    case "team_deal_brief":
      return await dealBrief.getTeamDealBrief(toolInput.deal_name);
    case "drive_deal_snapshot": {
      const snapshot = driveWatcher.getSnapshot();
      if (snapshot.error) return snapshot.error;
      let out = `*Deal Folders by Status* (last scan: ${snapshot.lastScan})\n`;
      for (const [status, deals] of Object.entries(snapshot.byStatus)) {
        out += `\n*${status}* (${deals.length}):\n`;
        deals.sort().forEach((d) => { out += `  ${d}\n`; });
      }
      out += `\nTotal: ${snapshot.totalDeals} deal folders`;
      return out;
    }
    // --- Knowledge Base (RAG) tools ---
    case "search_knowledge_base": {
      const isTeam = !permissions.isOwner(userId);
      return await rag.search(toolInput.query, {
        deal: toolInput.deal_filter,
        fileType: toolInput.file_type_filter,
        teamOnly: isTeam,
      }, toolInput.max_results || 5);
    }
    case "rag_sync_status":
      return await rag.getStats();
    case "rag_reindex":
      return await rag.fullReindex((msg) => console.log(`[RAG] ${msg}`));
    // --- Team tools ---
    case "team_search_drive":
      return await driveTeam.teamSearchDrive(
        toolInput.query,
        toolInput.max_results,
        permissions.getTeamDriveFolders()
      );
    case "team_list_drive_folder":
      return await driveTeam.teamListFolder(
        toolInput.folder_id,
        toolInput.max_results,
        permissions.getTeamDriveFolders()
      );
    case "team_read_drive_file":
      return await driveTeam.teamReadFile(
        toolInput.file_id,
        permissions.getTeamDriveFolders()
      );
    case "check_freebusy":
      return await calendarFreebusy.checkFreeBusy(
        toolInput.start_date,
        toolInput.end_date
      );
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// --- Agent Loop ---
const MAX_TOOL_RESULT_CHARS = 3000; // Truncate large tool results to save tokens

function truncateResult(resultStr) {
  if (resultStr.length <= MAX_TOOL_RESULT_CHARS) return resultStr;
  return resultStr.substring(0, MAX_TOOL_RESULT_CHARS) + '... [truncated, ' + resultStr.length + ' total chars]';
}

// Sonnet pricing per million tokens
const TOKEN_COSTS = {
  input: 3.0,
  output: 15.0,
  cache_write: 3.75,
  cache_read: 0.30,
};

function calcCost(usage) {
  const m = 1_000_000;
  return (
    ((usage.input_tokens || 0) * TOKEN_COSTS.input +
      (usage.output_tokens || 0) * TOKEN_COSTS.output +
      (usage.cache_creation_input_tokens || 0) * TOKEN_COSTS.cache_write +
      (usage.cache_read_input_tokens || 0) * TOKEN_COSTS.cache_read) / m
  );
}

function formatUsage(totals) {
  const cached = totals.cache_read_input_tokens;
  const totalIn = totals.input_tokens + totals.cache_creation_input_tokens + cached;
  const cost = calcCost(totals);
  const parts = [`${totals.api_calls} call${totals.api_calls === 1 ? "" : "s"}`];
  if (cached > 0) {
    parts.push(`${Math.round(totalIn / 1000)}K in (${Math.round(cached / 1000)}K cached)`);
  } else {
    parts.push(`${Math.round(totalIn / 1000)}K in`);
  }
  parts.push(`${Math.round(totals.output_tokens / 1000)}K out`);
  parts.push(`$${cost.toFixed(3)}`);
  return parts.join(", ");
}

async function runAgent(userId, messages, systemPrompt, tools) {
  const maxIterations = 10;

  // Enable prompt caching: system prompt and tools are identical every call,
  // so cached reads don't count against the input token rate limit.
  const cachedSystem = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  // Put cache_control on the last client tool (skip server tools like web_search)
  const lastClientIdx = tools.reduce((acc, t, i) => !t.type ? i : acc, -1);
  const cachedTools = tools.map((t, i) =>
    i === lastClientIdx ? { ...t, cache_control: { type: "ephemeral" } } : t
  );

  const totals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, api_calls: 0 };

  for (let i = 0; i < maxIterations; i++) {
    let response;
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: cachedSystem,
        tools: cachedTools,
        messages,
      });
    } catch (err) {
      // Rate limit: wait and retry once
      if (err.status === 429) {
        const retryAfter = parseInt(err.headers?.["retry-after"] || "30", 10);
        console.log(`[Agent] Rate limited. Waiting ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        try {
          response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            system: cachedSystem,
            tools: cachedTools,
            messages,
          });
        } catch (retryErr) {
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    // Accumulate token usage
    if (response.usage) {
      totals.input_tokens += response.usage.input_tokens || 0;
      totals.output_tokens += response.usage.output_tokens || 0;
      totals.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
      totals.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
      totals.api_calls++;
    }

    // Collect text and tool use from response
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // If no tool use, we're done. Extract text + usage summary.
    if (response.stop_reason === "end_turn") {
      const textParts = assistantContent
        .filter((block) => block.type === "text")
        .map((block) => block.text);
      const reply = textParts.join("\n");
      const usageLine = `\n\n_${formatUsage(totals)}_`;
      console.log(`[Usage] ${formatUsage(totals)}`);
      return reply + usageLine;
    }

    // Process tool calls
    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool] ${block.name}:`, JSON.stringify(block.input).substring(0, 200));
        try {
          const result = await executeTool(block.name, block.input, userId);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          // Compound tools and subagents need more space
          const bigTools = ["deal_brief", "team_deal_brief", "draft_contract"];
          const limit = bigTools.includes(block.name) ? 15000 : MAX_TOOL_RESULT_CHARS;
          const truncated = resultStr.length > limit
            ? resultStr.substring(0, limit) + '... [truncated, ' + resultStr.length + ' total chars]'
            : resultStr;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: truncated,
          });
        } catch (err) {
          console.error(`[Tool Error] ${block.name}:`, err.message);
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

  const usageLine = `\n\n_${formatUsage(totals)}_`;
  console.log(`[Usage] ${formatUsage(totals)}`);
  return "Hit the tool use limit. Try breaking your request into smaller pieces." + usageLine;
}

// --- Conversation History ---
const conversations = new Map();

function getHistory(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  return conversations.get(userId);
}

function trimHistory(history) {
  // Keep last 30 messages to manage context but allow for tool use rounds
  while (history.length > 30) {
    history.shift();
  }
}

// --- Message Handler ---
app.message(async ({ message, say }) => {
  // Allow file_share (voice notes, attachments) through; skip other subtypes
  if (message.subtype && message.subtype !== "file_share") return;

  const userId = message.user;
  let text = message.text || "";

  // Debug: log all files attached to this message
  if (message.files && message.files.length > 0) {
    console.log(`[Files] ${message.files.length} file(s) in message:`,
      JSON.stringify(message.files.map(f => ({ name: f.name, mime: f.mimetype, filetype: f.filetype, size: f.size, mode: f.mode }))));
  }

  // Check for audio files (voice notes)
  const audioFile = (message.files || []).find((f) =>
    AUDIO_MIME_TYPES.some((mime) => (f.mimetype || "").startsWith(mime.split("/")[0]))
  );

  if (audioFile) {
    if (!openai) {
      await say("Voice notes require an OpenAI API key. Ask Greg to add OPENAI_API_KEY to the bot config.");
      return;
    }
    await say("Transcribing voice note...");
    const transcription = await transcribeAudio(
      audioFile.url_private_download || audioFile.url_private,
      audioFile.name
    );
    if (!transcription) {
      await say("Could not transcribe that voice note. Try again or type your message.");
      return;
    }
    // If Greg sent text with the voice note, prepend it
    text = text ? `${text}\n\n[Voice note transcription]: ${transcription}` : transcription;
    await say(`*Transcribed:* ${transcription}`);
  }

  // Check for document files (transcripts, notes, meeting exports)
  if (!audioFile) {
    const docFile = (message.files || []).find((f) => {
      const ext = pathMod.extname(f.name || "").toLowerCase();
      return DOCUMENT_MIME_TYPES.some((mime) => (f.mimetype || "").startsWith(mime)) ||
        [".txt", ".md", ".pdf", ".docx", ".json", ".vtt", ".srt", ".csv"].includes(ext);
    });

    if (docFile) {
      try {
        console.log(`[Document] Downloading ${docFile.name} (${docFile.mimetype})...`);
        const buffer = await downloadSlackFile(
          docFile.url_private_download || docFile.url_private,
          process.env.SLACK_BOT_TOKEN
        );
        const extractedText = await extractDocumentText(buffer, docFile.name);
        if (extractedText && extractedText.length > 50) {
          const fileRef = transcript.storeUploadedFile(extractedText, docFile.name, docFile.mimetype);
          const sizeKB = (extractedText.length / 1024).toFixed(1);
          text = text
            ? `${text}\n\n[Uploaded document: ${docFile.name} (${sizeKB} KB text extracted). File reference: ${fileRef}. Use process_transcript tool to summarize and file this transcript.]`
            : `[Uploaded document: ${docFile.name} (${sizeKB} KB text extracted). File reference: ${fileRef}. Use process_transcript tool to summarize and file this transcript.]`;
          console.log(`[Document] Extracted ${extractedText.length} chars from ${docFile.name}, ref: ${fileRef}`);
        } else {
          console.log(`[Document] Could not extract usable text from ${docFile.name}`);
        }
      } catch (err) {
        console.error("[Document] Extraction error:", err.message);
      }
    }
  }

  // Check for image files (screenshots, photos)
  // Match by mimetype, file extension, OR Slack filetype field for robustness
  const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  const IMAGE_FILETYPES = ["png", "jpg", "jpeg", "gif", "webp"];
  let imageBlocks = [];
  if (!audioFile) {
    const imageFiles = (message.files || []).filter((f) => {
      const mime = (f.mimetype || "").toLowerCase();
      const ext = pathMod.extname(f.name || "").toLowerCase();
      const ftype = (f.filetype || "").toLowerCase();
      return IMAGE_MIME_TYPES.includes(mime) ||
        IMAGE_EXTENSIONS.includes(ext) ||
        IMAGE_FILETYPES.includes(ftype);
    });
    console.log(`[Image] Detection: ${(message.files || []).length} total files, ${imageFiles.length} images matched`);
    for (const imgFile of imageFiles) {
      try {
        // Determine media type for Claude API (prefer mimetype, fall back to extension)
        let mediaType = IMAGE_MIME_TYPES.includes((imgFile.mimetype || "").toLowerCase())
          ? imgFile.mimetype.toLowerCase()
          : `image/${imgFile.filetype || pathMod.extname(imgFile.name || ".png").replace(".", "")}`;
        console.log(`[Image] Downloading ${imgFile.name} (${mediaType}, ${((imgFile.size || 0) / 1024).toFixed(1)} KB)...`);
        if (imgFile.size && imgFile.size > MAX_IMAGE_BYTES) {
          console.log(`[Image] Skipping ${imgFile.name} — too large (${(imgFile.size / 1024 / 1024).toFixed(1)} MB)`);
          continue;
        }
        const fileUrl = imgFile.url_private_download || imgFile.url_private;
        if (!fileUrl) {
          console.error(`[Image] No download URL for ${imgFile.name}. File object:`, JSON.stringify(imgFile).substring(0, 300));
          continue;
        }
        const buffer = await downloadSlackFile(fileUrl, process.env.SLACK_BOT_TOKEN);
        if (buffer.length < 100) {
          console.error(`[Image] Downloaded file too small (${buffer.length} bytes), likely not an image`);
          continue;
        }
        const base64 = buffer.toString("base64");
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: base64 },
        });
        console.log(`[Image] Added ${imgFile.name} (${(buffer.length / 1024).toFixed(1)} KB, ${mediaType})`);
      } catch (err) {
        console.error(`[Image] Failed to download ${imgFile.name}:`, err.message);
      }
    }
    if (imageBlocks.length > 0) {
      console.log(`[Image] ${imageBlocks.length} image(s) will be sent to Claude API`);
    }
  }

  if (!text && imageBlocks.length === 0) return;

  const tier = permissions.getUserTier(userId);
  const systemPrompt = tier === "owner" ? OWNER_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;
  const tools = tier === "owner" ? OWNER_TOOLS : tier === "team" ? TEAM_TOOLS : PUBLIC_TOOLS;

  const history = getHistory(userId);
  // Use content blocks array when images are present, plain text otherwise
  if (imageBlocks.length > 0) {
    const content = [];
    if (text) content.push({ type: "text", text });
    content.push(...imageBlocks);
    if (!text) content.push({ type: "text", text: "What's in this image?" });
    history.push({ role: "user", content });
  } else {
    history.push({ role: "user", content: text });
  }
  trimHistory(history);

  try {
    // Send immediate acknowledgment so nobody waits with no response
    if (tier === "owner") {
      await say("Got it, working on it...");
    } else if (tier === "team") {
      await say("Checking, one moment...");
    }

    // Set a 60-second status update timer
    const statusTimer = setTimeout(async () => {
      try { await say("Still working on it..."); } catch (e) {}
    }, 60000);

    const reply = await runAgent(userId, [...history], systemPrompt, tools);
    clearTimeout(statusTimer);

    // Add final reply to history (simplified, text only)
    history.push({ role: "assistant", content: reply });
    trimHistory(history);

    // Slack has a 3000 char limit per message, split if needed
    if (reply.length <= 3000) {
      await say(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,3000}/g) || [reply];
      for (const chunk of chunks) {
        await say(chunk);
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
    if (error.message.includes("invalid_auth") || error.message.includes("token")) {
      await say("Authentication error. Greg needs to check the bot tokens in Claude Code.");
    } else if (error.message.includes("googleapis")) {
      await say("Google API error. The Gmail/Calendar connection may need to be set up or refreshed.");
    } else {
      await say("Hit an error processing that. Check the bot logs.");
    }
  }
});

// --- Also respond to @mentions in channels ---
app.event("app_mention", async ({ event, say }) => {
  const userId = event.user;
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  // Check for image files in mentions
  let imageBlocks = [];
  const imageFiles = (event.files || []).filter((f) => {
    const mime = (f.mimetype || "").toLowerCase();
    const ext = pathMod.extname(f.name || "").toLowerCase();
    const ftype = (f.filetype || "").toLowerCase();
    return IMAGE_MIME_TYPES.includes(mime) ||
      [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) ||
      ["png", "jpg", "jpeg", "gif", "webp"].includes(ftype);
  });
  for (const imgFile of imageFiles) {
    try {
      if (imgFile.size && imgFile.size > MAX_IMAGE_BYTES) continue;
      const fileUrl = imgFile.url_private_download || imgFile.url_private;
      if (!fileUrl) continue;
      const buffer = await downloadSlackFile(fileUrl, process.env.SLACK_BOT_TOKEN);
      if (buffer.length < 100) continue;
      const mediaType = IMAGE_MIME_TYPES.includes((imgFile.mimetype || "").toLowerCase())
        ? imgFile.mimetype.toLowerCase()
        : `image/${imgFile.filetype || pathMod.extname(imgFile.name || ".png").replace(".", "")}`;
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
      });
    } catch (err) {
      console.error(`[Image] Failed to download ${imgFile.name}:`, err.message);
    }
  }

  if (!text && imageBlocks.length === 0) return;

  const tier = permissions.getUserTier(userId);
  const systemPrompt = tier === "owner" ? OWNER_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;
  const tools = tier === "owner" ? OWNER_TOOLS : tier === "team" ? TEAM_TOOLS : PUBLIC_TOOLS;

  const history = getHistory(userId);
  if (imageBlocks.length > 0) {
    const content = [];
    if (text) content.push({ type: "text", text });
    content.push(...imageBlocks);
    if (!text) content.push({ type: "text", text: "What's in this image?" });
    history.push({ role: "user", content });
  } else {
    history.push({ role: "user", content: text });
  }
  trimHistory(history);

  try {
    if (tier === "owner") {
      await say("Got it, working on it...");
    } else if (tier === "team") {
      await say("Checking, one moment...");
    }

    const statusTimer = setTimeout(async () => {
      try { await say("Still working on it..."); } catch (e) {}
    }, 60000);

    const reply = await runAgent(userId, [...history], systemPrompt, tools);
    clearTimeout(statusTimer);

    history.push({ role: "assistant", content: reply });
    trimHistory(history);

    if (reply.length <= 3000) {
      await say(reply);
    } else {
      const chunks = reply.match(/[\s\S]{1,3000}/g) || [reply];
      for (const chunk of chunks) {
        await say(chunk);
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
    await say("Hit an error processing that. Check the bot logs.");
  }
});

// --- Auto Triage Scheduler ---
// 5am-11pm CST: every 15 min. 11pm-5am: every 60 min.
const TRIAGE_INTERVAL_DAY = 15 * 60 * 1000;   // 15 minutes
const TRIAGE_INTERVAL_NIGHT = 60 * 60 * 1000;  // 60 minutes
const DAY_START_HOUR = 5;   // 5am CST
const DAY_END_HOUR = 23;    // 11pm CST
let triageTimer = null;

function getCSTHour() {
  const now = new Date();
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  return cst.getHours();
}

function getTriageInterval() {
  const hour = getCSTHour();
  return (hour >= DAY_START_HOUR && hour < DAY_END_HOUR)
    ? TRIAGE_INTERVAL_DAY
    : TRIAGE_INTERVAL_NIGHT;
}

function scheduleNextTriage() {
  if (triageTimer) clearTimeout(triageTimer);
  const interval = getTriageInterval();
  triageTimer = setTimeout(async () => {
    await runAutoTriage();
    scheduleNextTriage();
  }, interval);
  const mins = interval / 60000;
  console.log(`[Auto-Triage] Next run in ${mins} minutes (CST hour: ${getCSTHour()}).`);
}

async function runAutoTriage() {
  try {
    console.log("[Learning] Running pre-triage learning pass...");
    try {
      const learnResults = await learning.learnFromGreg();
      if (learnResults.corrections > 0) {
        console.log(
          `[Learning] ${learnResults.corrections} corrections found, ${learnResults.profile_updates} profile updates.`
        );
      }
      // Ask Greg about confused senders (max once per 24h per sender)
      if (learnResults.confused && learnResults.confused.length > 0) {
        // Filter out senders we already asked about recently
        const now = Date.now();
        const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
        if (!global._confusedAskedAt) global._confusedAskedAt = {};
        const newConfused = learnResults.confused.filter((c) => {
          const lastAsked = global._confusedAskedAt[c.sender] || 0;
          return (now - lastAsked) > COOLDOWN_MS;
        });
        if (newConfused.length > 0) {
          const questions = newConfused.map((c) =>
            `• "${c.sender}" has ${c.starred_count} starred and ${c.noise_count} noise labels. Star future emails from them?`
          ).join("\n");
          try {
            const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
            await app.client.chat.postMessage({
              channel: dmChannel.channel.id,
              text: `*Quick question on email triage:*\n${questions}\n\nJust reply with the sender name and "star" or "noise" (e.g. "zoom noise" or "brian star").`,
            });
            for (const c of newConfused) {
              global._confusedAskedAt[c.sender] = now;
            }
          } catch (e) {
            console.error("[Learning] Could not send confusion DM:", e.message);
          }
        }
      }
    } catch (err) {
      console.error("[Learning] Error (non-fatal):", err.message);
    }

    // Check email tasks BEFORE triage (runs regardless of new emails)
    try {
      await processEmailTasks();
    } catch (err) {
      console.error("[Email Tasks] Error:", err.message);
    }

    console.log("[Auto-Triage] Running scheduled inbox triage...");
    const results = await gmail.triageInbox(2);

    if (results.triaged === 0) {
      console.log("[Auto-Triage] No new emails to triage.");
      return;
    }

    console.log(
      `[Auto-Triage] Triaged ${results.triaged}: ${results.starred} starred, ${results.fyi || 0} fyi, ${results.dealLabeled || 0} deal-labeled, ${results.needsLabel || 0} needs-label, ${results.fileLabeled || 0} with attachments, ${results.newsletters} newsletters, ${results.noise} noise archived, ${results.aiCalls || 0} AI calls`
    );

    const hasAccounting = (results.acctPaid || 0) + (results.acctUnpaid || 0) + (results.acctNeedsLabel || 0) > 0;

    // Notify Greg in DM if there are action items, deal labels, needs-label, or accounting emails
    if (results.starred > 0 || results.dealLabeled > 0 || results.needsLabel > 0 || hasAccounting) {
      const starredEmails = results.details
        .filter((d) => d.category === "EA/Action")
        .map((d) => {
          const fromName = d.from.replace(/<.*>/, "").trim();
          const deal = d.dealLabel && d.dealLabel !== "none" && d.dealLabel !== "unknown" ? ` [${d.dealLabel}]` : "";
          return `• ${fromName} — ${d.subject}${deal}`;
        })
        .join("\n");

      const dealEmails = results.details
        .filter((d) => d.dealLabel && d.dealLabel !== "none" && d.dealLabel !== "unknown" && d.category !== "EA/Action")
        .map((d) => {
          const fromName = d.from.replace(/<.*>/, "").trim();
          return `• ${fromName} — ${d.subject} → ${d.dealLabel}`;
        })
        .join("\n");

      const needsLabelEmails = results.details
        .filter((d) => d.dealLabel === "unknown")
        .map((d) => {
          const fromName = d.from.replace(/<.*>/, "").trim();
          return `• ${fromName} — ${d.subject}`;
        })
        .join("\n");

      const acctUnpaidEmails = results.details
        .filter((d) => d.accounting === "unpaid")
        .map((d) => {
          const fromName = d.from.replace(/<.*>/, "").trim();
          return `• ${fromName} — ${d.subject}`;
        })
        .join("\n");

      const acctNeedsLabelEmails = results.details
        .filter((d) => d.accounting === "unknown-accounting")
        .map((d) => {
          const fromName = d.from.replace(/<.*>/, "").trim();
          return `• ${fromName} — ${d.subject}`;
        })
        .join("\n");

      let message = `*Inbox triage:* ${results.starred} starred, ${results.fyi || 0} fyi, ${results.dealLabeled || 0} deal-labeled, ${results.needsLabel || 0} needs label, ${results.fileLabeled || 0} filed, ${results.newsletters} newsletters, ${results.noise} noise archived (${results.aiCalls || 0} AI reads).`;
      if (hasAccounting) message += ` Accounting: ${results.acctPaid || 0} paid, ${results.acctUnpaid || 0} unpaid, ${results.acctNeedsLabel || 0} needs review.`;
      if (starredEmails) message += `\n\n*Starred:*\n${starredEmails}`;
      if (dealEmails) message += `\n\n*Deal-labeled:*\n${dealEmails}`;
      if (needsLabelEmails) message += `\n\n*Needs deal label (check "EA/Needs Label" in Gmail):*\n${needsLabelEmails}`;
      if (acctUnpaidEmails) message += `\n\n*Unpaid invoices (check "Accounting/Unpaid"):*\n${acctUnpaidEmails}`;
      if (acctNeedsLabelEmails) message += `\n\n*Accounting needs review (check "Accounting/Needs Label"):*\n${acctNeedsLabelEmails}`;

      const dmChannel = await app.client.conversations.open({
        users: OWNER_USER_ID,
      });

      await app.client.chat.postMessage({
        channel: dmChannel.channel.id,
        text: message,
      });
    }
  } catch (err) {
    console.error("[Auto-Triage] Error:", err.message);
  }

  // --- Post-Triage: Detect meeting notes -> inbox sheet (silent) ---
  try {
    const emailReports = await meetingNotes.checkRecentMeetingEmails();
    const geminiReports = await meetingNotes.checkGeminiNotes();
    const dropReports = await meetingNotes.checkDropFolder();
    const added = [...emailReports, ...geminiReports, ...dropReports].filter((r) => r.success);
    if (added.length > 0) {
      console.log(`[Meeting Notes] Added ${added.length} to inbox sheet.`);
    }
  } catch (err) {
    console.error("[Meeting Notes] Detection error:", err.message);
  }

  // --- Post-Triage: File any approved meeting notes from sheet ---
  try {
    const filed = await meetingNotes.processApprovedNotes();
    if (filed.length > 0) {
      console.log(`[Meeting Notes] Filed ${filed.length} approved notes to deal folders.`);
    }
  } catch (err) {
    console.error("[Meeting Notes] Approval processing error:", err.message);
  }

}

// --- Email Task Processing ---
// Greg forwards emails to greg+task@gfdevllc.com (or labels them EA/Task)
// Bot picks them up each triage cycle, runs through agent, DMs result

function parseForwardedEmail(body, subject) {
  if (!body) return { instructions: null, forwardedContent: null, forwardedFrom: null, forwardedSubject: null };

  const fwdPatterns = [
    /---------- Forwarded message ---------/i,
    /---------- Forwarded message ----------/i,
    /Begin forwarded message:/i,
    /-----Original Message-----/i,
    /--- Forwarded message ---/i,
  ];

  let splitIndex = -1;
  let matchLength = 0;
  for (const pattern of fwdPatterns) {
    const match = body.match(pattern);
    if (match) {
      splitIndex = match.index;
      matchLength = match[0].length;
      break;
    }
  }

  if (splitIndex === -1) {
    // No forwarding markers — direct email to +task address
    return { instructions: body.trim(), forwardedContent: null, forwardedFrom: null, forwardedSubject: null };
  }

  const instructions = body.substring(0, splitIndex).trim();
  const forwarded = body.substring(splitIndex + matchLength).trim();

  // Extract From and Subject from forwarded headers
  let forwardedFrom = null;
  let forwardedSubject = null;
  const fromMatch = forwarded.match(/^From:?\s*(.+?)$/m);
  if (fromMatch) forwardedFrom = fromMatch[1].trim();
  const subjMatch = forwarded.match(/^Subject:?\s*(.+?)$/m);
  if (subjMatch) forwardedSubject = subjMatch[1].trim();

  return { instructions: instructions || null, forwardedContent: forwarded, forwardedFrom, forwardedSubject };
}

async function processEmailTasks() {
  try {
    const doneLabel = await gmail.getOrCreateLabel("EA/Task-Done");
    const triagedLabel = await gmail.getOrCreateLabel("EA/Triaged");
    // Also create EA/Task label so Greg can use it for manual labeling
    await gmail.getOrCreateLabel("EA/Task");

    const gmailClient = gmail.getGmail();
    // Search for: forwarded to +task address OR manually labeled EA/Task
    const res = await gmailClient.users.messages.list({
      userId: "me",
      q: '{to:"greg+task@gfdevllc.com" label:EA-Task} newer_than:24h',
      maxResults: 10,
    });

    if (!res.data.messages || res.data.messages.length === 0) return;

    // Filter out already-processed emails
    const toProcess = [];
    for (const msg of res.data.messages) {
      const meta = await gmailClient.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "minimal",
      });
      const labels = meta.data.labelIds || [];
      if (!labels.includes(doneLabel.id)) {
        toProcess.push(msg);
      }
    }

    if (toProcess.length === 0) return;

    console.log(`[Email Tasks] Found ${toProcess.length} task email(s).`);

    for (const msg of toProcess) {
      try {
        const email = await gmail.readEmail(msg.id);

        const { instructions, forwardedContent, forwardedFrom, forwardedSubject } = parseForwardedEmail(email.body, email.subject);

        // Build the prompt for the agent
        let taskPrompt;
        if (instructions && forwardedContent) {
          taskPrompt = `[EMAIL TASK] Greg forwarded an email with these instructions:\n\n"${instructions}"\n\n--- Original email ---\nFrom: ${forwardedFrom || "unknown"}\nSubject: ${forwardedSubject || email.subject}\n\n${forwardedContent}`;
        } else if (forwardedContent) {
          taskPrompt = `[EMAIL TASK] Greg forwarded this email without instructions. Summarize it and identify any action items.\n\nFrom: ${forwardedFrom || "unknown"}\nSubject: ${forwardedSubject || email.subject}\n\n${forwardedContent}`;
        } else if (instructions) {
          taskPrompt = `[EMAIL TASK] Greg sent this task via email:\n\nSubject: ${email.subject}\n\n${instructions}`;
        } else {
          taskPrompt = `[EMAIL TASK] Greg sent this email as a task but it appears empty. Subject: ${email.subject}`;
        }

        taskPrompt += `\n\nIMPORTANT: For email tasks, create drafts instead of sending emails directly. Do not send anything without Greg's explicit Slack approval.`;

        // Run through agent with owner permissions
        const messages = [{ role: "user", content: taskPrompt }];
        const result = await runAgent(OWNER_USER_ID, messages, OWNER_SYSTEM_PROMPT, OWNER_TOOLS);

        // DM Greg the result
        const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
        const subjectShort = email.subject.length > 60 ? email.subject.substring(0, 57) + "..." : email.subject;
        // Strip usage footer for cleaner DM
        const cleanResult = result.replace(/\n\n_\d+ calls?.*\$[\d.]+_$/, "");
        const trimmed = cleanResult.length > 3000 ? cleanResult.substring(0, 3000) + "..." : cleanResult;

        await app.client.chat.postMessage({
          channel: dmChannel.channel.id,
          text: `*Email task processed:* ${subjectShort}\n\n${trimmed}`,
        });

        // Mark as done
        await gmailClient.users.messages.modify({
          userId: "me",
          id: msg.id,
          requestBody: {
            addLabelIds: [doneLabel.id, triagedLabel.id],
          },
        });

        console.log(`[Email Tasks] Processed: ${email.subject}`);
      } catch (taskErr) {
        console.error(`[Email Tasks] Failed to process ${msg.id}:`, taskErr.message);
        // Mark as done to prevent retry loops
        try {
          await gmailClient.users.messages.modify({
            userId: "me",
            id: msg.id,
            requestBody: { addLabelIds: [doneLabel.id] },
          });
        } catch (_) {}
        // Notify Greg of the failure
        try {
          const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
          await app.client.chat.postMessage({
            channel: dmChannel.channel.id,
            text: `*Email task failed:* Could not process a forwarded email. Error: ${taskErr.message}`,
          });
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error("[Email Tasks] Error:", err.message);
  }
}

// --- Consolidated Daily Briefings ---
// Three daily briefings at 7am, 12pm, 5pm CST combining:
// inbox triage stats, deal digest, subscription scan, meeting notes pending, noise spot-check
const BRIEFING_HOURS = [7, 12, 17]; // 7am, noon, 5pm CST
const BRIEFING_LABELS = { 7: "Morning", 12: "Midday", 17: "End of Day" };
let briefingTimer = null;

function getNextBriefingTime() {
  const now = new Date();
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const currentHour = cst.getHours();
  const currentMin = cst.getMinutes();

  let targetHour = BRIEFING_HOURS.find((h) => h > currentHour || (h === currentHour && currentMin < 3));
  let daysToAdd = 0;
  if (!targetHour) {
    targetHour = BRIEFING_HOURS[0];
    daysToAdd = 1;
  }

  const target = new Date(cst);
  target.setDate(target.getDate() + daysToAdd);
  target.setHours(targetHour, 0, 0, 0);
  const msUntil = target.getTime() - cst.getTime();
  return { msUntil, targetHour };
}

function scheduleNextBriefing() {
  if (briefingTimer) clearTimeout(briefingTimer);
  const { msUntil, targetHour } = getNextBriefingTime();
  briefingTimer = setTimeout(async () => {
    await runDailyBriefing(targetHour);
    scheduleNextBriefing();
  }, msUntil);
  const hoursUntil = (msUntil / 3600000).toFixed(1);
  console.log(`[Briefing] Next briefing at ${targetHour}:00 CST (${BRIEFING_LABELS[targetHour]}, in ${hoursUntil} hours).`);
}

async function runDailyBriefing(hour) {
  const label = BRIEFING_LABELS[hour] || "Briefing";
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: "America/Chicago",
  });

  console.log(`[Briefing] Running ${label} briefing...`);

  let sections = [];
  sections.push(`*${label} Briefing* | ${dateStr}`);

  // --- INBOX ---
  try {
    const gmailClient = gmail.getGmail();
    const today = new Date();
    const todayStr = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

    const [triagedRes, starredRes, noiseRes, newsletterRes] = await Promise.all([
      gmailClient.users.messages.list({ userId: "me", q: `label:EA-Triaged after:${todayStr}`, maxResults: 100 }),
      gmailClient.users.messages.list({ userId: "me", q: `is:starred after:${todayStr}`, maxResults: 50 }),
      gmailClient.users.messages.list({ userId: "me", q: `label:EA-Noise after:${todayStr}`, maxResults: 50 }),
      gmailClient.users.messages.list({ userId: "me", q: `label:Newsletters after:${todayStr}`, maxResults: 50 }),
    ]);

    const triagedCount = triagedRes.data.messages?.length || 0;
    const starredCount = starredRes.data.messages?.length || 0;
    const noiseCount = noiseRes.data.messages?.length || 0;
    const newsletterCount = newsletterRes.data.messages?.length || 0;
    const fyi = Math.max(0, triagedCount - starredCount - noiseCount - newsletterCount);

    let inbox = `\n*INBOX*\nTriaged: ${triagedCount} | Starred: ${starredCount} | FYI: ${fyi} | Newsletters: ${newsletterCount} | Noise: ${noiseCount}`;

    // Starred details
    if (starredRes.data.messages) {
      let starredDetails = [];
      for (const msg of starredRes.data.messages.slice(0, 10)) {
        try {
          const full = await gmailClient.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
          const headers = full.data.payload.headers;
          const from = (headers.find((h) => h.name === "From") || {}).value || "Unknown";
          const subject = (headers.find((h) => h.name === "Subject") || {}).value || "(no subject)";
          const fromName = from.replace(/<.*>/, "").trim();
          starredDetails.push(`  • ${fromName}: ${subject}`);
        } catch {}
      }
      if (starredDetails.length > 0) {
        inbox += `\n${starredDetails.join("\n")}`;
      }
    }
    if (starredCount === 0) {
      inbox += `\nNo emails starred today. If deal or team emails came in, triage may be under-starring.`;
    }

    // Noise spot-check
    if (noiseRes.data.messages && noiseRes.data.messages.length > 0) {
      let noiseDetails = [];
      for (const msg of noiseRes.data.messages.slice(0, 5)) {
        try {
          const full = await gmailClient.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
          const headers = full.data.payload.headers;
          const from = (headers.find((h) => h.name === "From") || {}).value || "Unknown";
          const subject = (headers.find((h) => h.name === "Subject") || {}).value || "(no subject)";
          const fromName = from.replace(/<.*>/, "").trim();
          noiseDetails.push(`  • ${fromName}: ${subject}`);
        } catch {}
      }
      if (noiseDetails.length > 0) {
        inbox += `\n_Noise sample (spot check):_\n${noiseDetails.join("\n")}`;
      }
    }

    sections.push(inbox);
  } catch (err) {
    console.error("[Briefing] Inbox section error:", err.message);
    sections.push(`\n*INBOX*\nError loading inbox stats: ${err.message}`);
  }

  // --- DEALS ---
  try {
    const results = await dealDigest.runDailyDigest(26);
    let deals = `\n*DEALS*`;
    if (results.dealsUpdated > 0) {
      const updated = results.details
        .filter((d) => d.status === "updated")
        .map((d) => `  • ${d.deal} (${d.project})`)
        .join("\n");
      deals += `\n${results.dealsUpdated} deal${results.dealsUpdated > 1 ? "s" : ""} with new activity:\n${updated}`;
    } else {
      deals += `\nNo new deal activity.`;
    }
    sections.push(deals);
  } catch (err) {
    console.error("[Briefing] Deals section error:", err.message);
    sections.push(`\n*DEALS*\nError loading deal digest: ${err.message}`);
  }

  // --- SUBSCRIPTIONS ---
  try {
    // Run the scan to pick up any new subscriptions
    await subscriptions.scanSubscriptions();
    const upcoming = subscriptions.getUpcomingRenewals(7);
    let subs = `\n*SUBSCRIPTIONS*`;
    if (upcoming.length > 0) {
      const lines = upcoming.map((s) => {
        const cost = s.amount ? ` ($${s.amount}/${s.frequency || "mo"})` : "";
        return `  • ${s.name}${cost} renews ${s.next_renewal || "soon"}`;
      });
      subs += `\n${upcoming.length} renewal${upcoming.length > 1 ? "s" : ""} in next 7 days:\n${lines.join("\n")}`;
    } else {
      subs += `\nNo renewals in next 7 days.`;
    }
    sections.push(subs);
  } catch (err) {
    console.error("[Briefing] Subscriptions section error:", err.message);
    sections.push(`\n*SUBSCRIPTIONS*\nError loading subscriptions: ${err.message}`);
  }

  // --- MEETING NOTES ---
  try {
    const trackerUrl = meetingNotes.getTrackerUrl();
    if (trackerUrl) {
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, "data/meeting-notes-config.json"), "utf-8"));
      if (config.spreadsheetId) {
        const sheetData = await sheets.readSheet(config.spreadsheetId);
        const pending = sheetData.data ? sheetData.data.filter((r) => r.Status === "Pending") : [];
        let notes = `\n*MEETING NOTES*`;
        if (pending.length > 0) {
          notes += `\n${pending.length} pending review:`;
          for (const p of pending.slice(0, 5)) {
            notes += `\n  • ${p.Date || "?"} | ${p.Title || "Untitled"} | ${p["Suggested Project"] || "General"}`;
          }
          if (pending.length > 5) notes += `\n  ...and ${pending.length - 5} more`;
          notes += `\n<${trackerUrl}|Open tracker>`;
        } else {
          notes += `\nAll caught up. No pending notes.`;
        }
        sections.push(notes);
      }
    }
  } catch (err) {
    console.error("[Briefing] Meeting notes section error:", err.message);
    sections.push(`\n*MEETING NOTES*\nError loading meeting notes: ${err.message}`);
  }

  // --- SEND ---
  const report = sections.join("\n") + `\n\nReply with corrections (e.g. "star brian" or "noise cloudflare").`;

  try {
    const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
    await app.client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: report,
    });
    console.log(`[Briefing] ${label} briefing sent.`);
  } catch (err) {
    console.error("[Briefing] Could not send briefing:", err.message);
  }
}

// --- Daily Recovery Backup ---
// Uploads recovery-doc.md to Google Drive at 6am CST daily
const BACKUP_HOUR = 6; // 6am CST
let backupTimer = null;

function getNextBackupTime() {
  const now = new Date();
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const currentHour = cst.getHours();
  const currentMin = cst.getMinutes();

  let daysToAdd = 0;
  if (currentHour > BACKUP_HOUR || (currentHour === BACKUP_HOUR && currentMin >= 5)) {
    daysToAdd = 1; // already past today's window, do tomorrow
  }

  const target = new Date(cst);
  target.setDate(target.getDate() + daysToAdd);
  target.setHours(BACKUP_HOUR, 5, 0, 0); // :05 past the hour
  return target.getTime() - cst.getTime();
}

function scheduleNextBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  const msUntil = getNextBackupTime();
  backupTimer = setTimeout(async () => {
    await runDailyBackup();
    scheduleNextBackup();
  }, msUntil);
  const hoursUntil = (msUntil / 3600000).toFixed(1);
  console.log(`[Backup] Next recovery doc backup at ${BACKUP_HOUR}:05 CST (in ${hoursUntil} hours).`);
}

async function runDailyBackup() {
  try {
    console.log("[Backup] Uploading daily recovery doc to Google Drive...");
    const result = await drive.uploadRecoveryBackup();

    if (result.error) {
      console.error("[Backup] Failed:", result.error);
      return;
    }

    console.log(`[Backup] Recovery doc ${result.action}: ${result.name} in ${result.folder}`);

    // Silently log success. No need to DM Greg unless it fails.
    // If you want to notify Greg, uncomment below:
    // const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
    // await app.client.chat.postMessage({
    //   channel: dmChannel.channel.id,
    //   text: `Recovery doc backed up to Google Drive: ${result.name}`,
    // });
  } catch (err) {
    console.error("[Backup] Error:", err.message);
    // Notify Greg on failure so he knows backups stopped
    try {
      const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
      await app.client.chat.postMessage({
        channel: dmChannel.channel.id,
        text: `Recovery doc backup failed: ${err.message}. Check bot logs.`,
      });
    } catch (e) {
      console.error("[Backup] Could not notify Greg:", e.message);
    }
  }
}

// Deal digest module (used by consolidated briefing)
const dealDigest = require("./tools/deal-digest");

// --- Drive Folder Watcher ---
// Polls deal status folders every 30 min during daytime, detects moves, cascades updates.
const DRIVE_WATCHER_INTERVAL = 30 * 60 * 1000; // 30 minutes
const DRIVE_WATCHER_DAY_START = 6;
const DRIVE_WATCHER_DAY_END = 22;
let driveWatcherTimer = null;

function scheduleNextDriveWatch() {
  if (driveWatcherTimer) clearTimeout(driveWatcherTimer);
  const hour = getCSTHour();

  if (hour < DRIVE_WATCHER_DAY_START || hour >= DRIVE_WATCHER_DAY_END) {
    const hoursUntilMorning = hour >= DRIVE_WATCHER_DAY_END
      ? (24 - hour + DRIVE_WATCHER_DAY_START)
      : (DRIVE_WATCHER_DAY_START - hour);
    driveWatcherTimer = setTimeout(async () => {
      await runDriveWatch();
      scheduleNextDriveWatch();
    }, hoursUntilMorning * 60 * 60 * 1000);
    console.log(`[DriveWatcher] Next scan in ${hoursUntilMorning} hours (waiting for daytime).`);
    return;
  }

  driveWatcherTimer = setTimeout(async () => {
    await runDriveWatch();
    scheduleNextDriveWatch();
  }, DRIVE_WATCHER_INTERVAL);
  console.log(`[DriveWatcher] Next scan in 30 minutes (CST hour: ${hour}).`);
}

async function runDriveWatch() {
  try {
    const sendDM = async (msg) => {
      const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
      await app.client.chat.postMessage({ channel: dmChannel.channel.id, text: msg });
    };

    const results = await driveWatcher.runWatcher(sendDM);

    if (results.firstRun) {
      console.log(`[DriveWatcher] Baseline captured: ${results.dealsFound} deal folders.`);
    } else if (results.changes && results.changes.length > 0) {
      console.log(`[DriveWatcher] ${results.changes.length} change(s) processed.`);
    }
  } catch (err) {
    console.error("[DriveWatcher] Fatal error:", err.message);
  }
}

// Syncs Google Drive to Pinecone every hour during daytime (6am-10pm CST)
const RAG_SYNC_INTERVAL = 1 * 60 * 60 * 1000; // 1 hour
const RAG_DAY_START = 6;
const RAG_DAY_END = 22;
let ragSyncTimer = null;

function scheduleNextRagSync() {
  if (ragSyncTimer) clearTimeout(ragSyncTimer);
  const hour = getCSTHour();
  // Only sync during daytime
  if (hour < RAG_DAY_START || hour >= RAG_DAY_END) {
    // Schedule for next morning
    const hoursUntilMorning = hour >= RAG_DAY_END ? (24 - hour + RAG_DAY_START) : (RAG_DAY_START - hour);
    ragSyncTimer = setTimeout(async () => {
      await runRagSync();
      scheduleNextRagSync();
    }, hoursUntilMorning * 60 * 60 * 1000);
    console.log(`[RAG] Next sync in ${hoursUntilMorning} hours (waiting for daytime).`);
    return;
  }
  ragSyncTimer = setTimeout(async () => {
    await runRagSync();
    scheduleNextRagSync();
  }, RAG_SYNC_INTERVAL);
  console.log(`[RAG] Next sync in 1 hour (CST hour: ${hour}).`);
}

async function runRagSync() {
  try {
    console.log("[RAG] Running scheduled Drive sync...");
    const results = await rag.syncDrive((msg) => console.log(`[RAG] ${msg}`));
    console.log(`[RAG] Sync done: ${results.files_indexed_this_run} new, ${results.files_skipped} skipped, ${results.files_failed} failed.`);
  } catch (err) {
    console.error("[RAG] Sync error:", err.message);
  }
}

// Quo (phone system) polling: every 15 min during daytime (same cadence as email triage)
const QUO_POLL_INTERVAL = 15 * 60 * 1000; // 15 minutes
const QUO_POLL_NIGHT_INTERVAL = 60 * 60 * 1000; // 1 hour overnight
let quoPollTimer = null;

function scheduleNextQuoPoll() {
  if (quoPollTimer) clearTimeout(quoPollTimer);
  const hour = getCSTHour();
  const interval = (hour >= DAY_START_HOUR && hour < DAY_END_HOUR)
    ? QUO_POLL_INTERVAL
    : QUO_POLL_NIGHT_INTERVAL;

  quoPollTimer = setTimeout(async () => {
    await runQuoPoll();
    scheduleNextQuoPoll();
  }, interval);
}

async function runQuoPoll() {
  try {
    console.log("[Quo] Running scheduled poll...");
    const results = await quo.pollQuo();
    if (results.calls > 0 || results.sms > 0) {
      console.log(`[Quo] Found ${results.calls} calls, ${results.sms} SMS threads.`);
      // DM Greg if new deal-relevant content was captured
      try {
        const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
        let msg = `[Quo] Captured`;
        if (results.calls > 0) msg += ` ${results.calls} call transcript${results.calls > 1 ? "s" : ""}`;
        if (results.calls > 0 && results.sms > 0) msg += ` and`;
        if (results.sms > 0) msg += ` ${results.sms} SMS thread${results.sms > 1 ? "s" : ""}`;
        msg += `. Added to meeting notes tracker.`;
        await app.client.chat.postMessage({ channel: dmChannel.channel.id, text: msg });
      } catch (dmErr) {
        console.error("[Quo] DM error:", dmErr.message);
      }
    }
  } catch (err) {
    console.error("[Quo] Poll error:", err.message);
  }
}

// --- Start ---
(async () => {
  await app.start();
  console.log("Claude EA is online in Slack.");
  console.log(`Owner: ${OWNER_USER_ID} (full access)`);
  const teamMembers = Object.entries(permissions.TEAM_CONFIG)
    .filter(([, cfg]) => cfg.tier === "team")
    .map(([id, cfg]) => `${cfg.name} (${id})`);
  if (teamMembers.length > 0) {
    console.log(`Team members: ${teamMembers.join(", ")} (Drive search, freebusy, project files)`);
  } else {
    console.log("No team members configured yet. Add Slack user IDs to tools/permissions.js.");
  }
  const driveFolders = permissions.getTeamDriveFolders();
  if (driveFolders.length > 0) {
    console.log(`Team Drive folders whitelisted: ${driveFolders.length}`);
  } else {
    console.log("No team Drive folders configured. Set TEAM_DRIVE_FOLDERS in .env.");
  }
  console.log("Public users: chat only (no tool access)");

  // Run initial triage on startup
  setTimeout(async () => {
    console.log("[Auto-Triage] Running initial triage...");
    await runAutoTriage();
  }, 5000);

  // Schedule adaptive triage (15 min daytime, 60 min nighttime CST)
  scheduleNextTriage();
  console.log("[Auto-Triage] Adaptive schedule active (15 min 5am-11pm CST, 60 min overnight).");
  console.log("[Email Tasks] Active. Forward emails to greg+task@gfdevllc.com or label EA/Task.");

  // Consolidated briefings: 7am, noon, 5pm CST (inbox + deals + subscriptions + meeting notes)
  scheduleNextBriefing();
  console.log("[Briefing] Daily briefings scheduled at 7am, 12pm, 5pm CST.");

  scheduleNextBackup();
  console.log("[Backup] Daily recovery doc backup scheduled at 6:05am CST.");

  // Run initial Drive watcher scan on startup (after 15s to let other things init)
  setTimeout(async () => {
    console.log("[DriveWatcher] Running initial scan...");
    await runDriveWatch();
  }, 15000);
  scheduleNextDriveWatch();
  console.log("[DriveWatcher] Drive folder watcher active (every 30 min, 6am-10pm CST).");

  // RAG Drive sync: every 4 hours during daytime
  if (process.env.PINECONE_API_KEY && process.env.GEMINI_API_KEY) {
    scheduleNextRagSync();
    console.log("[RAG] Drive sync scheduled every 1 hour (6am-10pm CST).");
  } else {
    console.log("[RAG] Skipping Drive sync (PINECONE_API_KEY or GEMINI_API_KEY not set).");
  }

  // Quo phone system polling: calls + SMS -> meeting notes tracker
  if (process.env.QUO_API_KEY) {
    setTimeout(async () => {
      console.log("[Quo] Running initial poll...");
      await runQuoPoll();
    }, 20000); // 20s after startup
    scheduleNextQuoPoll();
    console.log("[Quo] Phone system polling active (every 15 min daytime, 60 min overnight).");
  } else {
    console.log("[Quo] Skipping phone polling (QUO_API_KEY not set).");
  }
})();
