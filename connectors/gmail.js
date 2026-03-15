// Gmail channel connector
// Wraps existing tools/gmail.js for the Mission Control feed

const { ChannelConnector, createFeedItem } = require("./base");
const gmail = require("../tools/gmail");

class GmailConnector extends ChannelConnector {
  constructor() {
    super("email", "blue-500", "mail");
  }

  async fetchRecent(since) {
    const sinceDate = new Date(since);
    const hoursBack = Math.max(1, Math.ceil((Date.now() - sinceDate.getTime()) / (1000 * 60 * 60)));
    const query = `newer_than:${hoursBack}h -in:sent -label:EA-Noise`;

    try {
      const { results } = await gmail.searchEmails(query, 50);
      if (!results || results.length === 0) return [];

      return results.map((email) => {
        const isStarred = false; // searchEmails doesn't return label info; triage handles starring
        return createFeedItem({
          channel: "email",
          from: extractName(email.from),
          fromEmail: extractEmail(email.from),
          subject: email.subject,
          preview: email.snippet,
          timestamp: email.date,
          read: false,
          starred: isStarred,
          threadId: email.threadId,
          sourceId: email.id,
          replyable: true,
        });
      });
    } catch (err) {
      console.error("[Gmail Connector] fetchRecent error:", err.message);
      return [];
    }
  }

  async getThread(messageId) {
    try {
      const email = await gmail.readEmail(messageId);
      return {
        messages: [
          {
            from: email.from,
            body: email.body,
            timestamp: email.date,
            subject: email.subject,
          },
        ],
        metadata: {
          threadId: email.threadId,
          labels: email.labels || [],
          subject: email.subject,
        },
      };
    } catch (err) {
      console.error("[Gmail Connector] getThread error:", err.message);
      return { messages: [], metadata: {} };
    }
  }

  async sendReply(messageId, body) {
    try {
      const result = await gmail.replyToEmail(messageId, body);
      return { success: true, messageId: result.messageId };
    } catch (err) {
      console.error("[Gmail Connector] sendReply error:", err.message);
      return { success: false, error: err.message };
    }
  }

  async markRead(messageId) {
    try {
      const gmailClient = gmail.getGmail();
      await gmailClient.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
      return { success: true };
    } catch (err) {
      console.error("[Gmail Connector] markRead error:", err.message);
      return { success: false, error: err.message };
    }
  }

  // Process PubSub push notification for new email
  async handlePush(historyId) {
    try {
      const gmailClient = gmail.getGmail();
      // Fetch recent history changes
      const history = await gmailClient.users.history.list({
        userId: "me",
        startHistoryId: historyId,
        historyTypes: ["messageAdded"],
      });

      const items = [];
      for (const record of history.data.history || []) {
        for (const added of record.messagesAdded || []) {
          const msgId = added.message.id;
          const labels = added.message.labelIds || [];
          // Skip sent messages and already-triaged
          if (labels.includes("SENT")) continue;

          try {
            const email = await gmail.readEmail(msgId);
            items.push(
              createFeedItem({
                channel: "email",
                from: extractName(email.from),
                fromEmail: extractEmail(email.from),
                subject: email.subject,
                preview: (email.body || "").substring(0, 200),
                timestamp: email.date,
                read: false,
                starred: labels.includes("STARRED"),
                threadId: email.threadId,
                sourceId: msgId,
                replyable: true,
                labels: labels,
              })
            );
          } catch (readErr) {
            console.error(`[Gmail Connector] Failed to read message ${msgId}:`, readErr.message);
          }
        }
      }
      return items;
    } catch (err) {
      console.error("[Gmail Connector] handlePush error:", err.message);
      return [];
    }
  }
}

// Helpers
function extractName(fromHeader) {
  if (!fromHeader) return "Unknown";
  const match = fromHeader.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : fromHeader.split("@")[0];
}

function extractEmail(fromHeader) {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.includes("@") ? fromHeader.trim() : null;
}

module.exports = new GmailConnector();
