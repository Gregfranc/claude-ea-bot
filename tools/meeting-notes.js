// Meeting notes detection, deduplication, summarization, and filing
// Captures from: email (Read AI, Notta, etc.), Google Drive (Gemini Notes), and Drive Drop folder
// Flow: detect -> summarize -> save to inbox folder -> add row to tracker sheet
// Greg reviews sheet, changes project if needed, marks "Approved" -> bot files to deal folder
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const gmail = require("./gmail");
const drive = require("./drive");
const sheets = require("./sheets");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Audio MIME types for Whisper transcription
const DROP_AUDIO_MIMES = [
  "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav",
  "audio/x-m4a", "audio/mp3", "audio/aac", "audio/flac",
  "video/webm", "video/mp4",
];

const DROP_AUDIO_EXTENSIONS = [
  ".m4a", ".mp3", ".wav", ".webm", ".ogg", ".aac", ".flac", ".mp4",
];

// --- Constants ---
const MEETING_REPORT_SENDERS = [
  { domain: "read.ai", name: "Read AI" },
  { domain: "notta.ai", name: "Notta" },
  { domain: "otter.ai", name: "Otter.ai" },
  { domain: "fireflies.ai", name: "Fireflies" },
  { domain: "meetgeek.ai", name: "MeetGeek" },
];

const KNOWN_PROJECTS = [
  "Traditions North",
  "Brio Vista",
  "Columbia View Estates",
  "Idaho County 154ac",
  "Sage Creek",
  "La Pine OR",
  "Wasem Lot 3",
  "Tomi Coffe",
  "Sims",
  "Cumley",
  "Forest",
];

const SHEET_HEADERS = [
  "Date",
  "Title",
  "Source",
  "Summary",
  "Suggested Project",
  "Approved Project",
  "Notes",
  "Visibility",
  "File Link",
  "Status",
];

// --- Config (stores sheet ID and inbox folder ID) ---
const CONFIG_PATH = path.join(__dirname, "../data/meeting-notes-config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Meeting Log (persistent, deduplication) ---
const MEETING_LOG_PATH = path.join(__dirname, "../data/meeting-log.json");

function loadMeetingLog() {
  try {
    return JSON.parse(fs.readFileSync(MEETING_LOG_PATH, "utf-8"));
  } catch {
    return { meetings: [] };
  }
}

function saveMeetingLog(log) {
  fs.writeFileSync(MEETING_LOG_PATH, JSON.stringify(log, null, 2));
}

function isDuplicate(date, title) {
  const log = loadMeetingLog();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normTitle = norm(title);
  if (normTitle.length < 5) return false;
  return log.meetings.some((m) => {
    const mNorm = norm(m.title);
    return (
      m.date === date &&
      (mNorm === normTitle ||
        mNorm.includes(normTitle) ||
        normTitle.includes(mNorm))
    );
  });
}

function logMeeting(meeting) {
  const log = loadMeetingLog();
  log.meetings.push({ ...meeting, loggedAt: new Date().toISOString() });
  if (log.meetings.length > 500) log.meetings = log.meetings.slice(-500);
  saveMeetingLog(log);
}

// --- Classification Learning ---
const LEARNINGS_PATH = path.join(__dirname, "../data/meeting-classification-learnings.json");

function loadLearnings() {
  try {
    return JSON.parse(fs.readFileSync(LEARNINGS_PATH, "utf-8"));
  } catch {
    return { corrections: [] };
  }
}

function saveLearnings(data) {
  fs.writeFileSync(LEARNINGS_PATH, JSON.stringify(data, null, 2));
}

function addLearning(correction) {
  const data = loadLearnings();
  data.corrections.push({ ...correction, learnedAt: new Date().toISOString() });
  if (data.corrections.length > 50) data.corrections = data.corrections.slice(-50);
  saveLearnings(data);
}

function getLearningExamples() {
  const data = loadLearnings();
  if (data.corrections.length === 0) return "";
  const recent = data.corrections.slice(-10);
  let examples = "\n\nPAST CLASSIFICATION CORRECTIONS (learn from these):\n";
  for (const c of recent) {
    examples += `- Meeting "${c.meetingTitle}" was suggested as "${c.suggestedProject}" but should be "${c.approvedProject}"`;
    if (c.notes) examples += ` (reason: ${c.notes})`;
    examples += "\n";
  }
  return examples;
}

// --- Ensure tracker sheet + inbox folder exist ---
async function ensureInfrastructure() {
  let config = loadConfig();

  // Create inbox folder if needed
  if (!config.inboxFolderId) {
    config.inboxFolderId = await drive.findOrCreateFolder("Meeting Notes Inbox");
    saveConfig(config);
    console.log("[Meeting Notes] Created inbox folder in Drive.");
  }

  // Create tracker sheet if needed
  if (!config.spreadsheetId) {
    const result = await sheets.createSpreadsheet(
      "Meeting Notes Tracker",
      SHEET_HEADERS
    );
    config.spreadsheetId = result.spreadsheetId;
    config.sheetUrl = result.url;
    saveConfig(config);
    console.log(`[Meeting Notes] Created tracker sheet: ${result.url}`);
  }

  return config;
}

// --- Add meeting to inbox (save file + append sheet row) ---
async function addToInbox(data) {
  const config = await ensureInfrastructure();

  const project = data.project || "General";
  const fileName = data.suggestedFileName || "meeting_notes";
  const datePrefix = data.meetingDate || new Date().toISOString().split("T")[0];
  const fullFileName = `${datePrefix}_${fileName}`;

  const summaryMd = `# Meeting Summary: ${data.meetingTitle}
**Date:** ${data.meetingDate}
**Participants:** ${data.participants || "See original"}
**Source:** ${data.source}
**Suggested Project:** ${project}

## Summary
${data.summary || "No summary available."}

## Action Items
${data.actionItems || "None"}

## Key Decisions
${data.keyDecisions || "None"}
`;

  try {
    // Save summary to inbox folder
    const fileResult = await drive.uploadFile(
      `${fullFileName}_summary.md`,
      summaryMd,
      "text/markdown",
      config.inboxFolderId
    );

    // Save original content to inbox folder
    if (data.fullContent) {
      await drive.uploadFile(
        `${fullFileName}_original.txt`,
        data.fullContent,
        "text/plain",
        config.inboxFolderId
      );
    }

    // Append row to tracker sheet
    const row = [
      data.meetingDate || datePrefix,
      data.meetingTitle || fileName,
      data.source || "Unknown",
      (data.summary || "").substring(0, 500),
      project,
      "", // Approved Project (Greg fills this)
      "", // Notes (Greg fills this)
      "Private", // Visibility: Private or Public
      fileResult.link || "",
      "Pending",
    ];

    await sheets.appendSheet(config.spreadsheetId, "Sheet1!A:J", [row]);

    // Log for dedup
    logMeeting({
      title: data.meetingTitle,
      date: data.meetingDate,
      source: data.source,
      project,
      fileName: fullFileName,
      emailId: data.emailId || null,
      driveFileId: data.driveFileId || null,
      inboxLink: fileResult.link,
    });

    console.log(`[Meeting Notes] Added to inbox: ${data.meetingTitle} (suggested: ${project})`);
    return { success: true, meetingTitle: data.meetingTitle, suggestedProject: project };
  } catch (err) {
    console.error("[Meeting Notes] Inbox error:", err.message);
    return { error: err.message };
  }
}

// --- Process approved notes from sheet ---
async function processApprovedNotes() {
  let config;
  try {
    config = loadConfig();
  } catch {
    return [];
  }
  if (!config.spreadsheetId) return [];

  const results = [];

  try {
    const sheetData = await sheets.readSheet(config.spreadsheetId);
    if (!sheetData.data || sheetData.data.length === 0) return results;

    for (const row of sheetData.data) {
      // Treat as approved if Status is "Approved" OR if Approved Project is filled in
      const hasApprovedProject = row["Approved Project"] && row["Approved Project"].trim() !== "";
      if (row.Status !== "Approved" && !hasApprovedProject) continue;
      if (row.Status === "Filed" || row.Status === "Rejected") continue;

      const approvedProject = row["Approved Project"] || row["Suggested Project"] || "General";
      const notes = row.Notes || "";
      const suggestedProject = row["Suggested Project"] || "General";
      const title = row.Title || "Unknown";
      const date = row.Date || "";
      const fileLink = row["File Link"] || "";

      // Learn from corrections
      if (approvedProject !== suggestedProject && approvedProject && suggestedProject) {
        addLearning({
          meetingTitle: title,
          suggestedProject,
          approvedProject,
          notes,
          meetingDate: date,
        });
        console.log(`[Meeting Notes] Learned: "${title}" -> ${approvedProject} (was ${suggestedProject}). ${notes ? "Reason: " + notes : ""}`);
      }

      // Read the summary file from inbox
      let summaryContent = null;
      if (fileLink) {
        const fileIdMatch = fileLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (fileIdMatch) {
          try {
            const fileData = await drive.readFile(fileIdMatch[1]);
            summaryContent = fileData.content;
          } catch (err) {
            console.error(`[Meeting Notes] Could not read inbox file: ${err.message}`);
          }
        }
      }

      if (!summaryContent) {
        // Mark as error in sheet (column J = Status)
        await sheets.writeSheet(
          config.spreadsheetId,
          `Sheet1!J${row._row}`,
          [["Error: file not found"]]
        );
        continue;
      }

      // Update the project in the summary content
      summaryContent = summaryContent.replace(
        /\*\*Suggested Project:\*\* .+/,
        `**Project:** ${approvedProject}`
      );

      try {
        // File to deal folder
        const dealFolderId = await drive.findOrCreateFolder(approvedProject);
        const dealMtgFolderId = await drive.findOrCreateFolder(
          "Meeting Notes & Transcripts",
          dealFolderId
        );

        // Extract filename from the file link or build from row data
        const datePrefix = date || new Date().toISOString().split("T")[0];
        const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").substring(0, 40);
        const fullFileName = `${datePrefix}_${safeName}`;

        await drive.uploadFile(
          `${fullFileName}_summary.md`,
          summaryContent,
          "text/markdown",
          dealMtgFolderId
        );

        // Also copy to master folder
        const masterFolderId = await drive.findOrCreateFolder("Meeting Transcripts");
        await drive.uploadFile(
          `${fullFileName}_summary.md`,
          summaryContent,
          "text/markdown",
          masterFolderId
        );

        // Update sheet status to "Filed" (column J)
        await sheets.writeSheet(
          config.spreadsheetId,
          `Sheet1!J${row._row}`,
          [["Filed"]]
        );

        console.log(`[Meeting Notes] Filed: ${title} -> ${approvedProject}`);
        results.push({ success: true, title, project: approvedProject });
      } catch (err) {
        console.error(`[Meeting Notes] Filing error for "${title}": ${err.message}`);
        await sheets.writeSheet(
          config.spreadsheetId,
          `Sheet1!J${row._row}`,
          [["Error: " + err.message.substring(0, 50)]]
        );
      }
    }
  } catch (err) {
    console.error("[Meeting Notes] Process approved error:", err.message);
  }

  return results;
}

// --- Email Detection ---
function isActualMeetingReport(subject) {
  const skipPatterns = [
    /weekly kickoff/i,
    /privacy policy/i,
    /terms of service/i,
    /won't be recorded/i,
    /will not be recorded/i,
    /upgrade your/i,
    /subscription/i,
    /billing/i,
    /action required/i,
  ];
  if (skipPatterns.some((re) => re.test(subject))) return false;
  const reportPatterns = [
    /meeting report/i,
    /meeting recap/i,
    /meeting summary/i,
    /transcription/i,
    /meeting records/i,
    /\u{1F5D3}/u, // calendar emoji
  ];
  return reportPatterns.some((re) => re.test(subject));
}

function extractMeetingDate(subject, emailDate) {
  const dateMatch = subject.match(/(\w+ \d{1,2},?\s*\d{4})/);
  if (dateMatch) {
    const d = new Date(dateMatch[1]);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  const d = new Date(emailDate);
  return isNaN(d.getTime())
    ? new Date().toISOString().split("T")[0]
    : d.toISOString().split("T")[0];
}

function extractMeetingTitle(subject) {
  let title = subject;
  title = title.replace(/^[\u{1F5D3}\u{1F4CB}\s]+/u, "");
  title = title.replace(/\s+on\s+\w+ \d{1,2},?\s*\d{4}.*$/, "");
  title = title.replace(/\|.*$/, "");
  title = title.replace(/Read Meeting Report$/i, "");
  title = title.replace(/Meeting (Report|Summary|Recap)$/i, "");
  return title.trim() || subject;
}

function cleanEmailContent(body) {
  let clean = body.replace(/https?:\/\/\S+/g, "[link]");
  clean = clean.replace(/[\u00AD\u200B\u200C\u200D\uFEFF\u034F]+/g, "");
  clean = clean.replace(/\s{3,}/g, "\n\n");
  return clean.substring(0, 40000);
}

// --- AI Summarization (with learning) ---
async function summarizeMeetingContent(content, titleHint, source) {
  const learningExamples = getLearningExamples();

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Extract meeting information from this content. Known projects/deals: ${KNOWN_PROJECTS.join(", ")}
${learningExamples}
TITLE HINT: ${titleHint}
SOURCE: ${source}
CONTENT:
${content.substring(0, 30000)}

Return in this EXACT format (each field on its own line):
TITLE: [meeting title, clean and concise]
DATE: [YYYY-MM-DD]
PARTICIPANTS: [comma-separated names mentioned]
PROJECT: [best matching project from the known list, or "General"]
SUGGESTED_FILENAME: [short_descriptive_snake_case, no date prefix, e.g. tsm_drainage_followup]

SUMMARY:
[2-3 sentence summary of what was discussed and decided]

ACTION ITEMS:
[- [ ] Person: action item, one per line, or "None"]

KEY DECISIONS:
[- decision, one per line, or "None"]`,
        },
      ],
    });

    const text = response.content[0].text;
    return {
      title: text.match(/TITLE:\s*(.+)/)?.[1]?.trim(),
      date: text.match(/DATE:\s*(\d{4}-\d{2}-\d{2})/)?.[1],
      participants: text.match(/PARTICIPANTS:\s*(.+)/)?.[1]?.trim(),
      project: text.match(/PROJECT:\s*(.+)/)?.[1]?.trim() || "General",
      suggestedFileName: text.match(/SUGGESTED_FILENAME:\s*(.+)/)?.[1]?.trim() || "meeting_notes",
      summary: text.match(/SUMMARY:\s*\n([\s\S]*?)(?=\nACTION ITEMS:)/)?.[1]?.trim(),
      actionItems: text.match(/ACTION ITEMS:\s*\n([\s\S]*?)(?=\nKEY DECISIONS:)/)?.[1]?.trim(),
      keyDecisions: text.match(/KEY DECISIONS:\s*\n([\s\S]*?)$/)?.[1]?.trim(),
    };
  } catch (err) {
    console.error("[Meeting Notes] Summarization error:", err.message);
    return {
      title: titleHint,
      date: new Date().toISOString().split("T")[0],
      project: "General",
      suggestedFileName: "meeting_notes",
      summary: "Could not generate summary.",
      actionItems: "None",
      keyDecisions: "None",
    };
  }
}

// --- Gmail Label Management ---
let meetingLabelId = null;
let processedLabelId = null;

async function ensureLabels(gmailClient) {
  if (meetingLabelId && processedLabelId) return;
  const labelsRes = await gmailClient.users.labels.list({ userId: "me" });
  const labels = labelsRes.data.labels;

  meetingLabelId = labels.find((l) => l.name === "EA/Meeting Notes")?.id;
  if (!meetingLabelId) {
    const created = await gmailClient.users.labels.create({
      userId: "me",
      requestBody: {
        name: "EA/Meeting Notes",
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    meetingLabelId = created.data.id;
  }

  processedLabelId = labels.find((l) => l.name === "EA-Meeting-Processed")?.id;
  if (!processedLabelId) {
    const created = await gmailClient.users.labels.create({
      userId: "me",
      requestBody: {
        name: "EA-Meeting-Processed",
        labelListVisibility: "labelHide",
        messageListVisibility: "hide",
      },
    });
    processedLabelId = created.data.id;
  }
}

async function labelAsProcessed(gmailClient, messageId) {
  try {
    await ensureLabels(gmailClient);
    await gmailClient.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds: [meetingLabelId, processedLabelId] },
    });
  } catch (err) {
    console.error("[Meeting Notes] Label error:", err.message);
  }
}

// --- Check Gmail for Meeting Report Emails ---
async function checkRecentMeetingEmails() {
  const gmailClient = gmail.getGmail();
  const results = [];

  const senderQueries = MEETING_REPORT_SENDERS.map(
    (s) => `from:${s.domain}`
  ).join(" OR ");
  const query = `(${senderQueries}) newer_than:3h -label:EA-Meeting-Processed`;

  let searchRes;
  try {
    searchRes = await gmailClient.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 10,
    });
  } catch (err) {
    console.error("[Meeting Notes] Gmail search error:", err.message);
    return results;
  }

  if (!searchRes.data.messages || searchRes.data.messages.length === 0) {
    return results;
  }

  console.log(
    `[Meeting Notes] Found ${searchRes.data.messages.length} potential meeting report emails.`
  );

  for (const msg of searchRes.data.messages) {
    try {
      const full = await gmailClient.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = full.data.payload.headers;
      const from = (headers.find((h) => h.name === "From") || {}).value || "";
      const subject = (headers.find((h) => h.name === "Subject") || {}).value || "";
      const emailDate = (headers.find((h) => h.name === "Date") || {}).value || "";

      if (!isActualMeetingReport(subject)) {
        await labelAsProcessed(gmailClient, msg.id);
        continue;
      }

      // Extract body
      let body = "";
      if (full.data.payload.body?.data) {
        body = Buffer.from(full.data.payload.body.data, "base64").toString("utf-8");
      } else if (full.data.payload.parts) {
        const textPart = full.data.payload.parts.find((p) => p.mimeType === "text/plain");
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        } else {
          const htmlPart = full.data.payload.parts.find((p) => p.mimeType === "text/html");
          if (htmlPart?.body?.data) {
            body = Buffer.from(htmlPart.body.data, "base64")
              .toString("utf-8")
              .replace(/<[^>]+>/g, " ");
          }
        }
      }

      if (!body && full.data.snippet) body = full.data.snippet;

      const meetingDate = extractMeetingDate(subject, emailDate);
      const meetingTitle = extractMeetingTitle(subject);

      if (isDuplicate(meetingDate, meetingTitle)) {
        console.log(`[Meeting Notes] Duplicate: ${meetingTitle} (${meetingDate})`);
        await labelAsProcessed(gmailClient, msg.id);
        continue;
      }

      const sourceName =
        MEETING_REPORT_SENDERS.find((s) => from.toLowerCase().includes(s.domain))?.name || "Unknown";

      const cleaned = cleanEmailContent(body);
      const parsed = await summarizeMeetingContent(cleaned, meetingTitle, sourceName);

      // Add to inbox (sheet + Drive folder)
      const inboxResult = await addToInbox({
        emailId: msg.id,
        meetingTitle: parsed.title || meetingTitle,
        meetingDate: parsed.date || meetingDate,
        source: sourceName,
        project: parsed.project,
        suggestedFileName: parsed.suggestedFileName,
        summary: parsed.summary,
        actionItems: parsed.actionItems,
        keyDecisions: parsed.keyDecisions,
        participants: parsed.participants,
        fullContent: cleaned,
      });

      await labelAsProcessed(gmailClient, msg.id);
      results.push(inboxResult);
    } catch (err) {
      console.error(`[Meeting Notes] Email processing error (${msg.id}):`, err.message);
    }
  }

  return results;
}

// --- Check Google Drive for Gemini Notes ---
async function checkGeminiNotes() {
  const results = [];

  try {
    const driveClient = drive.getDrive();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const searchRes = await driveClient.files.list({
      q: `mimeType='application/vnd.google-apps.document' and modifiedTime > '${twoHoursAgo}' and name contains 'Notes by Gemini' and trashed=false`,
      fields: "files(id, name, modifiedTime, webViewLink)",
      pageSize: 10,
      orderBy: "modifiedTime desc",
    });

    if (!searchRes.data.files || searchRes.data.files.length === 0) {
      return results;
    }

    console.log(`[Meeting Notes] Found ${searchRes.data.files.length} recent Gemini notes.`);

    for (const file of searchRes.data.files) {
      const nameMatch = file.name.match(
        /^(.+?)\s*-\s*(\d{4}\/\d{2}\/\d{2})\s+[\d:]+\s+\w+\s*-\s*Notes by Gemini$/i
      );
      const meetingTitle = nameMatch
        ? nameMatch[1].trim()
        : file.name.replace(/\s*-\s*Notes by Gemini$/i, "").trim();
      const meetingDate = nameMatch
        ? nameMatch[2].replace(/\//g, "-")
        : new Date(file.modifiedTime).toISOString().split("T")[0];

      if (isDuplicate(meetingDate, meetingTitle)) {
        console.log(`[Meeting Notes] Gemini note already logged: ${meetingTitle}`);
        continue;
      }

      const content = await drive.readFile(file.id);
      if (!content.content || content.content.length < 50) {
        console.log(`[Meeting Notes] Gemini note too short: ${file.name}`);
        continue;
      }

      const parsed = await summarizeMeetingContent(
        content.content,
        meetingTitle,
        "Google Meet (Gemini)"
      );

      const inboxResult = await addToInbox({
        driveFileId: file.id,
        meetingTitle: parsed.title || meetingTitle,
        meetingDate: parsed.date || meetingDate,
        source: "Google Meet (Gemini)",
        project: parsed.project,
        suggestedFileName: parsed.suggestedFileName,
        summary: parsed.summary,
        actionItems: parsed.actionItems,
        keyDecisions: parsed.keyDecisions,
        participants: parsed.participants,
        fullContent: content.content,
      });

      results.push(inboxResult);
    }
  } catch (err) {
    console.error("[Meeting Notes] Gemini notes error:", err.message);
  }

  return results;
}

// --- Check Drive "Transcript Drop" folder for new files ---
// Greg drops audio recordings (Voice Memos, Notta exports) or transcript files here.
// Audio files get transcribed via Whisper, text/PDF/docs get read directly.
// All get summarized, added to tracker sheet, and moved to inbox folder.

async function ensureDropFolder() {
  let config = loadConfig();
  if (!config.dropFolderId) {
    config.dropFolderId = await drive.findOrCreateFolder("Transcript Drop");
    saveConfig(config);
    console.log("[Meeting Notes] Created 'Transcript Drop' folder in Drive.");
  }
  if (!config.inboxFolderId) {
    config.inboxFolderId = await drive.findOrCreateFolder("Meeting Notes Inbox");
    saveConfig(config);
  }
  return config;
}

function isAudioFile(mimeType, fileName) {
  if (mimeType && DROP_AUDIO_MIMES.some((m) => mimeType.startsWith(m.split("/")[0] + "/" + m.split("/")[1]))) return true;
  if (mimeType && (mimeType.startsWith("audio/") || mimeType.startsWith("video/"))) return true;
  const ext = path.extname(fileName || "").toLowerCase();
  return DROP_AUDIO_EXTENSIONS.includes(ext);
}

async function downloadDriveFile(driveClient, fileId) {
  const res = await driveClient.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function transcribeDropAudio(driveClient, file) {
  if (!openai) {
    console.error("[Meeting Notes] No OpenAI API key, cannot transcribe audio.");
    return null;
  }
  try {
    console.log(`[Meeting Notes] Transcribing audio: ${file.name} (${file.mimeType})`);
    const buffer = await downloadDriveFile(driveClient, file.id);
    if (buffer.length < 100) {
      console.error(`[Meeting Notes] Audio file too small: ${file.name} (${buffer.length} bytes)`);
      return null;
    }

    // Write to temp file for Whisper API
    const ext = path.extname(file.name || ".webm") || ".webm";
    const tmpPath = path.join(os.tmpdir(), `drop-${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpPath),
    });

    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}

    console.log(`[Meeting Notes] Transcribed ${file.name}: ${(transcription.text || "").length} chars`);
    return transcription.text || null;
  } catch (err) {
    console.error(`[Meeting Notes] Whisper error for ${file.name}: ${err.message}`);
    return null;
  }
}

async function checkDropFolder() {
  const results = [];

  try {
    const config = await ensureDropFolder();
    const driveClient = drive.getDrive();

    // List files in the drop folder
    const files = await drive.listFolder(config.dropFolderId, 20);
    if (!files || files.length === 0) return results;

    console.log(`[Meeting Notes] Found ${files.length} files in Transcript Drop folder.`);

    for (const file of files) {
      // Skip folders
      if (file.mimeType === "application/vnd.google-apps.folder") continue;

      try {
        let content = "";
        let source = "Drive Drop";

        if (isAudioFile(file.mimeType, file.name)) {
          // Audio: transcribe via Whisper
          content = await transcribeDropAudio(driveClient, file);
          source = "Drive Drop (Audio)";
          if (!content) {
            console.log(`[Meeting Notes] Could not transcribe: ${file.name}`);
            continue;
          }
        } else {
          // Text/PDF/Doc: read via drive.readFile
          const fileData = await drive.readFile(file.id);
          content = fileData.content || "";
          if (content.startsWith("(Binary file") || content.startsWith("(PDF could not") || content.startsWith("(Could not extract")) {
            console.log(`[Meeting Notes] Unreadable drop file: ${file.name}`);
            continue;
          }
        }

        if (!content || content.trim().length < 50) {
          console.log(`[Meeting Notes] Drop file too short: ${file.name} (${(content || "").length} chars)`);
          continue;
        }

        // Extract title from filename
        const title = (file.name || "recording")
          .replace(/\.[^.]+$/, "")
          .replace(/[_-]+/g, " ")
          .trim();
        const date = new Date(file.modifiedTime).toISOString().split("T")[0];

        // Check dedup
        if (isDuplicate(date, title)) {
          console.log(`[Meeting Notes] Drop file already logged: ${title}`);
          // Still move it out of drop folder
          try {
            await driveClient.files.update({
              fileId: file.id,
              addParents: config.inboxFolderId,
              removeParents: config.dropFolderId,
              fields: "id, parents",
            });
          } catch {}
          continue;
        }

        // Summarize and classify
        const parsed = await summarizeMeetingContent(content, title, source);

        // Add to inbox (sheet + Drive)
        const inboxResult = await addToInbox({
          driveFileId: file.id,
          meetingTitle: parsed.title || title,
          meetingDate: parsed.date || date,
          source,
          project: parsed.project,
          suggestedFileName: parsed.suggestedFileName,
          summary: parsed.summary,
          actionItems: parsed.actionItems,
          keyDecisions: parsed.keyDecisions,
          participants: parsed.participants,
          fullContent: content,
        });

        // Move file from drop folder to inbox folder
        try {
          await driveClient.files.update({
            fileId: file.id,
            addParents: config.inboxFolderId,
            removeParents: config.dropFolderId,
            fields: "id, parents",
          });
          console.log(`[Meeting Notes] Moved ${file.name} to inbox folder.`);
        } catch (moveErr) {
          console.error(`[Meeting Notes] Could not move ${file.name}: ${moveErr.message}`);
        }

        results.push(inboxResult);
      } catch (fileErr) {
        console.error(`[Meeting Notes] Drop file error (${file.name}): ${fileErr.message}`);
      }
    }
  } catch (err) {
    console.error("[Meeting Notes] Drop folder error:", err.message);
  }

  return results;
}

// --- Search meeting notes in tracker sheet ---
// ownerOnly=true shows all notes, ownerOnly=false shows only "Public" notes
async function searchMeetingNotes(query, ownerOnly = true) {
  const config = loadConfig();
  if (!config.spreadsheetId) return { results: [], message: "No tracker sheet exists yet." };

  const sheetData = await sheets.readSheet(config.spreadsheetId);
  if (!sheetData.data || sheetData.data.length === 0) {
    return { results: [], message: "Tracker sheet is empty." };
  }

  const q = query.toLowerCase();
  const matches = sheetData.data.filter((row) => {
    // Team members only see Public notes
    if (!ownerOnly && (row.Visibility || "Private").toLowerCase() !== "public") return false;

    const searchable = [
      row.Title || "",
      row.Summary || "",
      row["Suggested Project"] || "",
      row["Approved Project"] || "",
      row.Source || "",
      row.Date || "",
    ].join(" ").toLowerCase();
    return q.split(/\s+/).every((term) => searchable.includes(term));
  });

  return {
    results: matches.map((r) => ({
      date: r.Date,
      title: r.Title,
      source: r.Source,
      summary: r.Summary,
      project: r["Approved Project"] || r["Suggested Project"],
      status: r.Status,
      visibility: r.Visibility || "Private",
      link: r["File Link"],
    })),
    total: matches.length,
    sheetUrl: ownerOnly ? config.sheetUrl : undefined,
  };
}

// --- Backfill: process 6 months of emails + all Gemini Notes ---
async function backfillMeetingNotes(progressCallback) {
  const config = await ensureInfrastructure();
  const results = { emails: 0, gemini: 0, skipped: 0, errors: 0 };

  // 1. Backfill emails (6 months)
  const gmailClient = gmail.getGmail();
  const senderQueries = MEETING_REPORT_SENDERS.map((s) => `from:${s.domain}`).join(" OR ");
  const query = `(${senderQueries}) newer_than:180d`;

  let pageToken = null;
  let allMessages = [];

  // Paginate through all results
  do {
    const params = { userId: "me", q: query, maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;
    const res = await gmailClient.users.messages.list(params);
    if (res.data.messages) allMessages = allMessages.concat(res.data.messages);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  if (progressCallback) progressCallback(`Found ${allMessages.length} meeting report emails to process.`);

  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i];
    try {
      const full = await gmailClient.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = full.data.payload.headers;
      const from = (headers.find((h) => h.name === "From") || {}).value || "";
      const subject = (headers.find((h) => h.name === "Subject") || {}).value || "";
      const emailDate = (headers.find((h) => h.name === "Date") || {}).value || "";

      if (!isActualMeetingReport(subject)) {
        await labelAsProcessed(gmailClient, msg.id);
        results.skipped++;
        continue;
      }

      const meetingDate = extractMeetingDate(subject, emailDate);
      const meetingTitle = extractMeetingTitle(subject);

      if (isDuplicate(meetingDate, meetingTitle)) {
        await labelAsProcessed(gmailClient, msg.id);
        results.skipped++;
        continue;
      }

      // Extract body
      let body = "";
      if (full.data.payload.body?.data) {
        body = Buffer.from(full.data.payload.body.data, "base64").toString("utf-8");
      } else if (full.data.payload.parts) {
        const textPart = full.data.payload.parts.find((p) => p.mimeType === "text/plain");
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        } else {
          const htmlPart = full.data.payload.parts.find((p) => p.mimeType === "text/html");
          if (htmlPart?.body?.data) {
            body = Buffer.from(htmlPart.body.data, "base64").toString("utf-8").replace(/<[^>]+>/g, " ");
          }
        }
      }
      if (!body && full.data.snippet) body = full.data.snippet;

      const sourceName = MEETING_REPORT_SENDERS.find((s) => from.toLowerCase().includes(s.domain))?.name || "Unknown";
      const cleaned = cleanEmailContent(body);
      const parsed = await summarizeMeetingContent(cleaned, meetingTitle, sourceName);

      await addToInbox({
        emailId: msg.id,
        meetingTitle: parsed.title || meetingTitle,
        meetingDate: parsed.date || meetingDate,
        source: sourceName,
        project: parsed.project,
        suggestedFileName: parsed.suggestedFileName,
        summary: parsed.summary,
        actionItems: parsed.actionItems,
        keyDecisions: parsed.keyDecisions,
        participants: parsed.participants,
        fullContent: cleaned,
      });

      await labelAsProcessed(gmailClient, msg.id);
      results.emails++;

      if (progressCallback && (i + 1) % 10 === 0) {
        progressCallback(`Processed ${i + 1}/${allMessages.length} emails...`);
      }

      // Brief pause every 5 to avoid rate limits
      if ((i + 1) % 5 === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[Backfill] Email error (${msg.id}):`, err.message);
      results.errors++;
    }
  }

  // 2. Backfill Gemini Notes (all, not just last 2 hours)
  if (progressCallback) progressCallback("Scanning Google Drive for Gemini Notes...");

  try {
    const driveClient = drive.getDrive();
    let geminiFiles = [];
    let drivePageToken = null;

    do {
      const params = {
        q: `name contains 'Notes by Gemini' and trashed=false`,
        fields: "files(id, name, modifiedTime, webViewLink), nextPageToken",
        pageSize: 50,
        orderBy: "modifiedTime desc",
      };
      if (drivePageToken) params.pageToken = drivePageToken;
      const res = await driveClient.files.list(params);
      if (res.data.files) geminiFiles = geminiFiles.concat(res.data.files);
      drivePageToken = res.data.nextPageToken;
    } while (drivePageToken);

    if (progressCallback) progressCallback(`Found ${geminiFiles.length} Gemini Notes to process.`);

    for (let i = 0; i < geminiFiles.length; i++) {
      const file = geminiFiles[i];
      try {
        const nameMatch = file.name.match(
          /^(.+?)\s*-\s*(\d{4}[\/\_]\d{2}[\/\_]\d{2})\s+[\d:_]+\s+\w+\s*-\s*Notes by Gemini/i
        );
        const meetingTitle = nameMatch
          ? nameMatch[1].trim()
          : file.name.replace(/\s*-\s*Notes by Gemini.*$/i, "").trim();
        const meetingDate = nameMatch
          ? nameMatch[2].replace(/[\/\_]/g, "-")
          : new Date(file.modifiedTime).toISOString().split("T")[0];

        if (isDuplicate(meetingDate, meetingTitle)) {
          results.skipped++;
          continue;
        }

        const content = await drive.readFile(file.id);
        if (!content.content || content.content.length < 50) {
          results.skipped++;
          continue;
        }

        const parsed = await summarizeMeetingContent(
          content.content,
          meetingTitle,
          "Google Meet (Gemini)"
        );

        await addToInbox({
          driveFileId: file.id,
          meetingTitle: parsed.title || meetingTitle,
          meetingDate: parsed.date || meetingDate,
          source: "Google Meet (Gemini)",
          project: parsed.project,
          suggestedFileName: parsed.suggestedFileName,
          summary: parsed.summary,
          actionItems: parsed.actionItems,
          keyDecisions: parsed.keyDecisions,
          participants: parsed.participants,
          fullContent: content.content,
        });

        results.gemini++;

        if ((i + 1) % 5 === 0) await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.error(`[Backfill] Gemini note error (${file.name}):`, err.message);
        results.errors++;
      }
    }
  } catch (err) {
    console.error("[Backfill] Gemini scan error:", err.message);
  }

  console.log(`[Backfill] Done. Emails: ${results.emails}, Gemini: ${results.gemini}, Skipped: ${results.skipped}, Errors: ${results.errors}`);
  return {
    ...results,
    sheetUrl: config.sheetUrl,
    message: `Backfill complete. ${results.emails} emails + ${results.gemini} Gemini notes added to tracker. ${results.skipped} skipped (duplicates/non-reports). ${results.errors} errors.`,
  };
}

// Get the tracker sheet URL for reference
function getTrackerUrl() {
  const config = loadConfig();
  return config.sheetUrl || null;
}

module.exports = {
  checkRecentMeetingEmails,
  checkGeminiNotes,
  checkDropFolder,
  processApprovedNotes,
  searchMeetingNotes,
  backfillMeetingNotes,
  isDuplicate,
  getTrackerUrl,
  addToInbox,
};
