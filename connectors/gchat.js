// Google Chat channel connector
// Uses Google Chat API via googleapis

const { google } = require("googleapis");
const { ChannelConnector, createFeedItem } = require("./base");

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

function getChat() {
  return google.chat({ version: "v1", auth: getAuth() });
}

class GChatConnector extends ChannelConnector {
  constructor() {
    super("gchat", "green-600", "chat");
    // Google Chat API may not be enabled yet
    this.enabled = false;
  }

  async checkEnabled() {
    try {
      const chat = getChat();
      await chat.spaces.list({ pageSize: 1 });
      this.enabled = true;
      return true;
    } catch (err) {
      console.log("[GChat Connector] Not enabled:", err.message);
      this.enabled = false;
      return false;
    }
  }

  async fetchRecent(since) {
    if (!this.enabled) return [];

    try {
      const chat = getChat();
      const sinceDate = new Date(since);

      // List spaces the user is a member of
      const spacesRes = await chat.spaces.list({ pageSize: 50 });
      const spaces = spacesRes.data.spaces || [];

      const items = [];
      for (const space of spaces) {
        // Only DMs and named spaces, skip unnamed group chats
        if (space.type === "GROUP_CHAT" && !space.displayName) continue;

        try {
          // List recent messages in this space
          const msgsRes = await chat.spaces.messages.list({
            parent: space.name,
            pageSize: 20,
            orderBy: "createTime desc",
            filter: `createTime > "${sinceDate.toISOString()}"`,
          });

          for (const msg of msgsRes.data.messages || []) {
            // Skip our own messages
            if (msg.sender?.type === "BOT") continue;

            const senderName = msg.sender?.displayName || "Unknown";
            const spaceName = space.displayName || "DM";

            items.push(
              createFeedItem({
                channel: "gchat",
                from: space.type === "DM" ? senderName : `${senderName} in ${spaceName}`,
                subject: space.type !== "DM" ? spaceName : null,
                preview: msg.text || "",
                timestamp: msg.createTime,
                read: false,
                sourceId: msg.name, // spaces/xxx/messages/yyy
                threadId: msg.thread?.name || null,
                replyable: true,
              })
            );
          }
        } catch (msgErr) {
          // Space might not be accessible
          continue;
        }
      }

      return items;
    } catch (err) {
      console.error("[GChat Connector] fetchRecent error:", err.message);
      return [];
    }
  }

  async getThread(sourceId) {
    if (!this.enabled) return { messages: [], metadata: {} };

    try {
      const chat = getChat();
      // sourceId is spaces/xxx/messages/yyy
      const msg = await chat.spaces.messages.get({ name: sourceId });

      const messages = [
        {
          from: msg.data.sender?.displayName || "Unknown",
          body: msg.data.text || "",
          timestamp: msg.data.createTime,
        },
      ];

      // If part of a thread, fetch thread messages
      if (msg.data.thread?.name) {
        const spaceName = sourceId.split("/messages/")[0];
        try {
          const threadMsgs = await chat.spaces.messages.list({
            parent: spaceName,
            filter: `thread.name = "${msg.data.thread.name}"`,
            pageSize: 50,
          });

          const threadMessages = (threadMsgs.data.messages || []).map((m) => ({
            from: m.sender?.displayName || "Unknown",
            body: m.text || "",
            timestamp: m.createTime,
          }));

          if (threadMessages.length > 0) {
            return { messages: threadMessages, metadata: { threadName: msg.data.thread.name } };
          }
        } catch {
          // Thread fetch failed, return single message
        }
      }

      return { messages, metadata: {} };
    } catch (err) {
      console.error("[GChat Connector] getThread error:", err.message);
      return { messages: [], metadata: {} };
    }
  }

  async sendReply(sourceId, body) {
    if (!this.enabled) return { success: false, error: "Google Chat not enabled" };

    try {
      const chat = getChat();
      const spaceName = sourceId.split("/messages/")[0];

      // Get the original message to find its thread
      const original = await chat.spaces.messages.get({ name: sourceId });
      const threadName = original.data.thread?.name;

      const result = await chat.spaces.messages.create({
        parent: spaceName,
        requestBody: {
          text: body,
          thread: threadName ? { name: threadName } : undefined,
        },
      });

      return { success: true, messageId: result.data.name };
    } catch (err) {
      console.error("[GChat Connector] sendReply error:", err.message);
      return { success: false, error: err.message };
    }
  }

  // Process PubSub push notification for new Google Chat message
  async handlePush(eventData) {
    try {
      // eventData contains the Chat event payload
      const message = eventData.message;
      if (!message) return null;

      const senderName = message.sender?.displayName || "Unknown";
      const spaceName = eventData.space?.displayName || "DM";

      return createFeedItem({
        channel: "gchat",
        from: eventData.space?.type === "DM" ? senderName : `${senderName} in ${spaceName}`,
        subject: eventData.space?.type !== "DM" ? spaceName : null,
        preview: message.text || "",
        timestamp: message.createTime || new Date().toISOString(),
        read: false,
        sourceId: message.name,
        threadId: message.thread?.name || null,
        replyable: true,
      });
    } catch (err) {
      console.error("[GChat Connector] handlePush error:", err.message);
      return null;
    }
  }
}

module.exports = new GChatConnector();
