// Slack channel connector
// Uses the Slack Web API via the bot's existing app instance

const { ChannelConnector, createFeedItem } = require("./base");

let slackClient = null;
let botUserId = null;
let ownerUserId = null;

// Must be called once at startup with the Slack app instance
function init(app, ownerId) {
  slackClient = app.client;
  ownerUserId = ownerId || null;
  // Get bot's own user ID so we can exclude its messages
  slackClient.auth.test().then((res) => {
    botUserId = res.user_id;
  }).catch(() => {});
}

class SlackConnector extends ChannelConnector {
  constructor() {
    super("slack", "purple-500", "hash");
  }

  async fetchRecent(since) {
    if (!slackClient) return [];
    const sinceTs = new Date(since).getTime() / 1000;

    try {
      // Get DM conversations (IM channels)
      const convos = await slackClient.conversations.list({
        types: "im",
        limit: 50,
      });

      const items = [];
      for (const ch of convos.channels || []) {
        // Skip bot's own DM channel
        if (ch.user === botUserId) continue;

        try {
          const history = await slackClient.conversations.history({
            channel: ch.id,
            oldest: String(sinceTs),
            limit: 10,
          });

          for (const msg of history.messages || []) {
            // Skip bot's own messages and Greg's outgoing messages
            if (msg.user === botUserId) continue;
            if (msg.user === ownerUserId) continue;
            if (msg.subtype === "bot_message") continue;

            const userName = await resolveUser(msg.user);
            items.push(
              createFeedItem({
                channel: "slack",
                from: userName,
                subject: null,
                preview: msg.text || "",
                timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
                read: false,
                sourceId: `${ch.id}_${msg.ts}`,
                threadId: msg.thread_ts || msg.ts,
                replyable: true,
              })
            );
          }
        } catch (histErr) {
          // Channel might be archived or inaccessible
          continue;
        }
      }

      // Also check mentions in channels the bot is in
      try {
        const channelConvos = await slackClient.conversations.list({
          types: "public_channel,private_channel",
          limit: 50,
        });

        for (const ch of channelConvos.channels || []) {
          if (!ch.is_member) continue;
          try {
            const history = await slackClient.conversations.history({
              channel: ch.id,
              oldest: String(sinceTs),
              limit: 20,
            });

            for (const msg of history.messages || []) {
              if (msg.user === botUserId) continue;
              // Only include messages that mention the bot or are in threads with the bot
              if (!msg.text || !msg.text.includes(`<@${botUserId}>`)) continue;

              const userName = await resolveUser(msg.user);
              items.push(
                createFeedItem({
                  channel: "slack",
                  from: `${userName} in #${ch.name}`,
                  subject: `#${ch.name}`,
                  preview: msg.text.replace(/<@[A-Z0-9]+>/g, "@user") || "",
                  timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
                  read: false,
                  sourceId: `${ch.id}_${msg.ts}`,
                  threadId: msg.thread_ts || msg.ts,
                  replyable: true,
                })
              );
            }
          } catch {
            continue;
          }
        }
      } catch (chErr) {
        console.error("[Slack Connector] Channel fetch error:", chErr.message);
      }

      return items;
    } catch (err) {
      console.error("[Slack Connector] fetchRecent error:", err.message);
      return [];
    }
  }

  async getThread(sourceId) {
    if (!slackClient) return { messages: [], metadata: {} };

    try {
      const [channelId, ts] = sourceId.split("_");
      const result = await slackClient.conversations.replies({
        channel: channelId,
        ts: ts,
        limit: 50,
      });

      const messages = [];
      for (const msg of result.messages || []) {
        const userName = await resolveUser(msg.user);
        messages.push({
          from: userName,
          body: msg.text || "",
          timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        });
      }

      return { messages, metadata: { channelId, threadTs: ts } };
    } catch (err) {
      console.error("[Slack Connector] getThread error:", err.message);
      return { messages: [], metadata: {} };
    }
  }

  async sendReply(sourceId, body) {
    if (!slackClient) return { success: false, error: "Slack not initialized" };

    try {
      const [channelId, ts] = sourceId.split("_");
      const result = await slackClient.chat.postMessage({
        channel: channelId,
        text: body,
        thread_ts: ts,
      });
      return { success: true, messageId: result.ts };
    } catch (err) {
      console.error("[Slack Connector] sendReply error:", err.message);
      return { success: false, error: err.message };
    }
  }

  async markRead(sourceId) {
    if (!slackClient) return { success: false };

    try {
      const [channelId, ts] = sourceId.split("_");
      await slackClient.conversations.mark({
        channel: channelId,
        ts: ts,
      });
      return { success: true };
    } catch (err) {
      // conversations.mark often fails for DMs; not critical
      return { success: false, error: err.message };
    }
  }

  // Process a real-time Socket Mode message event
  async handleEvent(event) {
    if (!event || !event.text) return null;
    if (event.user === botUserId) return null;
    if (event.user === ownerUserId) return null;
    if (event.subtype === "bot_message") return null;

    const userName = await resolveUser(event.user);
    const channelId = event.channel;

    return createFeedItem({
      channel: "slack",
      from: userName,
      subject: null,
      preview: event.text || "",
      timestamp: new Date(parseFloat(event.ts) * 1000).toISOString(),
      read: false,
      sourceId: `${channelId}_${event.ts}`,
      threadId: event.thread_ts || event.ts,
      replyable: true,
    });
  }
}

// User name cache
const userCache = {};
async function resolveUser(userId) {
  if (!userId) return "Unknown";
  if (userCache[userId]) return userCache[userId];
  if (!slackClient) return userId;

  try {
    const res = await slackClient.users.info({ user: userId });
    const name = res.user?.real_name || res.user?.name || userId;
    userCache[userId] = name;
    return name;
  } catch {
    return userId;
  }
}

const connector = new SlackConnector();
module.exports = connector;
module.exports.init = init;
