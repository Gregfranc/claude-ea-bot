const Anthropic = require("@anthropic-ai/sdk");

let learningModule;
try {
  learningModule = require("./learning");
} catch {
  learningModule = null;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getDealLabels() {
  if (learningModule) {
    try {
      const profile = learningModule.loadProfile();
      return profile.deal_labels || [];
    } catch {}
  }
  return [];
}

function buildDealContext(dealLabels) {
  if (dealLabels.length === 0) return null;
  return dealLabels
    .map((d) => `- "${d.label}" = ${d.deal}: ${d.context}`)
    .join("\n");
}

// Combined triage: reads email and decides both action level AND deal label in one call
async function triageEmail(from, subject, snippet, body, threadIsReply) {
  const dealLabels = getDealLabels();
  const dealContext = dealLabels.length > 0 ? buildDealContext(dealLabels) : "No active deals configured.";

  const emailContent = [
    `From: ${from}`,
    `Subject: ${subject}`,
    threadIsReply ? "This is part of an ongoing email thread (reply/forward)." : "This is a standalone email (not a reply).",
    snippet ? `Preview: ${snippet}` : "",
    body ? `Body:\n${body.substring(0, 2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `You triage emails for Greg Francis, CEO of GF Development LLC (land acquisition and entitlements).

Greg needs to see emails where:
- Someone is asking him a question or waiting for his response
- A deal update requires his attention or decision
- A team member (Rachel, Brian, Marwan) needs something from him
- There's a deadline, closing date, inspection, or time-sensitive item
- Someone important in his business network is reaching out directly
- A support conversation he initiated has a new response

Greg does NOT need to see:
- Newsletters, marketing emails, mass mailings (even from people he knows)
- Automated notifications (shipping, receipts, account alerts)
- Purely informational updates that need no response
- Social media notifications
- Cold outreach and sales pitches

ACTIVE DEALS:
${dealContext}

EMAIL:
${emailContent}

Respond with exactly two lines:
Line 1: "star" (Greg needs to act/respond), "fyi" (relevant but no action needed), or "noise" (junk/marketing/automated)
Line 2: The deal label (e.g. "CONTRACTED/sim") or "none" if it doesn't match any deal`,
        },
      ],
    });

    const result = (response.content[0].text || "").trim();
    const lines = result.split("\n").map((l) => l.trim());

    const action = lines[0] || "fyi";
    let deal = lines[1] || "none";

    // Validate action
    const validActions = ["star", "fyi", "noise"];
    const finalAction = validActions.includes(action.toLowerCase()) ? action.toLowerCase() : "fyi";

    // Validate deal label
    if (deal !== "none" && deal !== "\"none\"") {
      const cleaned = deal.replace(/^["']|["']$/g, "");
      const match = dealLabels.find((d) => d.label === cleaned);
      deal = match ? match.label : null;
    } else {
      deal = null;
    }

    return { action: finalAction, deal };
  } catch (err) {
    console.error("[Triage AI] Error:", err.message);
    return { action: "fyi", deal: null };
  }
}

// Legacy standalone deal classifier (kept for backwards compatibility)
async function classifyDeal(from, subject, snippet, body) {
  const result = await triageEmail(from, subject, snippet, body, false);
  return result.deal;
}

module.exports = { classifyDeal, getDealLabels, triageEmail };
