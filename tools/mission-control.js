// Mission Control — Unified feed aggregator, triage, SSE, morning briefing
// Loops over channel connectors, normalizes messages, classifies with Haiku,
// caches to data/feed-cache.json, and pushes to dashboard via SSE.

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const gmailConnector = require("../connectors/gmail");
const slackConnector = require("../connectors/slack");
const gchatConnector = require("../connectors/gchat");
const quoConnector = require("../connectors/quo");
const ghlConnector = require("../connectors/ghl");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FEED_CACHE_PATH = path.join(__dirname, "../data/feed-cache.json");
const MAX_FEED_ITEMS = 1000;

// In-memory feed cache
let feedCache = [];
let lastAggregation = null;

// SSE clients for real-time push
const sseClients = new Set();

// All connectors in order
const connectors = [gmailConnector, slackConnector, gchatConnector, quoConnector, ghlConnector];

// --- Feed Cache Persistence ---

function loadFeedCache() {
  try {
    const data = JSON.parse(fs.readFileSync(FEED_CACHE_PATH, "utf-8"));
    feedCache = data.items || [];
    lastAggregation = data.lastAggregation || null;
    console.log(`[MissionControl] Loaded ${feedCache.length} cached feed items.`);
  } catch {
    feedCache = [];
    lastAggregation = null;
  }
}

function saveFeedCache() {
  try {
    fs.writeFileSync(
      FEED_CACHE_PATH,
      JSON.stringify({ items: feedCache, lastAggregation }, null, 2)
    );
  } catch (err) {
    console.error("[MissionControl] Failed to save feed cache:", err.message);
  }
}

// --- Universal Triage ---
// Classifies any message (not just email) using Haiku

let dealClassifier;
try {
  dealClassifier = require("./deal-classifier");
} catch {
  dealClassifier = null;
}

async function triageMessage(item) {
  // CRM items skip triage (always relevant)
  if (item.channel === "crm" || item.channel === "call") {
    return { action: "fyi", deal: null, urgency: 50 };
  }

  const content = [
    `Channel: ${item.channel}`,
    `From: ${item.from}`,
    item.subject ? `Subject: ${item.subject}` : "",
    `Message: ${item.preview}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    // Reuse the deal classifier's deal labels and VIP senders
    let dealContext = "No active deals configured.";
    let vipList = "none configured";

    if (dealClassifier) {
      const dealLabels = dealClassifier.getDealLabels();
      if (dealLabels.length > 0) {
        dealContext = dealLabels.map((d) => `- "${d.label}" = ${d.deal}: ${d.context}`).join("\n");
      }
    }

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `You triage messages for Greg Francis, CEO of GF Development LLC (land acquisition and entitlements).
This message came from: ${item.channel.toUpperCase()} channel.

STAR if: someone asks Greg a question, deal update needing attention, time-sensitive, VIP sender, direct outreach, active deal thread.
FYI if: informational, no action needed, not from VIP.
NOISE if: marketing, automated, irrelevant, spam.

When in doubt, star. Greg prefers false positives.

ACTIVE DEALS:
${dealContext}

MESSAGE:
${content}

Respond with exactly two lines:
Line 1: "star", "fyi", or "noise"
Line 2: The deal name from the list above, "unknown" if seems deal-related but unclear, or "none"`,
        },
      ],
    });

    const result = (response.content[0].text || "").trim();
    const lines = result.split("\n").map((l) => l.trim());

    const action = ["star", "fyi", "noise"].includes(lines[0]?.toLowerCase())
      ? lines[0].toLowerCase()
      : "fyi";

    let deal = (lines[1] || "none").replace(/^["']|["']$/g, "").trim();
    if (deal.toLowerCase() === "none") deal = null;
    if (deal?.toLowerCase() === "unknown") deal = "unknown";

    // Simple urgency scoring based on action
    const urgency = action === "star" ? 80 : action === "fyi" ? 40 : 10;

    return { action, deal, urgency };
  } catch (err) {
    console.error("[MissionControl] Triage error:", err.message);
    return { action: "fyi", deal: null, urgency: 50 };
  }
}

// --- Feed Aggregation ---

async function aggregateFeed() {
  const since = lastAggregation || new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  console.log(`[MissionControl] Aggregating feed since ${since}...`);

  let newItems = [];

  for (const connector of connectors) {
    if (!connector.enabled) continue;
    try {
      const items = await connector.fetchRecent(since);
      newItems = newItems.concat(items);
    } catch (err) {
      console.error(`[MissionControl] ${connector.name} fetch error:`, err.message);
    }
  }

  // Deduplicate against existing cache
  const existingIds = new Set(feedCache.map((i) => i.id));
  const genuinelyNew = newItems.filter((i) => !existingIds.has(i.id));

  console.log(`[MissionControl] Found ${genuinelyNew.length} new items across all channels.`);

  // Triage new items
  for (const item of genuinelyNew) {
    try {
      const triage = await triageMessage(item);
      item.triage = triage;
      item.starred = triage.action === "star";
      item.deal = triage.deal || item.deal;
    } catch (err) {
      console.error(`[MissionControl] Triage failed for ${item.id}:`, err.message);
      item.triage = { action: "fyi", deal: null, urgency: 50 };
    }
  }

  // Add to cache
  feedCache = [...genuinelyNew, ...feedCache]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, MAX_FEED_ITEMS);

  lastAggregation = new Date().toISOString();
  saveFeedCache();

  // Push new items to SSE clients
  if (genuinelyNew.length > 0) {
    pushSSE("new_items", {
      count: genuinelyNew.length,
      items: genuinelyNew,
    });
  }

  return {
    total: feedCache.length,
    new: genuinelyNew.length,
    byChannel: {
      email: genuinelyNew.filter((i) => i.channel === "email").length,
      slack: genuinelyNew.filter((i) => i.channel === "slack").length,
      gchat: genuinelyNew.filter((i) => i.channel === "gchat").length,
      sms: genuinelyNew.filter((i) => i.channel === "sms").length,
      call: genuinelyNew.filter((i) => i.channel === "call").length,
      crm: genuinelyNew.filter((i) => i.channel === "crm").length,
    },
  };
}

// --- Real-time Message Handler ---
// Called by PubSub webhooks and Socket Mode events

async function handleRealtimeMessage(connector, rawData) {
  try {
    let item;
    if (connector.handlePush) {
      const result = await connector.handlePush(rawData);
      // handlePush can return a single item or an array
      const items = Array.isArray(result) ? result : result ? [result] : [];
      if (items.length === 0) return;

      for (const feedItem of items) {
        // Check for duplicates
        if (feedCache.some((existing) => existing.id === feedItem.id)) continue;

        // Triage
        const triage = await triageMessage(feedItem);
        feedItem.triage = triage;
        feedItem.starred = triage.action === "star";
        feedItem.deal = triage.deal || feedItem.deal;

        // Add to cache
        feedCache.unshift(feedItem);
        if (feedCache.length > MAX_FEED_ITEMS) feedCache.pop();

        // Push to dashboard
        pushSSE("new_message", feedItem);
      }

      saveFeedCache();
    }
  } catch (err) {
    console.error(`[MissionControl] Real-time handler error:`, err.message);
  }
}

// --- SSE Management ---

function addSSEClient(res) {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

function pushSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// --- Feed Queries ---

function getFeed({ channel, starred, since, limit = 50, offset = 0, search } = {}) {
  let items = [...feedCache];

  if (channel && channel !== "all") {
    items = items.filter((i) => i.channel === channel);
  }
  if (starred) {
    items = items.filter((i) => i.starred);
  }
  if (since) {
    const sinceDate = new Date(since);
    items = items.filter((i) => new Date(i.timestamp) > sinceDate);
  }
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(
      (i) =>
        (i.from || "").toLowerCase().includes(q) ||
        (i.subject || "").toLowerCase().includes(q) ||
        (i.preview || "").toLowerCase().includes(q) ||
        (i.deal || "").toLowerCase().includes(q)
    );
  }

  const total = items.length;
  items = items.slice(offset, offset + limit);

  return { items, total, offset, limit };
}

function getStats() {
  const unread = feedCache.filter((i) => !i.read);
  return {
    total: feedCache.length,
    unread: unread.length,
    starred: feedCache.filter((i) => i.starred).length,
    byChannel: {
      email: unread.filter((i) => i.channel === "email").length,
      slack: unread.filter((i) => i.channel === "slack").length,
      gchat: unread.filter((i) => i.channel === "gchat").length,
      sms: unread.filter((i) => i.channel === "sms").length,
      call: unread.filter((i) => i.channel === "call").length,
      crm: unread.filter((i) => i.channel === "crm").length,
    },
    lastSync: lastAggregation,
  };
}

// --- Star / Read Toggle ---

function toggleStar(itemId) {
  const item = feedCache.find((i) => i.id === itemId);
  if (!item) return null;
  item.starred = !item.starred;
  saveFeedCache();
  pushSSE("item_updated", { id: itemId, starred: item.starred });
  return item;
}

function markItemRead(itemId) {
  const item = feedCache.find((i) => i.id === itemId);
  if (!item) return null;
  item.read = true;
  saveFeedCache();
  pushSSE("item_updated", { id: itemId, read: true });
  return item;
}

// --- Morning Briefing ---

async function getMorningBriefing() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recentItems = feedCache.filter((i) => new Date(i.timestamp) > yesterday);
  const starred = recentItems.filter((i) => i.starred);
  const unread = recentItems.filter((i) => !i.read);

  // Get today's calendar
  let calendarText = "";
  try {
    const calendar = require("./calendar");
    const events = await calendar.listEvents(1);
    if (events && events.length > 0) {
      calendarText = events
        .slice(0, 5)
        .map((e) => {
          const time = new Date(e.start).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Chicago",
          });
          return `* ${time} — ${e.summary}`;
        })
        .join("\n");
    }
  } catch {
    calendarText = "Calendar unavailable";
  }

  // Get pipeline status
  let pipelineText = "";
  try {
    const pipeline = require("./pipeline");
    const summary = await pipeline.getPipelineSummary();
    if (typeof summary === "string") {
      pipelineText = summary.substring(0, 300);
    }
  } catch {
    pipelineText = "Pipeline unavailable";
  }

  const dashboardUrl = process.env.DASHBOARD_URL || "https://your-dashboard-url";

  const briefing = [
    `MORNING BRIEFING — ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" })}`,
    "",
    `${starred.length} items need attention | ${recentItems.length} new since yesterday`,
    `Open dashboard: ${dashboardUrl}`,
    "",
  ];

  if (starred.length > 0) {
    briefing.push("NEEDS ATTENTION");
    for (const item of starred.slice(0, 8)) {
      const age = getRelativeTime(item.timestamp);
      briefing.push(`* [${item.channel.toUpperCase()}] ${item.from} — ${item.subject || item.preview.substring(0, 50)} (${age})`);
    }
    briefing.push("");
  }

  if (calendarText) {
    briefing.push("TODAY");
    briefing.push(calendarText);
    briefing.push("");
  }

  if (pipelineText) {
    briefing.push("PIPELINE");
    briefing.push(pipelineText);
  }

  return briefing.join("\n");
}

function getRelativeTime(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Connector Access ---

function getConnector(channel) {
  return connectors.find((c) => c.name === channel) || null;
}

// --- Initialize ---

function init() {
  loadFeedCache();
  // Check which connectors are enabled
  for (const c of connectors) {
    console.log(`[MissionControl] ${c.name}: ${c.enabled ? "enabled" : "disabled"}`);
  }
  // Check Google Chat availability
  gchatConnector.checkEnabled().catch(() => {});
}

module.exports = {
  init,
  aggregateFeed,
  handleRealtimeMessage,
  getFeed,
  getStats,
  toggleStar,
  markItemRead,
  getMorningBriefing,
  getConnector,
  addSSEClient,
  pushSSE,
  connectors,
  loadFeedCache,
};
