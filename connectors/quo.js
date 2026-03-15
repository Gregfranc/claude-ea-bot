// Quo (OpenPhone) channel connector
// Wraps existing tools/quo.js for SMS and call data

const { ChannelConnector, createFeedItem } = require("./base");

const QUO_BASE_URL = "https://api.openphone.com/v1";

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

// Contacts cache (shared with quo.js via its own cache file)
const fs = require("fs");
const path = require("path");
const CONTACTS_CACHE_PATH = path.join(__dirname, "../data/quo-contacts.json");

function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_CACHE_PATH, "utf-8")).contacts || {};
  } catch {
    return {};
  }
}

function resolvePhone(phone) {
  const contacts = loadContacts();
  return contacts[phone] || contacts[phone?.replace(/^\+1/, "")] || phone || "Unknown";
}

class QuoConnector extends ChannelConnector {
  constructor() {
    super("sms", "green-500", "phone");
    this.enabled = !!process.env.QUO_API_KEY;
  }

  async fetchRecent(since) {
    if (!this.enabled) return [];

    try {
      const convRes = await quoFetch("/conversations", {
        maxResults: 50,
        updatedAfter: new Date(since).toISOString(),
      });

      const items = [];
      for (const conv of convRes.data || []) {
        const participants = conv.participants || [];
        if (participants.length === 0) continue;

        const participantNames = participants.map(resolvePhone);
        const participantLabel = participantNames.join(", ");

        // Get latest messages
        try {
          const msgsRes = await quoFetch("/messages", {
            phoneNumberId: conv.phoneNumberId,
            participants,
            maxResults: 5,
            createdAfter: new Date(since).toISOString(),
          });

          const messages = (msgsRes.data || []).filter(
            (m) => m.text && m.text.trim().length > 0
          );

          if (messages.length > 0) {
            const latest = messages[messages.length - 1];
            const sender =
              latest.direction === "outgoing" ? "Greg" : resolvePhone(latest.from);

            items.push(
              createFeedItem({
                channel: "sms",
                from: participantLabel,
                subject: `SMS (${messages.length} msgs)`,
                preview: `${sender}: ${latest.text}`,
                timestamp: latest.createdAt,
                read: false,
                sourceId: conv.id,
                threadId: conv.id,
                replyable: true,
              })
            );
          }
        } catch {
          continue;
        }

        // Get recent calls
        try {
          const callsRes = await quoFetch("/calls", {
            phoneNumberId: conv.phoneNumberId,
            participants,
            createdAfter: new Date(since).toISOString(),
            maxResults: 5,
          });

          for (const call of callsRes.data || []) {
            if (!["completed", "answered"].includes(call.status)) continue;
            if ((call.duration || 0) < 10) continue;

            const durationMin = Math.round((call.duration || 0) / 60);
            items.push(
              createFeedItem({
                channel: "call",
                from: participantLabel,
                subject: `Call (${durationMin}min)`,
                preview: `Phone call with ${participantLabel}`,
                timestamp: call.createdAt,
                read: false,
                sourceId: call.id,
                replyable: false, // Can't reply to a call
              })
            );
          }
        } catch {
          continue;
        }
      }

      return items;
    } catch (err) {
      console.error("[Quo Connector] fetchRecent error:", err.message);
      return [];
    }
  }

  async getThread(sourceId) {
    if (!this.enabled) return { messages: [], metadata: {} };

    try {
      // sourceId is a conversation ID for SMS
      const convRes = await quoFetch(`/conversations/${sourceId}`);
      const conv = convRes.data;
      if (!conv) return { messages: [], metadata: {} };

      const msgsRes = await quoFetch("/messages", {
        phoneNumberId: conv.phoneNumberId,
        participants: conv.participants,
        maxResults: 50,
      });

      const messages = (msgsRes.data || [])
        .filter((m) => m.text)
        .map((m) => ({
          from: m.direction === "outgoing" ? "Greg" : resolvePhone(m.from),
          body: m.text,
          timestamp: m.createdAt,
        }));

      return { messages, metadata: { conversationId: sourceId } };
    } catch (err) {
      console.error("[Quo Connector] getThread error:", err.message);
      return { messages: [], metadata: {} };
    }
  }

  async sendReply(sourceId, body) {
    if (!this.enabled) return { success: false, error: "Quo not configured" };

    try {
      // Get the conversation to find phoneNumberId and participants
      const convRes = await quoFetch(`/conversations/${sourceId}`);
      const conv = convRes.data;
      if (!conv) return { success: false, error: "Conversation not found" };

      const apiKey = process.env.QUO_API_KEY;
      const res = await fetch(`${QUO_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phoneNumberId: conv.phoneNumberId,
          to: conv.participants,
          content: body,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return { success: false, error: `Quo send failed: ${res.status} ${text}` };
      }

      const data = await res.json();
      return { success: true, messageId: data.data?.id || "sent" };
    } catch (err) {
      console.error("[Quo Connector] sendReply error:", err.message);
      return { success: false, error: err.message };
    }
  }
}

module.exports = new QuoConnector();
