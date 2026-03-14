// Quo (formerly OpenPhone) integration
// Polls for new call transcripts and SMS threads, classifies by deal,
// and writes to the Meeting Notes Tracker sheet
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Constants ---
const QUO_BASE_URL = "https://api.openphone.com/v1";
const STATE_PATH = path.join(__dirname, "../data/quo-state.json");
const CONTACTS_CACHE_PATH = path.join(__dirname, "../data/quo-contacts.json");

const KNOWN_PROJECTS = [
  "Traditions North",
  "Brio Vista",
  "Columbia View Estates",
  "Idaho County 154ac",
  "Sage Creek",
  "La Pine OR",
  "Wasem Lot 3",
  "Tomi Coffer",
  "Sims",
  "Cumley",
  "Forest",
];

// --- API Client ---
async function quoFetch(endpoint, params = {}) {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY not set");

  const url = new URL(`${QUO_BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item) => url.searchParams.append(k, item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Quo API ${res.status}: ${text}`);
  }

  return res.json();
}

// --- State Management ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {
      lastPollTime: null,
      phoneNumberIds: [],
      processedCallIds: [],
      processedConversationTimestamps: {},
    };
  }
}

function saveState(state) {
  if (state.processedCallIds.length > 1000) {
    state.processedCallIds = state.processedCallIds.slice(-500);
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Contacts Cache ---
function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_CACHE_PATH, "utf-8"));
  } catch {
    return { contacts: {}, lastRefresh: null };
  }
}

function saveContacts(cache) {
  fs.writeFileSync(CONTACTS_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function refreshContacts() {
  const cache = loadContacts();
  const now = Date.now();

  // Refresh every 24 hours
  if (
    cache.lastRefresh &&
    now - new Date(cache.lastRefresh).getTime() < 24 * 60 * 60 * 1000
  ) {
    return cache.contacts;
  }

  console.log("[Quo] Refreshing contacts cache...");
  const contacts = {};
  let pageToken = null;

  do {
    const params = { maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;

    const res = await quoFetch("/contacts", params);

    for (const contact of res.data || []) {
      const name = [
        contact.defaultFields?.firstName,
        contact.defaultFields?.lastName,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!name) continue;

      for (const phone of contact.defaultFields?.phoneNumbers || []) {
        if (phone.value) {
          contacts[phone.value] = name;
          // Also store without +1 prefix for matching
          const stripped = phone.value.replace(/^\+1/, "");
          contacts[stripped] = name;
        }
      }
    }

    pageToken = res.nextPageToken;
  } while (pageToken);

  cache.contacts = contacts;
  cache.lastRefresh = new Date().toISOString();
  saveContacts(cache);
  console.log(
    `[Quo] Cached ${Object.keys(contacts).length} phone-to-name mappings.`
  );
  return contacts;
}

function resolvePhoneToName(phone, contacts) {
  if (!phone) return "Unknown";
  return contacts[phone] || contacts[phone.replace(/^\+1/, "")] || phone;
}

// --- Discover Phone Numbers ---
async function discoverPhoneNumbers() {
  const state = loadState();

  if (state.phoneNumberIds.length > 0) return state.phoneNumberIds;

  console.log("[Quo] Discovering phone numbers...");
  const res = await quoFetch("/phone-numbers");

  const phoneNumbers = (res.data || []).map((pn) => ({
    id: pn.id,
    number: pn.number,
    name: pn.name || pn.number,
  }));

  state.phoneNumberIds = phoneNumbers;
  saveState(state);
  console.log(
    `[Quo] Found ${phoneNumbers.length} phone numbers: ${phoneNumbers.map((p) => p.name || p.number).join(", ")}`
  );
  return phoneNumbers;
}

// --- Fetch Call Transcript ---
async function getCallTranscript(callId) {
  try {
    const res = await quoFetch(`/call-transcripts/${callId}`);
    if (!res.data || res.data.status !== "completed" || !res.data.dialogue)
      return null;

    return {
      dialogue: res.data.dialogue,
      duration: res.data.duration,
      text: res.data.dialogue
        .map((d) => `${d.identifier || "Unknown"}: ${d.content}`)
        .join("\n"),
    };
  } catch (err) {
    if (err.message.includes("404")) return null;
    console.error(`[Quo] Transcript error for ${callId}:`, err.message);
    return null;
  }
}

// --- Fetch Call Summary ---
async function getCallSummary(callId) {
  try {
    const res = await quoFetch(`/call-summaries/${callId}`);
    if (!res.data || res.data.status !== "completed") return null;

    return {
      summary: (res.data.summary || []).join(" "),
      nextSteps: (res.data.nextSteps || []).join("\n- "),
    };
  } catch (err) {
    if (err.message.includes("404")) return null;
    console.error(`[Quo] Summary error for ${callId}:`, err.message);
    return null;
  }
}

// --- AI Summarization for Quo content ---
async function summarizeQuoContent(
  content,
  titleHint,
  source,
  participants,
  durationMin
) {
  // Load learnings from meeting-notes classifier
  let learningExamples = "";
  try {
    const learningsPath = path.join(
      __dirname,
      "../data/meeting-classification-learnings.json"
    );
    const data = JSON.parse(fs.readFileSync(learningsPath, "utf-8"));
    if (data.corrections && data.corrections.length > 0) {
      const recent = data.corrections.slice(-10);
      learningExamples =
        "\n\nPAST CLASSIFICATION CORRECTIONS (learn from these):\n";
      for (const c of recent) {
        learningExamples += `- "${c.meetingTitle}" was suggested as "${c.suggestedProject}" but should be "${c.approvedProject}"`;
        if (c.notes) learningExamples += ` (reason: ${c.notes})`;
        learningExamples += "\n";
      }
    }
  } catch {}

  const durationStr = durationMin ? `\nDuration: ${durationMin} minutes` : "";
  const contentType =
    source === "Quo Call"
      ? "phone call transcript"
      : "SMS text message thread";

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Extract key information from this ${contentType}.

Known projects/deals: ${KNOWN_PROJECTS.join(", ")}
${learningExamples}
TITLE HINT: ${titleHint}
SOURCE: ${source}
PARTICIPANTS: ${participants}${durationStr}

CONTENT:
${content.substring(0, 30000)}

Return in this EXACT format (each field on its own line):
TITLE: [concise title describing what was discussed, e.g. "Tanner Smith - WASem Lot 3 Closing Timeline"]
DATE: [YYYY-MM-DD]
PARTICIPANTS: [comma-separated names mentioned]
PROJECT: [best matching project from the known list, or "General"]
SUGGESTED_FILENAME: [short_descriptive_snake_case, no date prefix, e.g. tanner_wasem_closing]

SUMMARY:
[2-3 sentence summary of what was discussed and any decisions or updates]

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
      suggestedFileName:
        text.match(/SUGGESTED_FILENAME:\s*(.+)/)?.[1]?.trim(),
      summary: text
        .match(/SUMMARY:\s*\n([\s\S]*?)(?=\nACTION ITEMS:)/)?.[1]
        ?.trim(),
      actionItems: text
        .match(/ACTION ITEMS:\s*\n([\s\S]*?)(?=\nKEY DECISIONS:)/)?.[1]
        ?.trim(),
      keyDecisions: text
        .match(/KEY DECISIONS:\s*\n([\s\S]*?)$/)?.[1]
        ?.trim(),
    };
  } catch (err) {
    console.error("[Quo] Summarization error:", err.message);
    return {
      title: titleHint,
      date: new Date().toISOString().split("T")[0],
      project: "General",
      summary: "Could not generate summary.",
      actionItems: "None",
      keyDecisions: "None",
    };
  }
}

// --- Main Polling Function ---
async function pollQuo() {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) {
    console.log("[Quo] No API key configured, skipping poll.");
    return { calls: 0, sms: 0, skipped: 0 };
  }

  // Lazy-load meeting-notes to avoid circular dependency at startup
  const meetingNotes = require("./meeting-notes");

  const state = loadState();
  const contacts = await refreshContacts();
  const phoneNumbers = await discoverPhoneNumbers();

  if (phoneNumbers.length === 0) {
    console.log("[Quo] No phone numbers found in workspace.");
    return { calls: 0, sms: 0, skipped: 0 };
  }

  // Default to last 2 hours on first run, then since last poll
  const since = state.lastPollTime
    ? new Date(state.lastPollTime).toISOString()
    : new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const results = { calls: 0, sms: 0, skipped: 0, errors: 0 };
  console.log(`[Quo] Polling since ${since}...`);

  try {
    // 1. List conversations updated since last poll
    const convRes = await quoFetch("/conversations", {
      maxResults: 100,
      updatedAfter: since,
    });

    const conversations = convRes.data || [];
    console.log(`[Quo] Found ${conversations.length} updated conversations.`);

    for (const conv of conversations) {
      const phoneNumberId = conv.phoneNumberId;
      const participants = conv.participants || [];
      if (participants.length === 0) continue;

      const participantNames = participants.map((p) =>
        resolvePhoneToName(p, contacts)
      );
      const participantLabel = participantNames.join(", ");

      // Rate limit: small delay between conversations
      await new Promise((r) => setTimeout(r, 200));

      // 2. Fetch calls for this conversation
      try {
        const callsRes = await quoFetch("/calls", {
          phoneNumberId,
          participants,
          createdAfter: since,
          maxResults: 50,
        });

        for (const call of callsRes.data || []) {
          if (state.processedCallIds.includes(call.id)) {
            results.skipped++;
            continue;
          }
          if (!["completed", "answered"].includes(call.status)) continue;
          if ((call.duration || 0) < 10) continue; // Skip very short calls

          await new Promise((r) => setTimeout(r, 200));

          const transcript = await getCallTranscript(call.id);
          const quoSummary = await getCallSummary(call.id);

          // Build content for summarization
          let content = "";
          if (transcript && transcript.text) {
            content = transcript.text;
            for (const [phone, name] of Object.entries(contacts)) {
              if (phone.startsWith("+")) {
                content = content.replace(
                  new RegExp(phone.replace(/\+/g, "\\+"), "g"),
                  name
                );
              }
            }
          } else if (quoSummary && quoSummary.summary) {
            content = `Call Summary: ${quoSummary.summary}`;
            if (quoSummary.nextSteps)
              content += `\n\nNext Steps:\n- ${quoSummary.nextSteps}`;
          }

          if (!content || content.length < 20) {
            state.processedCallIds.push(call.id);
            results.skipped++;
            continue;
          }

          const callDate = call.createdAt
            ? new Date(call.createdAt).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0];
          const callTitle = `Call with ${participantLabel}`;
          const durationMin = Math.round((call.duration || 0) / 60);

          if (meetingNotes.isDuplicate(callDate, callTitle)) {
            state.processedCallIds.push(call.id);
            results.skipped++;
            continue;
          }

          const parsed = await summarizeQuoContent(
            content,
            callTitle,
            "Quo Call",
            participantLabel,
            durationMin
          );

          await meetingNotes.addToInbox({
            meetingTitle: parsed.title || callTitle,
            meetingDate: parsed.date || callDate,
            source: "Quo Call",
            project: parsed.project,
            suggestedFileName:
              parsed.suggestedFileName ||
              `quo_call_${participantLabel.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
            summary: parsed.summary,
            actionItems: parsed.actionItems,
            keyDecisions: parsed.keyDecisions,
            participants: participantLabel,
            fullContent: content,
          });

          state.processedCallIds.push(call.id);
          results.calls++;
          console.log(
            `[Quo] Processed call: ${callTitle} (${callDate}, ${durationMin}min)`
          );
        }
      } catch (err) {
        console.error(
          `[Quo] Calls error for conversation ${conv.id}:`,
          err.message
        );
        results.errors++;
      }

      // 3. Fetch SMS messages for this conversation
      try {
        const lastMsgTime =
          state.processedConversationTimestamps[conv.id] || since;

        const msgsRes = await quoFetch("/messages", {
          phoneNumberId,
          participants,
          createdAfter: lastMsgTime,
          maxResults: 100,
        });

        const messages = (msgsRes.data || []).filter(
          (m) =>
            m.status !== "undelivered" && m.text && m.text.trim().length > 0
        );

        if (messages.length === 0) continue;

        // Skip if only trivial messages
        const substantiveMessages = messages.filter(
          (m) => (m.text || "").length > 5
        );
        if (substantiveMessages.length < 2) {
          const latestMsg = messages[messages.length - 1];
          if (latestMsg) {
            state.processedConversationTimestamps[conv.id] =
              latestMsg.createdAt;
          }
          results.skipped++;
          continue;
        }

        // Build SMS thread text
        const threadText = messages
          .map((m) => {
            const sender =
              m.direction === "outgoing"
                ? "Greg"
                : resolvePhoneToName(m.from, contacts);
            const time = new Date(m.createdAt).toLocaleString("en-US", {
              timeZone: "America/Chicago",
            });
            return `[${time}] ${sender}: ${m.text}`;
          })
          .join("\n");

        const smsDate = messages[0]?.createdAt
          ? new Date(messages[0].createdAt).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        const smsTitle = `SMS with ${participantLabel} (${messages.length} msgs)`;

        const parsed = await summarizeQuoContent(
          threadText,
          smsTitle,
          "Quo SMS",
          participantLabel,
          null
        );

        await meetingNotes.addToInbox({
          meetingTitle: parsed.title || smsTitle,
          meetingDate: parsed.date || smsDate,
          source: "Quo SMS",
          project: parsed.project,
          suggestedFileName:
            parsed.suggestedFileName ||
            `quo_sms_${participantLabel.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
          summary: parsed.summary,
          actionItems: parsed.actionItems,
          keyDecisions: parsed.keyDecisions,
          participants: participantLabel,
          fullContent: threadText,
        });

        // Update timestamp
        const latestMsg = messages[messages.length - 1];
        if (latestMsg) {
          state.processedConversationTimestamps[conv.id] =
            latestMsg.createdAt;
        }
        results.sms++;
        console.log(
          `[Quo] Processed SMS thread: ${participantLabel} (${messages.length} messages)`
        );
      } catch (err) {
        console.error(
          `[Quo] SMS error for conversation ${conv.id}:`,
          err.message
        );
        results.errors++;
      }
    }
  } catch (err) {
    console.error("[Quo] Poll error:", err.message);
    results.errors++;
  }

  // Update last poll time
  state.lastPollTime = new Date().toISOString();
  saveState(state);
  console.log(
    `[Quo] Poll complete. Calls: ${results.calls}, SMS: ${results.sms}, Skipped: ${results.skipped}, Errors: ${results.errors}`
  );
  return results;
}

// --- Backfill: process historical calls and SMS ---
async function backfillQuo(daysBack = 30, progressCallback) {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY not set");

  const meetingNotes = require("./meeting-notes");
  const contacts = await refreshContacts();
  await discoverPhoneNumbers();
  const since = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000
  ).toISOString();
  const state = loadState();
  const results = { calls: 0, sms: 0, skipped: 0, errors: 0 };

  if (progressCallback)
    progressCallback(`Backfilling Quo data from last ${daysBack} days...`);

  // List all conversations in the time range
  let allConversations = [];
  let pageToken = null;

  do {
    const params = { maxResults: 100, updatedAfter: since };
    if (pageToken) params.pageToken = pageToken;
    const res = await quoFetch("/conversations", params);
    allConversations = allConversations.concat(res.data || []);
    pageToken = res.nextPageToken;
  } while (pageToken);

  if (progressCallback)
    progressCallback(
      `Found ${allConversations.length} conversations to process.`
    );

  for (let i = 0; i < allConversations.length; i++) {
    const conv = allConversations[i];
    const phoneNumberId = conv.phoneNumberId;
    const participants = conv.participants || [];
    if (participants.length === 0) continue;

    const participantNames = participants.map((p) =>
      resolvePhoneToName(p, contacts)
    );
    const participantLabel = participantNames.join(", ");

    await new Promise((r) => setTimeout(r, 300));

    // Calls
    try {
      let callPageToken = null;
      do {
        const params = {
          phoneNumberId,
          participants,
          createdAfter: since,
          maxResults: 50,
        };
        if (callPageToken) params.pageToken = callPageToken;
        const callsRes = await quoFetch("/calls", params);

        for (const call of callsRes.data || []) {
          if (state.processedCallIds.includes(call.id)) {
            results.skipped++;
            continue;
          }
          if (!["completed", "answered"].includes(call.status)) continue;
          if ((call.duration || 0) < 10) continue;

          await new Promise((r) => setTimeout(r, 200));

          const transcript = await getCallTranscript(call.id);
          const quoSummary = await getCallSummary(call.id);

          let content = "";
          if (transcript && transcript.text) {
            content = transcript.text;
            for (const [phone, name] of Object.entries(contacts)) {
              if (phone.startsWith("+")) {
                content = content.replace(
                  new RegExp(phone.replace(/\+/g, "\\+"), "g"),
                  name
                );
              }
            }
          } else if (quoSummary && quoSummary.summary) {
            content = `Call Summary: ${quoSummary.summary}`;
            if (quoSummary.nextSteps)
              content += `\n\nNext Steps:\n- ${quoSummary.nextSteps}`;
          }

          if (!content || content.length < 20) {
            state.processedCallIds.push(call.id);
            results.skipped++;
            continue;
          }

          const callDate = call.createdAt
            ? new Date(call.createdAt).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0];
          const callTitle = `Call with ${participantLabel}`;
          const durationMin = Math.round((call.duration || 0) / 60);

          if (meetingNotes.isDuplicate(callDate, callTitle)) {
            state.processedCallIds.push(call.id);
            results.skipped++;
            continue;
          }

          const parsed = await summarizeQuoContent(
            content,
            callTitle,
            "Quo Call",
            participantLabel,
            durationMin
          );

          await meetingNotes.addToInbox({
            meetingTitle: parsed.title || callTitle,
            meetingDate: parsed.date || callDate,
            source: "Quo Call",
            project: parsed.project,
            suggestedFileName:
              parsed.suggestedFileName ||
              `quo_call_${participantLabel.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
            summary: parsed.summary,
            actionItems: parsed.actionItems,
            keyDecisions: parsed.keyDecisions,
            participants: participantLabel,
            fullContent: content,
          });

          state.processedCallIds.push(call.id);
          results.calls++;
        }

        callPageToken = callsRes.nextPageToken;
      } while (callPageToken);
    } catch (err) {
      console.error(
        `[Quo Backfill] Call error for conv ${conv.id}:`,
        err.message
      );
      results.errors++;
    }

    // SMS
    try {
      const msgsRes = await quoFetch("/messages", {
        phoneNumberId,
        participants,
        createdAfter: since,
        maxResults: 100,
      });

      const messages = (msgsRes.data || []).filter(
        (m) => m.text && m.text.trim().length > 0
      );

      if (messages.length >= 2) {
        const threadText = messages
          .map((m) => {
            const sender =
              m.direction === "outgoing"
                ? "Greg"
                : resolvePhoneToName(m.from, contacts);
            const time = new Date(m.createdAt).toLocaleString("en-US", {
              timeZone: "America/Chicago",
            });
            return `[${time}] ${sender}: ${m.text}`;
          })
          .join("\n");

        const smsDate = messages[0]?.createdAt
          ? new Date(messages[0].createdAt).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];
        const smsTitle = `SMS with ${participantLabel} (${messages.length} msgs)`;

        if (!meetingNotes.isDuplicate(smsDate, smsTitle)) {
          const parsed = await summarizeQuoContent(
            threadText,
            smsTitle,
            "Quo SMS",
            participantLabel,
            null
          );

          await meetingNotes.addToInbox({
            meetingTitle: parsed.title || smsTitle,
            meetingDate: parsed.date || smsDate,
            source: "Quo SMS",
            project: parsed.project,
            suggestedFileName:
              parsed.suggestedFileName ||
              `quo_sms_${participantLabel.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
            summary: parsed.summary,
            actionItems: parsed.actionItems,
            keyDecisions: parsed.keyDecisions,
            participants: participantLabel,
            fullContent: threadText,
          });
          results.sms++;
        } else {
          results.skipped++;
        }

        const latestMsg = messages[messages.length - 1];
        if (latestMsg)
          state.processedConversationTimestamps[conv.id] =
            latestMsg.createdAt;
      }
    } catch (err) {
      console.error(
        `[Quo Backfill] SMS error for conv ${conv.id}:`,
        err.message
      );
      results.errors++;
    }

    if (progressCallback && (i + 1) % 10 === 0) {
      progressCallback(
        `Processed ${i + 1}/${allConversations.length} conversations...`
      );
    }
  }

  state.lastPollTime = new Date().toISOString();
  saveState(state);

  console.log(
    `[Quo Backfill] Done. Calls: ${results.calls}, SMS: ${results.sms}, Skipped: ${results.skipped}, Errors: ${results.errors}`
  );
  return {
    ...results,
    message: `Quo backfill complete. ${results.calls} calls + ${results.sms} SMS threads added. ${results.skipped} skipped. ${results.errors} errors.`,
  };
}

// --- Search Quo activity in meeting notes sheet ---
async function searchQuoActivity(query) {
  const meetingNotes = require("./meeting-notes");
  const meetingResults = await meetingNotes.searchMeetingNotes(query, true);
  const quoResults = meetingResults.results.filter(
    (r) => r.source === "Quo Call" || r.source === "Quo SMS"
  );
  return {
    results: quoResults,
    total: quoResults.length,
  };
}

module.exports = {
  pollQuo,
  backfillQuo,
  searchQuoActivity,
  discoverPhoneNumbers,
  refreshContacts,
};
