// Meeting notes detection, deduplication, summarization, and filing
// Captures from: email (Read AI, Notta, etc.) and Google Drive (Gemini Notes)
const Anthropic = require("@anthropic-ai/sdk");
const gmail = require("./gmail");
const drive = require("./drive");
const fs = require("fs");
const path = require("path");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  if (normTitle.length < 5) return false; // too short to match reliably
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

// --- Pending Meetings (in-memory, for Slack confirmation) ---
const pendingMeetings = new Map();

function storePendingMeeting(data) {
  const id = `mtg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
  pendingMeetings.set(id, { ...data, storedAt: Date.now() });
  setTimeout(() => pendingMeetings.delete(id), 2 * 60 * 60 * 1000); // 2hr expiry
  return id;
}

function getPendingMeeting(id) {
  return pendingMeetings.get(id) || null;
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
    /\u{1F5D3}/u, // 🗓
  ];
  return reportPatterns.some((re) => re.test(subject));
}

function extractMeetingDate(subject, emailDate) {
  const dateMatch = subject.match(
    /(\w+ \d{1,2},?\s*\d{4})/
  );
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

// --- AI Summarization ---
async function summarizeMeetingContent(content, titleHint, source) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Extract meeting information from this content. Known projects/deals: ${KNOWN_PROJECTS.join(", ")}

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

  processedLabelId = labels.find(
    (l) => l.name === "EA-Meeting-Processed"
  )?.id;
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
      const from =
        (headers.find((h) => h.name === "From") || {}).value || "";
      const subject =
        (headers.find((h) => h.name === "Subject") || {}).value || "";
      const emailDate =
        (headers.find((h) => h.name === "Date") || {}).value || "";

      if (!isActualMeetingReport(subject)) {
        // Not a report, just label as processed so we skip next time
        await labelAsProcessed(gmailClient, msg.id);
        continue;
      }

      // Extract body
      let body = "";
      if (full.data.payload.body?.data) {
        body = Buffer.from(full.data.payload.body.data, "base64").toString(
          "utf-8"
        );
      } else if (full.data.payload.parts) {
        const textPart = full.data.payload.parts.find(
          (p) => p.mimeType === "text/plain"
        );
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        } else {
          // Try HTML part
          const htmlPart = full.data.payload.parts.find(
            (p) => p.mimeType === "text/html"
          );
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
        console.log(
          `[Meeting Notes] Duplicate: ${meetingTitle} (${meetingDate})`
        );
        await labelAsProcessed(gmailClient, msg.id);
        continue;
      }

      const sourceName =
        MEETING_REPORT_SENDERS.find((s) =>
          from.toLowerCase().includes(s.domain)
        )?.name || "Unknown";

      const cleaned = cleanEmailContent(body);
      const parsed = await summarizeMeetingContent(
        cleaned,
        meetingTitle,
        sourceName
      );

      const pendingId = storePendingMeeting({
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

      results.push({
        pendingId,
        meetingTitle: parsed.title || meetingTitle,
        meetingDate: parsed.date || meetingDate,
        source: sourceName,
        project: parsed.project,
        suggestedFileName: parsed.suggestedFileName,
        summary: parsed.summary,
        actionItems: parsed.actionItems,
      });

      console.log(
        `[Meeting Notes] Processed email: ${parsed.title || meetingTitle} -> ${parsed.project}`
      );
    } catch (err) {
      console.error(
        `[Meeting Notes] Email processing error (${msg.id}):`,
        err.message
      );
    }
  }

  return results;
}

// --- Check Google Drive for Gemini Notes ---
async function checkGeminiNotes() {
  const results = [];

  try {
    const driveClient = drive.getDrive();
    const twoHoursAgo = new Date(
      Date.now() - 2 * 60 * 60 * 1000
    ).toISOString();

    const searchRes = await driveClient.files.list({
      q: `mimeType='application/vnd.google-apps.document' and modifiedTime > '${twoHoursAgo}' and name contains 'Notes by Gemini' and trashed=false`,
      fields: "files(id, name, modifiedTime, webViewLink)",
      pageSize: 10,
      orderBy: "modifiedTime desc",
    });

    if (!searchRes.data.files || searchRes.data.files.length === 0) {
      return results;
    }

    console.log(
      `[Meeting Notes] Found ${searchRes.data.files.length} recent Gemini notes.`
    );

    for (const file of searchRes.data.files) {
      // Parse title and date from Gemini note name
      // Format: "Title - YYYY/MM/DD HH:MM TZ - Notes by Gemini"
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
        console.log(
          `[Meeting Notes] Gemini note already logged: ${meetingTitle}`
        );
        continue;
      }

      // Read the document
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

      const pendingId = storePendingMeeting({
        driveFileId: file.id,
        driveLink: file.webViewLink,
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

      results.push({
        pendingId,
        meetingTitle: parsed.title || meetingTitle,
        meetingDate: parsed.date || meetingDate,
        source: "Google Meet (Gemini)",
        project: parsed.project,
        suggestedFileName: parsed.suggestedFileName,
        summary: parsed.summary,
        actionItems: parsed.actionItems,
        driveLink: file.webViewLink,
      });

      console.log(
        `[Meeting Notes] Processed Gemini note: ${parsed.title || meetingTitle} -> ${parsed.project}`
      );
    }
  } catch (err) {
    console.error("[Meeting Notes] Gemini notes error:", err.message);
  }

  return results;
}

// --- File Meeting Notes to Drive (dual location) ---
async function fileMeetingNotes({ pending_id, project, file_name }) {
  const pending = getPendingMeeting(pending_id);
  if (!pending) {
    return {
      error:
        "Pending meeting not found or expired. The meeting report may need to be re-processed.",
    };
  }

  const confirmedProject = project || pending.project || "General";
  const confirmedFileName =
    file_name || pending.suggestedFileName || "meeting_notes";
  const datePrefix =
    pending.meetingDate || new Date().toISOString().split("T")[0];
  const fullFileName = `${datePrefix}_${confirmedFileName}`;

  const summaryMd = `# Meeting Summary: ${pending.meetingTitle}
**Date:** ${pending.meetingDate}
**Participants:** ${pending.participants || "See original"}
**Source:** ${pending.source}
**Project:** ${confirmedProject}

## Summary
${pending.summary || "No summary available."}

## Action Items
${pending.actionItems || "None"}

## Key Decisions
${pending.keyDecisions || "None"}
`;

  try {
    const driveResults = {};

    // 1. Deal folder: {Project}/Meeting Notes & Transcripts/
    const dealFolderId = await drive.findOrCreateFolder(confirmedProject);
    const dealMtgFolderId = await drive.findOrCreateFolder(
      "Meeting Notes & Transcripts",
      dealFolderId
    );
    const dealResult = await drive.uploadFile(
      `${fullFileName}_summary.md`,
      summaryMd,
      "text/markdown",
      dealMtgFolderId
    );
    driveResults.dealFolder = {
      path: `${confirmedProject}/Meeting Notes & Transcripts/`,
      file: dealResult.name,
      link: dealResult.link,
    };

    // 2. Master folder: Meeting Transcripts/ (chronological log)
    const masterFolderId = await drive.findOrCreateFolder(
      "Meeting Transcripts"
    );
    const masterResult = await drive.uploadFile(
      `${fullFileName}_summary.md`,
      summaryMd,
      "text/markdown",
      masterFolderId
    );
    driveResults.masterFolder = {
      path: "Meeting Transcripts/",
      file: masterResult.name,
      link: masterResult.link,
    };

    // 3. Save original to master folder
    if (pending.fullContent) {
      await drive.uploadFile(
        `${fullFileName}_original.txt`,
        pending.fullContent,
        "text/plain",
        masterFolderId
      );
    }

    // 4. Log to meeting log
    logMeeting({
      title: pending.meetingTitle,
      date: pending.meetingDate,
      source: pending.source,
      project: confirmedProject,
      fileName: fullFileName,
      emailId: pending.emailId || null,
      driveFileId: pending.driveFileId || null,
      dealLink: dealResult.link,
      masterLink: masterResult.link,
    });

    // 5. Clean up
    pendingMeetings.delete(pending_id);

    return {
      success: true,
      meetingTitle: pending.meetingTitle,
      project: confirmedProject,
      drive: driveResults,
    };
  } catch (err) {
    console.error("[Meeting Notes] Filing error:", err.message);
    return { error: `Failed to file meeting notes: ${err.message}` };
  }
}

// Build Slack notification message for a detected meeting
function buildNotificationMessage(report) {
  let msg = `*New meeting notes detected*\n`;
  msg += `*Meeting:* ${report.meetingTitle}\n`;
  msg += `*Date:* ${report.meetingDate}\n`;
  msg += `*Source:* ${report.source}\n`;
  msg += `*Suggested project:* ${report.project}\n`;
  msg += `*Suggested file name:* ${report.meetingDate}_${report.suggestedFileName}\n\n`;
  msg += `*Summary:* ${report.summary}\n`;
  if (report.actionItems && report.actionItems !== "None") {
    msg += `\n*Action Items:*\n${report.actionItems}\n`;
  }
  msg += `\nPending ID: ${report.pendingId}\n`;
  msg += `Reply "file it" to save, or specify changes (e.g. "file to Brio Vista" or "rename to drainage_review").`;
  return msg;
}

module.exports = {
  checkRecentMeetingEmails,
  checkGeminiNotes,
  fileMeetingNotes,
  getPendingMeeting,
  buildNotificationMessage,
  isDuplicate,
};
