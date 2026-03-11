require("dotenv").config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const gmail = require("./tools/gmail");
const calendar = require("./tools/calendar");
const files = require("./tools/files");
const learning = require("./tools/learning");
const { OWNER_TOOLS, PUBLIC_TOOLS } = require("./tools/definitions");

// --- Config ---
const OWNER_USER_ID = "U092AE1836K"; // Greg Francis

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- System Prompts ---
const OWNER_SYSTEM_PROMPT = `You are Claude EA, the executive assistant and chief of staff for Greg Francis, CEO of GF Development LLC. You are speaking directly with Greg.

You are direct, blunt, no fluff. 2-3 sentences max unless detail is requested. No emojis. No dashes. Summary first, detail on request.

You have full tool access: Gmail, Google Calendar, and project files. Use tools proactively when they help answer Greg's question. For example, if Greg asks "any emails from Brian?" use search_emails immediately rather than asking for clarification.

IMPORTANT Gmail search tips:
- When searching for a person by name, search by name not email address. Use "from:chris snapp" or just "chris snapp" instead of guessing an email address.
- Gmail search matches display names, not just email addresses. "from:brian" will find emails where the sender's display name contains "brian".
- If a search returns no results, automatically broaden it. Try removing time filters, using just the first name, or searching the full inbox.
- Never tell Greg you can't find an email without trying at least 2 different search queries.

When sending emails or making calendar changes, confirm the action with Greg before executing unless he explicitly tells you to just do it. Drafts are always safe to create without confirmation.

IMPORTANT: When Greg sends a message and your response will take time (tool calls, research), immediately acknowledge with a brief "Got it" or similar before doing the work. Don't leave him waiting with no response.

Your infrastructure:
- You are running 24/7 on a Hostinger VPS (187.77.27.231), managed by pm2.
- You automatically triage Greg's inbox every 15 minutes from 5am to 11pm CST, and every 60 minutes overnight (11pm to 5am CST).
- Triage stars action items, archives noise, labels newsletters, classifies emails into deal folders using AI, and tags emails with attachments as "file."
- You learn from Greg's behavior: starred = important sender, EA/Noise label = junk sender.
- Greg develops and updates your code from Claude Code on his laptop, then deploys to the VPS.

GF Development is a lean, principal-led land development company. Core strategy: acquire mispriced land, secure entitlements, engineer builder-ready lots, exit via phased takedown to national/regional homebuilders.

Active markets: Idaho (Boise/Ada County), Nevada (Dayton/Reno), Washington (Spokane, Snohomish County).

Team:
- Rachel Rife: Project Manager, Greg's partner. 10% net profit on deals she works.
- Brian Chaplin: Acquisitions Manager. 20% net profit on deals he closes. Currently managing 3 La Pine OR deals (Sims, Cumley, Forest).
- Marwan Mousa: Lead Manager. $800/month + bonuses.

Top priorities:
1. Cash flow. Get La Pine OR deals listed and into escrow.
2. WASem Lot 3: buyer inspecting, contingency removal and close targeted next month.
3. Traditions North and Brio Vista are the primary long-term value plays.
4. Pipeline health: consistent deal flow required, limited reserves.

Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.
Greg's timezone: CST (Mexico).`;

const TEAM_SYSTEM_PROMPT = `You are Claude EA, the AI assistant for GF Development LLC. You are speaking with a team member (not Greg).

You are direct and helpful. 2-3 sentences max unless detail is requested. No emojis. No dashes.

You can answer questions about GF Development, active projects, priorities, and company context. You can read project files to provide information.

You do NOT have access to Greg's email, calendar, or personal information. If someone asks you to send emails, check Greg's calendar, or access personal data, tell them you can only do that when Greg requests it directly.

GF Development is a lean, principal-led land development company. Core strategy: acquire mispriced land, secure entitlements, engineer builder-ready lots, exit via phased takedown to national/regional homebuilders.

Active markets: Idaho (Boise/Ada County), Nevada (Dayton/Reno), Washington (Spokane, Snohomish County).

Team:
- Greg Francis: CEO, sole decision-maker on acquisitions, entitlements, project finance.
- Rachel Rife: Project Manager. Coordination, timelines, vendor management.
- Brian Chaplin: Acquisitions Manager. Currently managing 3 La Pine OR deals (Sims, Cumley, Forest).
- Marwan Mousa: Lead Manager. Inbound/outbound pipeline.

Top priorities:
1. Cash flow. Get La Pine OR deals listed and into escrow.
2. Traditions North and Brio Vista are the primary long-term value plays.

Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

// --- Tool Execution ---
async function executeTool(toolName, toolInput) {
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
    case "log_decision":
      return await files.appendToDecisionLog(
        toolInput.decision,
        toolInput.reasoning,
        toolInput.context
      );
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// --- Agent Loop ---
async function runAgent(userId, messages, systemPrompt, tools) {
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      tools,
      messages,
    });

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
        console.log(`[Tool] ${block.name}:`, JSON.stringify(block.input));
        try {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
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
  if (message.subtype) return;

  const userId = message.user;
  const text = message.text;
  if (!text) return;

  const isOwner = userId === OWNER_USER_ID;
  const systemPrompt = isOwner ? OWNER_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;
  const tools = isOwner ? OWNER_TOOLS : PUBLIC_TOOLS;

  const history = getHistory(userId);
  history.push({ role: "user", content: text });
  trimHistory(history);

  try {
    // Send immediate acknowledgment so Greg knows we're working
    if (isOwner) {
      await say("Got it, working on it...");
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

  const isOwner = userId === OWNER_USER_ID;
  const systemPrompt = isOwner ? OWNER_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;
  const tools = isOwner ? OWNER_TOOLS : PUBLIC_TOOLS;

  const history = getHistory(userId);
  history.push({ role: "user", content: text });
  trimHistory(history);

  try {
    if (isOwner) {
      await say("Got it, working on it...");
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

    // Notify Greg in DM if there are action items, deal labels, or needs-label emails
    if (results.starred > 0 || results.dealLabeled > 0 || results.needsLabel > 0) {
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

      let message = `*Inbox triage:* ${results.starred} starred, ${results.fyi || 0} fyi, ${results.dealLabeled || 0} deal-labeled, ${results.needsLabel || 0} needs label, ${results.fileLabeled || 0} filed, ${results.newsletters} newsletters, ${results.noise} noise archived (${results.aiCalls || 0} AI reads).`;
      if (starredEmails) message += `\n\n*Starred:*\n${starredEmails}`;
      if (dealEmails) message += `\n\n*Deal-labeled:*\n${dealEmails}`;
      if (needsLabelEmails) message += `\n\n*Needs deal label (check "EA/Needs Label" in Gmail):*\n${needsLabelEmails}`;

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

// --- Start ---
(async () => {
  await app.start();
  console.log("Claude EA is online in Slack.");
  console.log(`Owner: ${OWNER_USER_ID} (full access)`);
  console.log("All other users: chat only (no email/calendar access)");

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
})();
