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

function getTier1Senders() {
  if (learningModule) {
    try {
      const profile = learningModule.loadProfile();
      return profile.tier1_senders || [];
    } catch {}
  }
  return [];
}

function getMixedSenders() {
  if (learningModule) {
    try {
      const profile = learningModule.loadProfile();
      return profile.mixed_senders || [];
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
  const tier1Senders = getTier1Senders();
  const mixedSenders = getMixedSenders();
  const dealContext = dealLabels.length > 0 ? buildDealContext(dealLabels) : "No active deals configured.";
  const vipList = tier1Senders.length > 0 ? tier1Senders.join(", ") : "none configured";

  // Build mixed sender hints for this specific email
  const fromLower = (from || "").toLowerCase();
  let mixedHint = "";
  for (const m of mixedSenders) {
    if (fromLower.includes(m.sender)) {
      mixedHint = `\nMIXED SENDER RULES for "${m.sender}":\n- STAR if: ${m.star_if}\n- NOISE if: ${m.noise_if}\nApply these rules carefully to this specific email.\n`;
      break;
    }
  }

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

ALWAYS STAR if:
- The sender is from @gfdevllc.com (Greg's company: Rachel, Brian, Marwan)
- The sender matches any VIP name below (even partially in their email or display name)
- Someone is asking Greg a question or waiting for his response
- A deal update requires his attention or decision
- There's a deadline, closing date, inspection, or time-sensitive item
- Someone in his business network is reaching out directly (not mass email)
- A support conversation Greg initiated has a new response
- The email is part of an active deal thread (check deal list below)

When in doubt between "star" and "fyi", choose "star". Greg prefers false positives over missed emails.

Mark as "fyi" only if:
- Purely informational with no action needed AND not from a VIP sender

Mark as "noise" only if:
- Newsletters, marketing, mass mailings, automated notifications, social media, cold outreach, shipping/receipts

VIP SENDERS (star any email from these people/domains):
${vipList}

ACTIVE DEALS:
${dealContext}
${mixedHint}
EMAIL:
${emailContent}

Respond with exactly three lines:
Line 1: "star", "fyi", or "noise"
Line 2: The deal label (e.g. "CONTRACTED/sim"), "unknown" if the email seems deal/property-related but doesn't clearly match a deal above, or "none" if it's not deal-related at all.
Line 3: Accounting classification: "paid" (receipt, payment confirmation, billing statement for something already paid), "unpaid" (new invoice, bill due, payment request that needs action), "unknown-accounting" (looks financial but unclear if paid or unpaid), or "none" (not accounting-related).

IMPORTANT: Only use a deal label from the list above. If the email mentions a property, parcel, or deal that is NOT in the list, respond with "unknown" — do NOT guess or pick the closest match.`,
        },
      ],
    });

    const result = (response.content[0].text || "").trim();
    const lines = result.split("\n").map((l) => l.trim());

    const action = lines[0] || "fyi";
    let deal = lines[1] || "none";
    let accounting = (lines[2] || "none").replace(/^["']|["']$/g, "").trim().toLowerCase();

    // Validate action
    const validActions = ["star", "fyi", "noise"];
    const finalAction = validActions.includes(action.toLowerCase()) ? action.toLowerCase() : "fyi";

    // Validate deal label
    const cleanedDeal = deal.replace(/^["']|["']$/g, "").trim().toLowerCase();
    if (cleanedDeal === "none") {
      deal = null;
    } else if (cleanedDeal === "unknown") {
      deal = "unknown";
    } else {
      const match = dealLabels.find((d) => d.label === deal.replace(/^["']|["']$/g, ""));
      deal = match ? match.label : "unknown"; // unrecognized label = unknown
    }

    // Validate accounting classification
    const validAccounting = ["paid", "unpaid", "unknown-accounting", "none"];
    if (!validAccounting.includes(accounting)) accounting = "none";
    if (accounting === "none") accounting = null;

    return { action: finalAction, deal, accounting };
  } catch (err) {
    console.error("[Triage AI] Error:", err.message);
    return { action: "fyi", deal: null, accounting: null };
  }
}

// Legacy standalone deal classifier (kept for backwards compatibility)
async function classifyDeal(from, subject, snippet, body) {
  const result = await triageEmail(from, subject, snippet, body, false);
  return result.deal;
}

module.exports = { classifyDeal, getDealLabels, triageEmail };
