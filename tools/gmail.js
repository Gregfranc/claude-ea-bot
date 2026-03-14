const { google } = require("googleapis");
const path = require("path");

let learning;
try {
  learning = require("./learning");
} catch {
  learning = null;
}

let dealClassifier;
try {
  dealClassifier = require("./deal-classifier");
} catch {
  dealClassifier = null;
}

function getAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
}

function getAuthedClient() {
  const auth = getAuth();
  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return auth;
}

function getGmail() {
  return google.gmail({ version: "v1", auth: getAuthedClient() });
}

async function searchEmails(query, maxResults = 10) {
  const gmail = getGmail();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  if (!res.data.messages || res.data.messages.length === 0) {
    return { results: [], message: "No emails found matching that query." };
  }

  const emails = [];
  for (const msg of res.data.messages) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = full.data.payload.headers;
    const getHeader = (name) => {
      const h = headers.find(
        (h) => h.name.toLowerCase() === name.toLowerCase()
      );
      return h ? h.value : "";
    };

    emails.push({
      id: msg.id,
      threadId: full.data.threadId,
      from: getHeader("From"),
      to: getHeader("To"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      snippet: full.data.snippet,
    });
  }

  return { results: emails };
}

async function readEmail(messageId) {
  const gmail = getGmail();
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = res.data.payload.headers;
  const getHeader = (name) => {
    const h = headers.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    );
    return h ? h.value : "";
  };

  let body = "";
  const payload = res.data.payload;

  if (payload.body && payload.body.data) {
    body = Buffer.from(payload.body.data, "base64").toString("utf-8");
  } else if (payload.parts) {
    const textPart = payload.parts.find(
      (p) => p.mimeType === "text/plain" && p.body && p.body.data
    );
    if (textPart) {
      body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
    } else {
      const htmlPart = payload.parts.find(
        (p) => p.mimeType === "text/html" && p.body && p.body.data
      );
      if (htmlPart) {
        body = Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
        body = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  return {
    id: messageId,
    threadId: res.data.threadId,
    from: getHeader("From"),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    body: body.substring(0, 3000),
    labels: res.data.labelIds,
  };
}

async function createDraft(to, subject, body) {
  const gmail = getGmail();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw },
    },
  });

  return {
    draftId: res.data.id,
    message: `Draft created. Subject: "${subject}" To: ${to}`,
  };
}

async function sendEmail(to, subject, body) {
  const gmail = getGmail();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return {
    messageId: res.data.id,
    message: `Email sent. Subject: "${subject}" To: ${to}`,
  };
}

async function replyToEmail(messageId, body) {
  const gmail = getGmail();
  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Subject", "Message-ID", "References"],
  });

  const headers = original.data.payload.headers;
  const getHeader = (name) => {
    const h = headers.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    );
    return h ? h.value : "";
  };

  const from = getHeader("From");
  const subject = getHeader("Subject").startsWith("Re:")
    ? getHeader("Subject")
    : `Re: ${getHeader("Subject")}`;
  const messageIdHeader = getHeader("Message-ID");
  const references = getHeader("References");

  const raw = Buffer.from(
    `To: ${from}\r\nSubject: ${subject}\r\nIn-Reply-To: ${messageIdHeader}\r\nReferences: ${references} ${messageIdHeader}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: original.data.threadId,
    },
  });

  return {
    messageId: res.data.id,
    message: `Reply sent to ${from}. Subject: "${subject}"`,
  };
}

// --- Label Management ---

async function listLabels() {
  const gmail = getGmail();
  const res = await gmail.users.labels.list({ userId: "me" });
  return res.data.labels.map((l) => ({ id: l.id, name: l.name, type: l.type }));
}

async function createLabel(name) {
  const gmail = getGmail();
  const res = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return { id: res.data.id, name: res.data.name };
}

async function getOrCreateLabel(name) {
  const labels = await listLabels();
  const existing = labels.find((l) => l.name === name);
  if (existing) return existing;
  return await createLabel(name);
}

async function applyLabel(messageId, labelId) {
  const gmail = getGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
    },
  });
  return { success: true, messageId, labelId };
}

async function removeLabel(messageId, labelId) {
  const gmail = getGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: [labelId],
    },
  });
  return { success: true, messageId, labelId };
}

async function applyLabelByName(messageId, labelName) {
  const label = await getOrCreateLabel(labelName);
  return await applyLabel(messageId, label.id);
}

async function removeLabelByName(messageId, labelName) {
  const labels = await listLabels();
  const label = labels.find((l) => l.name === labelName);
  if (!label) return { error: `Label "${labelName}" not found` };
  return await removeLabel(messageId, label.id);
}

async function deleteLabelByName(labelName) {
  const gmail = getGmail();
  const labels = await listLabels();
  const label = labels.find((l) => l.name === labelName);
  if (!label) return { error: `Label "${labelName}" not found` };
  if (label.type === "system") return { error: `Cannot delete system label "${labelName}"` };
  await gmail.users.labels.delete({ userId: "me", id: label.id });
  return { success: true, message: `Deleted label "${labelName}"` };
}

// --- Auto Triage ---

function getActiveProfile() {
  if (learning) {
    try {
      return learning.loadProfile();
    } catch {
      return { noise_senders: [], noise_subjects: [] };
    }
  }
  return { noise_senders: [], noise_subjects: [] };
}

// Fast-path: detect obvious noise without AI
// Mixed senders bypass this check and always go to AI classification
function isObviousNoise(from, subject) {
  const profile = getActiveProfile();
  const fromLower = (from || "").toLowerCase();
  const subjectLower = (subject || "").toLowerCase();

  // Check if sender is mixed (sends both important and junk) - force AI path
  const mixedSenders = profile.mixed_senders || [];
  for (const m of mixedSenders) {
    if (fromLower.includes(m.sender)) return false;
  }

  for (const s of profile.noise_senders) {
    if (fromLower.includes(s)) return true;
  }
  for (const s of profile.noise_subjects) {
    if (subjectLower.includes(s)) return true;
  }
  return false;
}

// Fast-path: detect obvious newsletters without AI
// Checks for marketing email signatures: spacer chars, bulk sender patterns, standalone (not a reply)
function isObviousNewsletter(from, subject, snippet, isReply) {
  if (isReply) return false; // Replies are never newsletters
  const fromLower = (from || "").toLowerCase();
  const snippetStr = snippet || "";

  // Newsletter platform senders
  const newsletterPlatforms = [
    "beehiiv", "substack", "mail.superhuman", "mailchimp",
    "convertkit", "hubspot", "constantcontact", "sendinblue",
  ];
  for (const p of newsletterPlatforms) {
    if (fromLower.includes(p)) return true;
  }

  // Display name patterns like "Chris at Serious Land Capital" (name at company)
  const nameAtCompany = /^[^<]*\bat\b[^<]*</i;
  if (nameAtCompany.test(from || "")) {
    // Has spacer characters typical of HTML marketing emails
    if (snippetStr.includes("\u200C") || snippetStr.includes("\u00A0\u200C")) return true;
  }

  // Known newsletter display name patterns
  const newsletterNames = [
    "newsletter", "digest", "ben's bites", "natural 20",
    "dan martell", "morning brew",
  ];
  for (const n of newsletterNames) {
    if (fromLower.includes(n)) return true;
  }

  return false;
}

// Legacy classifier kept for module exports compatibility
function classifyEmail(from, subject, snippet) {
  if (isObviousNoise(from, subject)) return "EA/Noise";
  if (isObviousNewsletter(from, subject, snippet, false)) return "newsletter";
  return "needs_ai";
}

async function getRecentStarredAndImportant(hoursBack = 2) {
  const gmailClient = getGmail();
  const query = `newer_than:${hoursBack}h (is:starred OR is:important) -in:sent`;
  const res = await gmailClient.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  if (!res.data.messages || res.data.messages.length === 0) {
    return [];
  }

  const emails = [];
  for (const msg of res.data.messages) {
    const full = await gmailClient.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = full.data.payload.headers;
    const getHeader = (name) => {
      const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : "";
    };

    emails.push({
      id: msg.id,
      threadId: full.data.threadId,
      from: getHeader("From"),
      to: getHeader("To"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      snippet: full.data.snippet,
      labelIds: full.data.labelIds || [],
    });
  }

  return emails;
}

async function getEmailLabels(messageId) {
  const gmailClient = getGmail();
  const res = await gmailClient.users.messages.get({
    userId: "me",
    id: messageId,
    format: "minimal",
  });

  const allLabels = await listLabels();
  const labelNameMap = {};
  for (const l of allLabels) {
    labelNameMap[l.id] = l.name;
  }

  return (res.data.labelIds || []).map((id) => labelNameMap[id] || id);
}

function hasAttachments(payload) {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0 && payload.body && payload.body.attachmentId) {
    return true;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (hasAttachments(part)) return true;
    }
  }
  return false;
}

function extractBodyText(payload) {
  if (!payload) return "";
  if (payload.body && payload.body.data) {
    if (payload.mimeType === "text/plain") {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
    // Fallback to HTML stripped
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        const html = Buffer.from(part.body.data, "base64").toString("utf-8");
        return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    // Recurse into multipart
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }
  return "";
}

async function triageInbox(hoursBack = 6) {
  const gmailClient = getGmail();

  const newsletterLabel = await getOrCreateLabel("Newsletters");
  const noiseLabel = await getOrCreateLabel("EA/Noise");
  const triagedLabel = await getOrCreateLabel("EA/Triaged");
  const fileLabel = await getOrCreateLabel("file");
  const needsLabelLabel = await getOrCreateLabel("EA/Needs Label");
  const acctPaidLabel = await getOrCreateLabel("Accounting/Paid");
  const acctUnpaidLabel = await getOrCreateLabel("Accounting/Unpaid");
  const acctNeedsLabelLabel = await getOrCreateLabel("Accounting/Needs Label");

  // Pre-fetch all labels for deal label lookup
  const allLabels = await listLabels();
  const labelByName = {};
  for (const l of allLabels) {
    labelByName[l.name] = l.id;
  }

  const query = `newer_than:${hoursBack}h -label:EA-Triaged -in:sent -to:greg+task@gfdevllc.com -label:EA-Task`;
  const res = await gmailClient.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  if (!res.data.messages || res.data.messages.length === 0) {
    return { triaged: 0, starred: 0, newsletters: 0, noise: 0, fyi: 0, dealLabeled: 0, needsLabel: 0, acctPaid: 0, acctUnpaid: 0, acctNeedsLabel: 0, fileLabeled: 0, aiCalls: 0, details: [] };
  }

  const results = { starred: 0, newsletters: 0, noise: 0, fyi: 0, dealLabeled: 0, needsLabel: 0, acctPaid: 0, acctUnpaid: 0, acctNeedsLabel: 0, fileLabeled: 0, aiCalls: 0, details: [] };

  for (const msg of res.data.messages) {
    const full = await gmailClient.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const existingLabels = full.data.labelIds || [];

    // Skip if already triaged or already starred by Greg
    if (existingLabels.includes(triagedLabel.id)) continue;
    if (existingLabels.includes("STARRED")) continue;

    const headers = full.data.payload.headers;
    const getHeader = (name) => {
      const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : "";
    };

    const from = getHeader("From");
    const subject = getHeader("Subject");
    const snippet = full.data.snippet;
    const body = extractBodyText(full.data.payload).substring(0, 2000);
    const emailHasAttachments = hasAttachments(full.data.payload);
    const isReply = msg.threadId !== msg.id && (subject.startsWith("Re:") || subject.startsWith("Fwd:"));

    // Mark as triaged regardless of outcome
    const modifications = { addLabelIds: [triagedLabel.id], removeLabelIds: [] };

    let action = null;
    let dealLabel = null;
    let accounting = null;

    // --- Fast path: obvious noise (no AI needed) ---
    if (isObviousNoise(from, subject)) {
      action = "noise";
    }
    // --- Fast path: obvious newsletter (no AI needed) ---
    else if (isObviousNewsletter(from, subject, snippet, isReply)) {
      action = "newsletter";
    }
    // --- AI path: read the email and decide ---
    else if (dealClassifier) {
      try {
        const aiResult = await dealClassifier.triageEmail(from, subject, snippet, body, isReply);
        action = aiResult.action; // "star", "fyi", or "noise"
        dealLabel = aiResult.deal;
        accounting = aiResult.accounting;
        results.aiCalls++;
      } catch (err) {
        console.error(`[Triage] AI triage error for ${msg.id}:`, err.message);
        action = "fyi"; // Default to FYI on error
      }
    } else {
      action = "fyi";
    }

    // --- Apply actions ---
    if (action === "star") {
      modifications.addLabelIds.push("STARRED");
      results.starred++;
    } else if (action === "noise") {
      modifications.addLabelIds.push(noiseLabel.id);
      modifications.removeLabelIds.push("INBOX");
      results.noise++;
    } else if (action === "newsletter") {
      modifications.addLabelIds.push(newsletterLabel.id);
      results.newsletters++;
    } else {
      // fyi: leave in inbox, no star
      results.fyi++;
    }

    // Attachment detection
    if (emailHasAttachments) {
      modifications.addLabelIds.push(fileLabel.id);
      results.fileLabeled++;
    }

    // Apply deal label if AI found one
    if (dealLabel === "unknown") {
      modifications.addLabelIds.push(needsLabelLabel.id);
      results.needsLabel++;
    } else if (dealLabel) {
      let dealLabelId = labelByName[dealLabel];
      if (!dealLabelId) {
        const created = await getOrCreateLabel(dealLabel);
        dealLabelId = created.id;
        labelByName[dealLabel] = dealLabelId;
      }
      modifications.addLabelIds.push(dealLabelId);
      results.dealLabeled++;
    }

    // Apply accounting label if AI found one
    if (accounting === "paid") {
      modifications.addLabelIds.push(acctPaidLabel.id);
      results.acctPaid++;
    } else if (accounting === "unpaid") {
      modifications.addLabelIds.push(acctUnpaidLabel.id);
      results.acctUnpaid++;
    } else if (accounting === "unknown-accounting") {
      modifications.addLabelIds.push(acctNeedsLabelLabel.id);
      results.acctNeedsLabel++;
    }

    await gmailClient.users.messages.modify({
      userId: "me",
      id: msg.id,
      requestBody: modifications,
    });

    results.details.push({
      from,
      subject,
      category: action === "star" ? "EA/Action" : action === "noise" ? "EA/Noise" : action === "newsletter" ? "newsletter" : "FYI",
      dealLabel: dealLabel || "none",
      accounting: accounting || "none",
      hasAttachments: emailHasAttachments,
      usedAI: action !== "noise" && action !== "newsletter",
    });
  }

  results.triaged = res.data.messages.length;
  return results;
}

module.exports = {
  getGmail,
  searchEmails,
  readEmail,
  createDraft,
  sendEmail,
  replyToEmail,
  listLabels,
  createLabel,
  getOrCreateLabel,
  applyLabelByName,
  removeLabelByName,
  deleteLabelByName,
  removeLabel,
  triageInbox,
  classifyEmail,
  getRecentStarredAndImportant,
  getEmailLabels,
};
