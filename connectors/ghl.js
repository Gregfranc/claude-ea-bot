// Go High Level CRM channel connector
// Wraps existing tools/ghl.js for CRM activity feed

const { ChannelConnector, createFeedItem } = require("./base");
const ghl = require("../tools/ghl");

class GHLConnector extends ChannelConnector {
  constructor() {
    super("crm", "orange-500", "briefcase");
    this.enabled = ghl.isConfigured();
  }

  async fetchRecent(since) {
    if (!this.enabled) return [];

    try {
      // GHL doesn't have a "recent activity" endpoint, so we search for
      // recently updated contacts and opportunities
      const sinceDate = new Date(since);
      const items = [];

      // Search for recent opportunities
      try {
        const opps = await ghl.searchOpportunities("", null);
        for (const opp of opps) {
          const lastActivity = new Date(opp.lastActivity || opp.dateAdded);
          if (lastActivity < sinceDate) continue;

          items.push(
            createFeedItem({
              channel: "crm",
              from: opp.name || "Unknown Deal",
              subject: `Deal: ${opp.status}`,
              preview: `${opp.name} | $${opp.value} | Status: ${opp.status}`,
              timestamp: opp.lastActivity || opp.dateAdded,
              read: false,
              starred: false,
              sourceId: opp.id,
              replyable: false, // CRM entries are read-only in the dashboard
            })
          );
        }
      } catch (oppErr) {
        console.error("[GHL Connector] Opportunity fetch error:", oppErr.message);
      }

      return items;
    } catch (err) {
      console.error("[GHL Connector] fetchRecent error:", err.message);
      return [];
    }
  }

  async getThread(sourceId) {
    if (!this.enabled) return { messages: [], metadata: {} };

    try {
      // Try to get notes for this contact/opportunity
      const notes = await ghl.getContactNotes(sourceId);
      const messages = notes.map((n) => ({
        from: "CRM Note",
        body: n.body,
        timestamp: n.dateAdded,
      }));

      return { messages, metadata: { contactId: sourceId } };
    } catch (err) {
      // sourceId might be an opportunity, not a contact
      try {
        const opp = await ghl.getOpportunity(sourceId);
        return {
          messages: [
            {
              from: opp.name,
              body: `Deal: ${opp.name}\nValue: $${opp.value}\nStatus: ${opp.status}\nSource: ${opp.source}`,
              timestamp: opp.dateAdded,
            },
          ],
          metadata: { opportunityId: sourceId },
        };
      } catch {
        return { messages: [], metadata: {} };
      }
    }
  }

  async sendReply(sourceId, body) {
    // GHL doesn't support sending from our API integration
    return {
      success: false,
      error: "Reply not supported for CRM. Open in Go High Level to respond.",
      ghlUrl: `https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/${sourceId}`,
    };
  }
}

module.exports = new GHLConnector();
