// Google PubSub setup for real-time Gmail and Google Chat push notifications
// Gmail: uses gmail.users.watch to register push to our webhook
// Google Chat: uses Chat API PubSub subscription

const { google } = require("googleapis");

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

// --- Gmail Push Notifications ---
// Registers Gmail to push new email notifications to our PubSub topic
// Must be called every 7 days to renew

let gmailHistoryId = null;
let gmailWatchExpiration = null;

async function setupGmailWatch() {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topicName) {
    console.log("[PubSub] GMAIL_PUBSUB_TOPIC not set, skipping Gmail push setup.");
    return null;
  }

  try {
    const gmailClient = google.gmail({ version: "v1", auth: getAuth() });

    const res = await gmailClient.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });

    gmailHistoryId = res.data.historyId;
    gmailWatchExpiration = res.data.expiration;

    console.log(
      `[PubSub] Gmail watch registered. History ID: ${gmailHistoryId}, expires: ${new Date(parseInt(gmailWatchExpiration)).toISOString()}`
    );

    return { historyId: gmailHistoryId, expiration: gmailWatchExpiration };
  } catch (err) {
    console.error("[PubSub] Gmail watch setup failed:", err.message);
    return null;
  }
}

// Schedule re-registration every 6 days (watch expires after 7)
let gmailWatchTimer = null;

function scheduleGmailWatchRenewal() {
  if (gmailWatchTimer) clearTimeout(gmailWatchTimer);

  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
  gmailWatchTimer = setTimeout(async () => {
    console.log("[PubSub] Renewing Gmail watch...");
    await setupGmailWatch();
    scheduleGmailWatchRenewal();
  }, SIX_DAYS_MS);

  console.log("[PubSub] Gmail watch renewal scheduled in 6 days.");
}

// --- Parse PubSub Push Messages ---

function parseGmailPush(body) {
  // Google PubSub sends: { message: { data: base64, messageId, publishTime } }
  try {
    if (!body || !body.message || !body.message.data) return null;

    const decoded = Buffer.from(body.message.data, "base64").toString("utf-8");
    const payload = JSON.parse(decoded);

    // payload: { emailAddress, historyId }
    return {
      emailAddress: payload.emailAddress,
      historyId: payload.historyId,
    };
  } catch (err) {
    console.error("[PubSub] Failed to parse Gmail push:", err.message);
    return null;
  }
}

function parseGChatPush(body) {
  // Google Chat PubSub events contain the Chat event payload
  try {
    if (!body || !body.message || !body.message.data) return null;

    const decoded = Buffer.from(body.message.data, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (err) {
    console.error("[PubSub] Failed to parse GChat push:", err.message);
    return null;
  }
}

// --- Get Current Gmail History ID ---

function getGmailHistoryId() {
  return gmailHistoryId;
}

function setGmailHistoryId(id) {
  gmailHistoryId = id;
}

// --- Initialize ---

async function init() {
  const result = await setupGmailWatch();
  if (result) {
    scheduleGmailWatchRenewal();
  }
}

module.exports = {
  init,
  setupGmailWatch,
  parseGmailPush,
  parseGChatPush,
  getGmailHistoryId,
  setGmailHistoryId,
};
