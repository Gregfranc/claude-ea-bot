const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "subscriptions.json");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getAuthedClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

function getGmail() {
  return google.gmail({ version: "v1", auth: getAuthedClient() });
}

function getCalendar() {
  return google.calendar({ version: "v3", auth: getAuthedClient() });
}

function loadTracker() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return { subscriptions: [], last_scan: null, scan_queries: [] };
  }
}

function saveTracker(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// Parse email body text for subscription details using Haiku
async function extractSubscriptionDetails(from, subject, body, dateStr) {
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Extract subscription details from this email. Return ONLY valid JSON, no markdown.

From: ${from}
Subject: ${subject}
Date: ${dateStr}
Body (first 1500 chars): ${(body || "").substring(0, 1500)}

Return JSON:
{
  "is_subscription": true/false,
  "service_name": "string",
  "amount": "string with currency",
  "cycle": "monthly" or "annual" or "weekly" or "unknown",
  "renewal_date": "YYYY-MM-DD or null if not stated",
  "billing_period_end": "YYYY-MM-DD or null",
  "cancel_url": "URL if found in email, else null",
  "management_url": "URL to manage account if found, else null"
}

If this is not a subscription/renewal/receipt email, set is_subscription to false.`,
        },
      ],
    });

    const text = resp.content[0].text.trim();
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "");
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("[Subscriptions] AI extraction error:", err.message);
    return null;
  }
}

// Calculate next renewal date from last charge date and cycle
function calculateNextRenewal(lastCharged, cycle) {
  const d = new Date(lastCharged + "T00:00:00Z");
  if (cycle === "monthly") {
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else if (cycle === "annual") {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
  } else if (cycle === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    // Default: assume monthly
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().split("T")[0];
}

// Create a calendar reminder 3 days before renewal
async function createRenewalReminder(sub) {
  try {
    const calendar = getCalendar();
    const renewalDate = new Date(sub.next_renewal + "T00:00:00Z");
    const reminderDate = new Date(renewalDate);
    reminderDate.setUTCDate(reminderDate.getUTCDate() - 3);

    const reminderDateStr = reminderDate.toISOString().split("T")[0];
    const nextDay = new Date(reminderDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDayStr = nextDay.toISOString().split("T")[0];

    // Check if reminder already exists
    const existing = await calendar.events.list({
      calendarId: "primary",
      timeMin: reminderDate.toISOString(),
      timeMax: nextDay.toISOString(),
      q: sub.name,
      singleEvents: true,
    });

    if (existing.data.items && existing.data.items.length > 0) {
      const found = existing.data.items.find(
        (e) => e.summary && e.summary.includes(sub.name)
      );
      if (found) {
        console.log(`[Subscriptions] Reminder already exists for ${sub.name}`);
        return null;
      }
    }

    const prefix = sub.status === "cancel" ? "CANCEL" : "RENEWAL";
    const description = [
      `${sub.name} renews ${sub.next_renewal} for ${sub.amount}.`,
      "",
      sub.cancel_url ? `Cancel/manage: ${sub.cancel_url}` : "",
      sub.contact ? `Contact: ${sub.contact}` : "",
      sub.payment_method ? `Payment: ${sub.payment_method}` : "",
      sub.notes || "",
    ]
      .filter(Boolean)
      .join("\n");

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: `${prefix}: ${sub.name} renews in 3 days (${sub.amount}/${sub.cycle === "annual" ? "yr" : "mo"})`,
        description,
        start: { date: reminderDateStr },
        end: { date: nextDayStr },
        colorId: sub.status === "cancel" ? "11" : "6", // Red for cancel, tangerine for active
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 540 },
            { method: "email", minutes: 540 },
          ],
        },
      },
      sendUpdates: "none",
    });

    console.log(`[Subscriptions] Created reminder for ${sub.name} on ${reminderDateStr}`);
    return res.data;
  } catch (err) {
    console.error(`[Subscriptions] Calendar error for ${sub.name}:`, err.message);
    return null;
  }
}

// Scan Gmail for subscription emails and update tracker
async function scanSubscriptions() {
  const gmail = getGmail();
  const tracker = loadTracker();
  const results = { new: 0, updated: 0, reminders_created: 0, errors: 0 };

  const queries = [
    'subject:("your receipt" OR "subscription" OR "renewal" OR "auto-renewal" OR "payment received" OR "billing") newer_than:35d',
    "from:stripe.com subject:(receipt OR invoice) newer_than:35d",
    'from:apple.com subject:"receipt" newer_than:35d',
    "from:lemonsqueezy subject:(receipt OR order) newer_than:35d",
  ];

  const seenIds = new Set();
  const allMessages = [];

  for (const q of queries) {
    try {
      const res = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 30,
      });
      if (res.data.messages) {
        for (const m of res.data.messages) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            allMessages.push(m);
          }
        }
      }
    } catch (err) {
      console.error(`[Subscriptions] Query error: ${err.message}`);
      results.errors++;
    }
  }

  console.log(`[Subscriptions] Found ${allMessages.length} candidate emails to scan.`);

  // Process up to 20 emails per scan to limit API costs
  const toProcess = allMessages.slice(0, 20);

  for (const msg of toProcess) {
    try {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = full.data.payload.headers;
      const getHeader = (name) =>
        (headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

      const from = getHeader("From");
      const subject = getHeader("Subject");
      const dateStr = getHeader("Date");

      // Get body text
      let body = "";
      function extractText(payload) {
        if (payload.body && payload.body.data) {
          body += Buffer.from(payload.body.data, "base64").toString("utf8") + "\n";
        }
        if (payload.parts) {
          for (const part of payload.parts) {
            if (part.mimeType === "text/plain" && part.body && part.body.data) {
              body += Buffer.from(part.body.data, "base64").toString("utf8") + "\n";
            } else if (part.parts) {
              extractText(part);
            }
          }
        }
      }
      extractText(full.data.payload);

      // Skip if body is too short (probably not a subscription email)
      if (body.length < 50 && subject.length < 20) continue;

      // Check if this email matches a known subscription by sender pattern
      const fromLower = from.toLowerCase();
      const subjectLower = subject.toLowerCase();
      const existingSub = tracker.subscriptions.find((s) => {
        const pattern = (s.sender_pattern || "").toLowerCase();
        return pattern && (fromLower.includes(pattern) || subjectLower.includes(pattern));
      });

      if (existingSub) {
        // Update last_charged date if this is newer
        const emailDate = new Date(full.data.internalDate * 1);
        const emailDateStr = emailDate.toISOString().split("T")[0];

        if (!existingSub.last_charged || emailDateStr > existingSub.last_charged) {
          existingSub.last_charged = emailDateStr;
          existingSub.next_renewal = calculateNextRenewal(emailDateStr, existingSub.cycle);
          existingSub.reminder_created = false; // Reset so new reminder gets created
          results.updated++;
        }
        continue;
      }

      // New email: use AI to extract details
      const details = await extractSubscriptionDetails(from, subject, body, dateStr);
      if (!details || !details.is_subscription) continue;

      // Generate an ID from the service name
      const id = details.service_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      // Skip if we already track this service
      if (tracker.subscriptions.find((s) => s.id === id)) continue;

      const emailDate = new Date(full.data.internalDate * 1);
      const emailDateStr = emailDate.toISOString().split("T")[0];

      const newSub = {
        id,
        name: details.service_name,
        amount: details.amount || "unknown",
        cycle: details.cycle || "monthly",
        last_charged: emailDateStr,
        next_renewal:
          details.renewal_date ||
          details.billing_period_end ||
          calculateNextRenewal(emailDateStr, details.cycle || "monthly"),
        cancel_url:
          details.cancel_url || details.management_url || "check email or service website",
        contact: from,
        payment_method: "unknown",
        email_account: getHeader("To") || "unknown",
        sender_pattern: from
          .toLowerCase()
          .replace(/.*</, "")
          .replace(/>.*/, "")
          .split("@")[1] || "",
        status: "active",
        reminder_created: false,
        detected_from_email: subject,
      };

      tracker.subscriptions.push(newSub);
      results.new++;
      console.log(`[Subscriptions] New subscription detected: ${details.service_name}`);
    } catch (err) {
      console.error(`[Subscriptions] Processing error: ${err.message}`);
      results.errors++;
    }
  }

  // Create reminders for any subscriptions that need them
  for (const sub of tracker.subscriptions) {
    if (sub.reminder_created || sub.status === "canceling") continue;
    if (!sub.next_renewal) continue;

    const renewalDate = new Date(sub.next_renewal + "T00:00:00Z");
    const now = new Date();
    const daysUntil = Math.ceil((renewalDate - now) / (1000 * 60 * 60 * 24));

    // Only create reminders for renewals within the next 45 days
    if (daysUntil > 0 && daysUntil <= 45) {
      const reminder = await createRenewalReminder(sub);
      if (reminder) {
        sub.reminder_created = true;
        results.reminders_created++;
      }
    }
  }

  tracker.last_scan = new Date().toISOString();
  saveTracker(tracker);

  return results;
}

// Get upcoming renewals for Slack notification
function getUpcomingRenewals(daysAhead = 7) {
  const tracker = loadTracker();
  const now = new Date();
  const upcoming = [];

  for (const sub of tracker.subscriptions) {
    if (!sub.next_renewal || sub.status === "canceling") continue;

    const renewalDate = new Date(sub.next_renewal + "T00:00:00Z");
    const daysUntil = Math.ceil((renewalDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntil >= 0 && daysUntil <= daysAhead) {
      upcoming.push({
        ...sub,
        days_until: daysUntil,
      });
    }
  }

  // Sort by days until renewal
  upcoming.sort((a, b) => a.days_until - b.days_until);
  return upcoming;
}

// Format upcoming renewals as Slack message
function formatRenewalAlert(upcoming) {
  if (upcoming.length === 0) return null;

  let msg = "*Upcoming subscription renewals:*\n";

  for (const sub of upcoming) {
    const urgency = sub.days_until <= 3 ? "!!!" : "";
    const cancelTag = sub.status === "cancel" ? " [WANTS TO CANCEL]" : "";
    msg += `\n${urgency} *${sub.name}*${cancelTag} — ${sub.amount} (${sub.cycle})`;
    msg += `\n   Renews: ${sub.next_renewal} (${sub.days_until} days)`;
    msg += `\n   Cancel/manage: ${sub.cancel_url}\n`;
  }

  return msg;
}

// List all tracked subscriptions
function listSubscriptions() {
  const tracker = loadTracker();
  return tracker.subscriptions.map((s) => ({
    name: s.name,
    amount: s.amount,
    cycle: s.cycle,
    next_renewal: s.next_renewal,
    status: s.status,
    cancel_url: s.cancel_url,
  }));
}

// Mark a subscription for cancellation
function markForCancellation(nameOrId) {
  const tracker = loadTracker();
  const lower = nameOrId.toLowerCase();
  const sub = tracker.subscriptions.find(
    (s) => s.id === lower || s.name.toLowerCase().includes(lower)
  );
  if (!sub) return { error: `Subscription "${nameOrId}" not found` };
  sub.status = "cancel";
  sub.reminder_created = false; // Reset to create new red reminder
  saveTracker(tracker);
  return { name: sub.name, status: "cancel", next_renewal: sub.next_renewal };
}

// Mark a subscription as cancelled (remove from active tracking)
function markCancelled(nameOrId) {
  const tracker = loadTracker();
  const lower = nameOrId.toLowerCase();
  const sub = tracker.subscriptions.find(
    (s) => s.id === lower || s.name.toLowerCase().includes(lower)
  );
  if (!sub) return { error: `Subscription "${nameOrId}" not found` };
  sub.status = "cancelled";
  saveTracker(tracker);
  return { name: sub.name, status: "cancelled" };
}

module.exports = {
  scanSubscriptions,
  getUpcomingRenewals,
  formatRenewalAlert,
  listSubscriptions,
  markForCancellation,
  markCancelled,
  createRenewalReminder,
};
