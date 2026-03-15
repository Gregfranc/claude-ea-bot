// Base channel connector interface
// Every channel (Gmail, Slack, Google Chat, Quo, GHL) implements this interface.
// The feed aggregator loops over connectors without knowing channel specifics.

class ChannelConnector {
  constructor(name, color, icon) {
    this.name = name;     // "email", "slack", "gchat", "sms", "call", "crm"
    this.color = color;   // Tailwind color class: "blue-500", "purple-500", etc.
    this.icon = icon;     // Emoji or icon identifier
    this.enabled = true;
  }

  // Fetch recent messages/activity since a given timestamp
  // Returns: [FeedItem, ...]
  async fetchRecent(since) {
    throw new Error(`${this.name}: fetchRecent() not implemented`);
  }

  // Load full conversation thread for detail view
  // Returns: { messages: [{ from, body, timestamp }], metadata: {} }
  async getThread(sourceId) {
    throw new Error(`${this.name}: getThread() not implemented`);
  }

  // Send a reply back through this channel
  // Returns: { success: boolean, messageId: string }
  async sendReply(sourceId, body) {
    throw new Error(`${this.name}: sendReply() not implemented`);
  }

  // Mark item as read in the source system (bidirectional sync)
  // Returns: { success: boolean }
  async markRead(sourceId) {
    return { success: false, reason: "Not supported by this channel" };
  }

  // Process a real-time push event (PubSub, Socket Mode, etc.)
  // Returns: FeedItem or null
  async handlePush(rawData) {
    return null;
  }
}

// Normalized feed item schema
function createFeedItem({
  channel,
  from,
  fromEmail = null,
  subject = null,
  preview,
  timestamp,
  read = false,
  starred = false,
  deal = null,
  threadId = null,
  sourceId,
  replyable = true,
  labels = [],
  triage = null,
}) {
  return {
    id: `${channel}_${sourceId}`,
    channel,
    from,
    fromEmail,
    subject,
    preview: (preview || "").substring(0, 200),
    timestamp: new Date(timestamp).toISOString(),
    read,
    starred,
    deal,
    threadId,
    sourceId,
    replyable,
    labels,
    triage, // { action: "star"|"fyi"|"noise", deal, urgency }
  };
}

module.exports = { ChannelConnector, createFeedItem };
