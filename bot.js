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

const fs = require("fs");
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

Gmail: search by name not email address. If no results, broaden the search automatically. Try at least 2 queries before saying not found.

Transcripts: when Greg uploads a document, use process_transcript with the file_ref. When he confirms a meeting note (e.g. "file it"), use file_meeting_notes with the pending_id.

CONTRACT DRAFTING: You are a real estate attorney for raw land deals, representing BUYER (GF Development LLC).
1. search_precedent first, then check templates
2. Ask focused intake questions if terms are missing (property, price, earnest money, DD period, closing, utilities, assignment rights, costs, risks)
3. lookup_deal for pipeline data
4. Draft with clean attorney-grade language, mirror precedent where appropriate
5. Flag borrowed clauses, optional clauses, jurisdiction issues, assumptions
6. generate_contract_doc to create .docx on Drive
Amendments: reference original by date/parties, state only modified terms.

Team: Rachel Rife (PM), Brian Chaplin (Acquisitions, La Pine OR deals), Marwan Mousa (Leads).
Priorities: 1) Cash flow via La Pine deals 2) WASem Lot 3 close 3) Traditions North + Brio Vista long-term.

Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Greg's TZ: CST (Mexico).`;

const TEAM_SYSTEM_PROMPT = `You are Claude EA, the GFDev Brain. Speaking with a team member (not Greg). Direct, helpful, 2-3 sentences max. No emojis. No dashes.

Can do: search shared Drive files, check calendar availability (busy/free only), read project files, look up deal pipeline.
Cannot do: email access, calendar event details, write files, take actions on Greg's behalf. Say so plainly if asked.

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
    case "search_precedent":
      return await contracts.searchPrecedent(toolInput.deal_type, toolInput.market, toolInput.keywords);
    case "list_contract_templates":
      return await contracts.listTemplates();
    case "read_contract_template":
      return await contracts.readTemplate(toolInput.template_name);
    case "generate_contract_doc":
      return await contracts.generateContractDoc(toolInput.contract_text, toolInput.file_name, toolInput.doc_type, toolInput.deal_name);
    case "process_transcript":
      return await transcript.processTranscript(toolInput);
    case "file_meeting_notes":
      return await meetingNotes.fileMeetingNotes(toolInput);
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

async function runAgent(userId, messages, systemPrompt, tools) {
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    let response;
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: systemPrompt,
        tools,
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
            system: systemPrompt,
            tools,
            messages,
          });
        } catch (retryErr) {
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    // Collect text and tool use from response
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // If no tool use, we're done. Extract text.
    if (response.stop_reason === "end_turn") {
      const textParts = assistantContent
        .filter((block) => block.type === "text")
        .map((block) => block.text);
      return textParts.join("\n");
    }

    // Process tool calls
    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool] ${block.name}:`, JSON.stringify(block.input).substring(0, 200));
        try {
          const result = await executeTool(block.name, block.input, userId);
          const resultStr = JSON.stringify(result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: truncateResult(resultStr),
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

  return "Hit the tool use limit. Try breaking your request into smaller pieces.";
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

  if (!text) return;

  const tier = permissions.getUserTier(userId);
  const systemPrompt = tier === "owner" ? OWNER_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;
  const tools = tier === "owner" ? OWNER_TOOLS : tier === "team" ? TEAM_TOOLS : PUBLIC_TOOLS;

  const history = getHistory(userId);
  history.push({ role: "user", content: text });
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
  if (!text) return;

  const tier = permissions.getUserTier(userId);
  const systemPrompt = tier === "owner" ? OWNER_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;
  const tools = tier === "owner" ? OWNER_TOOLS : tier === "team" ? TEAM_TOOLS : PUBLIC_TOOLS;

  const history = getHistory(userId);
  history.push({ role: "user", content: text });
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
      // Ask Greg about confused senders
      if (learnResults.confused && learnResults.confused.length > 0) {
        const questions = learnResults.confused.map((c) =>
          `• "${c.sender}" has ${c.starred_count} starred and ${c.noise_count} noise labels. Star future emails from them?`
        ).join("\n");
        try {
          const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
          await app.client.chat.postMessage({
            channel: dmChannel.channel.id,
            text: `*Quick question on email triage:*\n${questions}\n\nJust reply with the sender name and "star" or "noise" (e.g. "zoom noise" or "brian star").`,
          });
        } catch (e) {
          console.error("[Learning] Could not send confusion DM:", e.message);
        }
      }
    } catch (err) {
      console.error("[Learning] Error (non-fatal):", err.message);
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

  // --- Post-Triage: Check for meeting notes ---
  try {
    const emailReports = await meetingNotes.checkRecentMeetingEmails();
    const geminiReports = await meetingNotes.checkGeminiNotes();
    const allReports = [...emailReports, ...geminiReports];

    if (allReports.length > 0) {
      console.log(`[Meeting Notes] ${allReports.length} new meeting notes found.`);
      const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
      const history = getHistory(OWNER_USER_ID);

      for (const report of allReports) {
        const msg = meetingNotes.buildNotificationMessage(report);
        await app.client.chat.postMessage({
          channel: dmChannel.channel.id,
          text: msg,
        });
        // Add to conversation history so the agent has context when Greg replies
        history.push({ role: "assistant", content: msg });
        trimHistory(history);
      }
    }
  } catch (err) {
    console.error("[Meeting Notes] Post-triage check error:", err.message);
  }
}

// --- Daily Triage Analysis ---
// DMs Greg a quality report at noon and 7pm CST
const ANALYSIS_HOURS = [12, 19]; // noon and 7pm CST
let analysisTimer = null;

function getNextAnalysisTime() {
  const now = new Date();
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const currentHour = cst.getHours();
  const currentMin = cst.getMinutes();

  // Find next analysis hour
  let targetHour = ANALYSIS_HOURS.find((h) => h > currentHour || (h === currentHour && currentMin < 3));
  let daysToAdd = 0;
  if (!targetHour) {
    targetHour = ANALYSIS_HOURS[0]; // wrap to tomorrow's first slot
    daysToAdd = 1;
  }

  // Build target time in CST
  const target = new Date(cst);
  target.setDate(target.getDate() + daysToAdd);
  target.setHours(targetHour, 3, 0, 0); // :03 past the hour to avoid exact marks
  const msUntil = target.getTime() - cst.getTime();
  return { msUntil, targetHour };
}

function scheduleNextAnalysis() {
  if (analysisTimer) clearTimeout(analysisTimer);
  const { msUntil, targetHour } = getNextAnalysisTime();
  analysisTimer = setTimeout(async () => {
    await runTriageAnalysis();
    scheduleNextAnalysis();
  }, msUntil);
  const hoursUntil = (msUntil / 3600000).toFixed(1);
  console.log(`[Triage Analysis] Next report at ${targetHour}:03 CST (in ${hoursUntil} hours).`);
}

async function runTriageAnalysis() {
  try {
    console.log("[Triage Analysis] Generating daily triage quality report...");
    const gmailClient = gmail.getGmail();

    // Get today's triaged, starred, and noise emails
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
    const fyi = triagedCount - starredCount - noiseCount - newsletterCount;

    // Get details on starred emails
    let starredDetails = [];
    if (starredRes.data.messages) {
      for (const msg of starredRes.data.messages.slice(0, 15)) {
        try {
          const full = await gmailClient.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
          const headers = full.data.payload.headers;
          const from = (headers.find((h) => h.name === "From") || {}).value || "Unknown";
          const subject = (headers.find((h) => h.name === "Subject") || {}).value || "(no subject)";
          const fromName = from.replace(/<.*>/, "").trim();
          starredDetails.push(`• ${fromName}: ${subject}`);
        } catch {}
      }
    }

    // Get details on noise to spot-check for false negatives
    let noiseDetails = [];
    if (noiseRes.data.messages) {
      for (const msg of noiseRes.data.messages.slice(0, 10)) {
        try {
          const full = await gmailClient.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
          const headers = full.data.payload.headers;
          const from = (headers.find((h) => h.name === "From") || {}).value || "Unknown";
          const subject = (headers.find((h) => h.name === "Subject") || {}).value || "(no subject)";
          const fromName = from.replace(/<.*>/, "").trim();
          noiseDetails.push(`• ${fromName}: ${subject}`);
        } catch {}
      }
    }

    // Build the report
    let report = `*Triage Analysis Report*\n`;
    report += `Total triaged today: ${triagedCount}\n`;
    report += `Starred: ${starredCount} | FYI: ${Math.max(0, fyi)} | Newsletters: ${newsletterCount} | Noise: ${noiseCount}\n`;

    if (starredDetails.length > 0) {
      report += `\n*Starred emails:*\n${starredDetails.join("\n")}\n`;
    } else {
      report += `\n*No emails starred today.* If there were deal or team emails, the triage may be under-starring.\n`;
    }

    if (noiseDetails.length > 0) {
      report += `\n*Noise sample (spot-check these):*\n${noiseDetails.join("\n")}\n`;
    }

    report += `\nReply with any corrections (e.g. "star brian emails" or "noise cloudflare") and I'll update the triage rules.`;

    const dmChannel = await app.client.conversations.open({ users: OWNER_USER_ID });
    await app.client.chat.postMessage({
      channel: dmChannel.channel.id,
      text: report,
    });

    console.log("[Triage Analysis] Report sent to Greg.");
  } catch (err) {
    console.error("[Triage Analysis] Error:", err.message);
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

  scheduleNextAnalysis();
  console.log("[Triage Analysis] Daily reports scheduled at noon and 7pm CST.");

  scheduleNextBackup();
  console.log("[Backup] Daily recovery doc backup scheduled at 6:05am CST.");
})();
