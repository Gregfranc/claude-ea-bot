// Dashboard API routes
// Express routes for the Mission Control web dashboard

const express = require("express");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const mc = require("../tools/mission-control");
const pubsub = require("../tools/pubsub");
const gmailConnector = require("../connectors/gmail");
const gchatConnector = require("../connectors/gchat");

const router = express.Router();

const OWNER_USER_ID = "U092AE1836K"; // Greg's Slack user ID
const JWT_SECRET = () => process.env.DASHBOARD_SECRET || "change-me-in-production";
const COOKIE_NAME = "mc_session";
const SESSION_DAYS = 7;

// Pending magic link tokens: { token: { slackUserId, createdAt } }
const pendingTokens = {};

// --- Auth Middleware ---

function authRequired(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired" });
  }
}

// --- Auth Routes ---

// Request a magic link (sends to Slack DM)
router.post("/auth/request", async (req, res) => {
  const token = crypto.randomBytes(32).toString("hex");
  pendingTokens[token] = { slackUserId: OWNER_USER_ID, createdAt: Date.now() };
  console.log(`[Dashboard Auth] Token created: ${token.substring(0, 8)}... (${Object.keys(pendingTokens).length} pending)`);

  // Clean up old tokens (older than 15 minutes)
  const now = Date.now();
  for (const [t, data] of Object.entries(pendingTokens)) {
    if (now - data.createdAt > 15 * 60 * 1000) delete pendingTokens[t];
  }

  const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:3001`;
  const verifyUrl = `${dashboardUrl}/api/auth/verify?token=${token}`;

  // Send magic link via Slack DM
  try {
    const slackApp = req.app.get("slackApp");
    if (slackApp) {
      await slackApp.client.chat.postMessage({
        channel: OWNER_USER_ID,
        text: `Mission Control login link (expires in 15 min):\n${verifyUrl}`,
      });
    }
  } catch (err) {
    console.error("[Dashboard Auth] Failed to send Slack DM:", err.message);
  }

  res.json({ success: true, message: "Magic link sent to your Slack DM" });
});

// Verify magic link — GET shows confirmation page (Slack unfurls links,
// consuming the token before the user clicks). POST actually logs in.
router.get("/auth/verify", (req, res) => {
  const { token } = req.query;
  if (!token || !pendingTokens[token]) {
    return res.status(400).send("Invalid or expired link. Request a new one from the dashboard.");
  }
  // Show confirmation page — don't consume token on GET
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mission Control Login</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem}button{background:#3b82f6;color:white;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer}
button:hover{background:#2563eb}</style></head>
<body><div class="card"><h2>Mission Control</h2><p>Click to log in:</p>
<form method="POST" action="/api/auth/verify"><input type="hidden" name="token" value="${token}">
<button type="submit">Log In</button></form></div></body></html>`);
});

router.post("/auth/verify", express.urlencoded({ extended: false }), (req, res) => {
  const token = req.body?.token;
  if (!token || !pendingTokens[token]) {
    return res.status(400).send("Invalid or expired link. Request a new one from the dashboard.");
  }

  const data = pendingTokens[token];
  delete pendingTokens[token];

  if (Date.now() - data.createdAt > 15 * 60 * 1000) {
    return res.status(400).send("Link expired. Request a new one from the dashboard.");
  }

  const sessionToken = jwt.sign({ userId: data.slackUserId }, JWT_SECRET(), {
    expiresIn: `${SESSION_DAYS}d`,
  });

  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });

  const dashboardUrl = process.env.DASHBOARD_URL || "";
  res.redirect(dashboardUrl || "/");
});

// Direct login (temporary, for initial setup before HTTPS)
router.get("/auth/direct", (req, res) => {
  const secret = req.query.secret;
  if (secret !== (process.env.DASHBOARD_SECRET || "change-me-in-production")) {
    return res.status(403).send("Forbidden");
  }
  const sessionToken = jwt.sign({ userId: OWNER_USER_ID }, JWT_SECRET(), {
    expiresIn: `${SESSION_DAYS}d`,
  });
  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  res.redirect("/");
});

// Check auth status
router.get("/auth/status", (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.json({ authenticated: false });

  try {
    jwt.verify(token, JWT_SECRET());
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

// --- Feed Routes (auth required) ---

router.get("/feed", authRequired, (req, res) => {
  const { channel, starred, since, limit, offset, search } = req.query;
  const result = mc.getFeed({
    channel: channel || "all",
    starred: starred === "true",
    since,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0,
    search,
  });
  res.json(result);
});

// SSE stream for real-time updates
router.get("/stream", authRequired, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial ping
  res.write("event: connected\ndata: {}\n\n");

  // Register for updates
  mc.addSSEClient(res);

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write("event: ping\ndata: {}\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

// Get full message thread
router.get("/message/:channel/:sourceId(*)", authRequired, async (req, res) => {
  const { channel, sourceId } = req.params;
  const connector = mc.getConnector(channel);
  if (!connector) return res.status(400).json({ error: `Unknown channel: ${channel}` });

  try {
    const thread = await connector.getThread(sourceId);
    res.json(thread);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send reply through the correct channel
router.post("/reply", authRequired, async (req, res) => {
  const { channel, sourceId, body } = req.body;
  if (!channel || !sourceId || !body) {
    return res.status(400).json({ error: "channel, sourceId, and body are required" });
  }

  const connector = mc.getConnector(channel);
  if (!connector) return res.status(400).json({ error: `Unknown channel: ${channel}` });

  try {
    const result = await connector.sendReply(sourceId, body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle star
router.post("/star/:id", authRequired, async (req, res) => {
  const item = mc.toggleStar(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  // If it's an email, propagate star to Gmail
  if (item.channel === "email") {
    try {
      const gmail = require("../tools/gmail");
      const gmailClient = gmail.getGmail();
      if (item.starred) {
        await gmailClient.users.messages.modify({
          userId: "me",
          id: item.sourceId,
          requestBody: { addLabelIds: ["STARRED"] },
        });
      } else {
        await gmailClient.users.messages.modify({
          userId: "me",
          id: item.sourceId,
          requestBody: { removeLabelIds: ["STARRED"] },
        });
      }
    } catch (err) {
      console.error("[Dashboard] Gmail star sync error:", err.message);
    }
  }

  res.json(item);
});

// Mark as read
router.post("/read/:id", authRequired, async (req, res) => {
  const item = mc.markItemRead(req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  // Propagate to source system
  const connector = mc.getConnector(item.channel);
  if (connector) {
    try {
      await connector.markRead(item.sourceId);
    } catch (err) {
      console.error("[Dashboard] Mark read sync error:", err.message);
    }
  }

  res.json(item);
});

// Stats
router.get("/stats", authRequired, (req, res) => {
  res.json(mc.getStats());
});

// Today's calendar
router.get("/calendar/today", authRequired, async (req, res) => {
  try {
    const calendar = require("../tools/calendar");
    const events = await calendar.listEvents(1);
    res.json({ events: events || [] });
  } catch (err) {
    res.json({ events: [], error: err.message });
  }
});

// Pipeline summary
router.get("/pipeline", authRequired, async (req, res) => {
  try {
    const pipeline = require("../tools/pipeline");
    const summary = await pipeline.getPipelineSummary();
    res.json({ summary });
  } catch (err) {
    res.json({ summary: null, error: err.message });
  }
});

// --- PubSub Webhook Endpoints (no auth, validated by PubSub signature) ---

router.post("/webhook/gmail", async (req, res) => {
  // Acknowledge immediately (PubSub requires fast response)
  res.status(200).send("OK");

  const payload = pubsub.parseGmailPush(req.body);
  if (!payload) return;

  console.log(`[PubSub] Gmail push: historyId=${payload.historyId}`);

  // Update history ID and fetch new messages
  const prevHistoryId = pubsub.getGmailHistoryId();
  if (prevHistoryId) {
    await mc.handleRealtimeMessage(gmailConnector, prevHistoryId);
  }
  pubsub.setGmailHistoryId(payload.historyId);
});

router.post("/webhook/gchat", async (req, res) => {
  res.status(200).send("OK");

  const payload = pubsub.parseGChatPush(req.body);
  if (!payload) return;

  console.log("[PubSub] Google Chat push received");
  await mc.handleRealtimeMessage(gchatConnector, payload);
});

module.exports = router;
