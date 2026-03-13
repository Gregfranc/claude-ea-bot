// Daily Deal Digest: scans deal-labeled emails from last 24h,
// extracts key updates via Haiku, appends to project README timelines.
// Designed with pluggable data sources for future GHL/team email integration.

const Anthropic = require("@anthropic-ai/sdk");
const gmail = require("./gmail");
const files = require("./files");
const pipeline = require("./pipeline");

let learningModule;
try {
  learningModule = require("./learning");
} catch {
  learningModule = null;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Deal to project directory mapping ---
const DEAL_PROJECT_MAP = {
  "CONTRACTED/sim": "la-pine-or",
  "CONTRACTED/Cumley": "la-pine-or",
  "CONTRACTED/forest": "la-pine-or",
  "CONTRACTED/Deal/Traditions": "traditions-north",
  "CONTRACTED/Deal/BrioVista": "brio-vista",
  "CONTRACTED/Deal/ColumbiaViewEstates": "columbia-view-estates",
  "CONTRACTED/Deal/Sage Creek": "sage-creek",
  "CONTRACTED/Deal/Wasem Road": "wasem-lot-3",
  "CONTRACTED/Michael Roberts - Park Place": "roberts-park-place",
  "CONTRACTED/coffer": "tomi-coffe",
  "CONTRACTED/Fraser_Roy WA": "fraser-roy",
  "CONTRACTED/8802 S. Central Ave": "8802-s-central",
  "Negotiating Deals/burnham ridge": "burnham-ridge",
  "Negotiating Deals/Stavrianakis": "stavrianakis",
  "Negotiating Deals/Cloverdale - Little-Hevrin-fivecoats": "cloverdale",
  "CONTRACTED/Meadow Vista - Standridge": "meadow-vista",
  "CONTRACTED/Sale - Vancouver": "vancouver-sale",
};

// --- Data source interface ---
// Each source returns: { dealLabel, updates: [{ date, source, summary }] }
// Future sources (GHL, team email) plug in here.

/**
 * Source: Greg's Gmail (deal-labeled emails from last N hours)
 */
async function getEmailUpdates(dealLabel, hoursBack = 26) {
  // Search by deal label name in Gmail
  // Gmail label search uses the label name with / replaced by -
  const labelSearch = dealLabel.replace(/\//g, "-");
  const query = `label:${labelSearch} newer_than:${hoursBack}h -in:sent`;

  try {
    const result = await gmail.searchEmails(query, 15);
    if (!result.results || result.results.length === 0) return [];

    return result.results.map((e) => ({
      date: e.date,
      source: "email",
      from: (e.from || "").split("<")[0].trim(),
      subject: e.subject,
      snippet: e.snippet,
      id: e.id,
    }));
  } catch (err) {
    console.error(`[DealDigest] Email search failed for ${dealLabel}:`, err.message);
    return [];
  }
}

// Future: getGHLUpdates(dealName, hoursBack)
// Future: getTeamEmailUpdates(dealLabel, teamMember, hoursBack)

/**
 * Use Haiku to extract key facts from email activity
 */
async function extractUpdates(dealName, emails) {
  if (emails.length === 0) return null;

  const emailSummaries = emails
    .map(
      (e, i) =>
        `${i + 1}. ${e.date} | From: ${e.from} | Subject: ${e.subject}\n   ${e.snippet}`
    )
    .join("\n\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Extract key deal updates from these emails for "${dealName}". Focus on:
- Status changes (contract signed, listing live, inspection done, etc.)
- New dates or deadlines
- New contacts or team members introduced
- Action items or decisions made
- Problems or blockers

Emails:
${emailSummaries}

Respond with a bullet list of updates, each starting with the date in YYYY-MM-DD format. Only include genuinely new information. If there's nothing notable, respond with "NO_UPDATES".

Example format:
- 2026-03-13: Listing docs completed via DocuSign for Lot 19 and Lot 20
- 2026-03-12: Title company (First American, Sabrina Norton) introduced to team`,
        },
      ],
    });

    const result = (response.content[0].text || "").trim();
    if (result === "NO_UPDATES" || result.length < 10) return null;
    return result;
  } catch (err) {
    console.error(`[DealDigest] Haiku extraction failed for ${dealName}:`, err.message);
    return null;
  }
}

/**
 * Append extracted updates to the project README's Activity Log section
 */
async function appendToReadme(projectDir, updates, dealName) {
  const filePath = `projects/${projectDir}/README.md`;
  const existing = await files.readProjectFile(filePath);

  if (existing.error) {
    // Project dir doesn't exist yet, skip
    console.log(`[DealDigest] No README for ${projectDir}, skipping.`);
    return { skipped: true, reason: "no README" };
  }

  const content = existing.content;
  const today = new Date().toISOString().split("T")[0];
  const digestHeader = `\n## Activity Log (Auto-Updated)\n`;
  const newEntry = `\n### ${today}\n${updates}\n`;

  let updatedContent;
  if (content.includes("## Activity Log (Auto-Updated)")) {
    // Append new entry after the header
    updatedContent = content.replace(
      "## Activity Log (Auto-Updated)",
      `## Activity Log (Auto-Updated)\n\n### ${today}\n${updates}`
    );
  } else {
    // Add the section at the end
    updatedContent = content + digestHeader + newEntry;
  }

  // Don't write if nothing actually changed
  if (updatedContent === content) {
    return { skipped: true, reason: "no changes" };
  }

  const writeResult = await files.writeProjectFile(filePath, updatedContent);
  return { updated: true, path: filePath, ...writeResult };
}

/**
 * Run the full daily digest: scan all deals, extract updates, append to READMEs
 */
async function runDailyDigest(hoursBack = 26, logFn = console.log) {
  // Get deal labels from triage profile
  let dealLabels = [];
  if (learningModule) {
    try {
      const profile = learningModule.loadProfile();
      dealLabels = profile.deal_labels || [];
    } catch {}
  }

  if (dealLabels.length === 0) {
    logFn("[DealDigest] No deal labels configured. Skipping.");
    return { dealsProcessed: 0, dealsUpdated: 0, errors: [] };
  }

  // Deal lifecycle: only scan active statuses (In Contract + Negotiating)
  // Labels starting with "CONTRACTED/" = In Contract
  // Labels starting with "Negotiating Deals/" = Negotiating
  // Skip anything else (Closed, Lost, or unlabeled)
  const ACTIVE_PREFIXES = ["CONTRACTED/", "Negotiating Deals/"];

  const results = {
    dealsProcessed: 0,
    dealsUpdated: 0,
    dealsSkipped: 0,
    errors: [],
    details: [],
  };

  for (const dealConfig of dealLabels) {
    const { label, deal: dealName } = dealConfig;

    // Skip deals not in an active status
    const isActive = ACTIVE_PREFIXES.some((p) => label.startsWith(p));
    if (!isActive) {
      results.details.push({ deal: dealName, status: "inactive (skipped)" });
      continue;
    }

    const projectDir = DEAL_PROJECT_MAP[label];

    results.dealsProcessed++;

    try {
      // 1. Get emails for this deal from last N hours
      const emails = await getEmailUpdates(label, hoursBack);

      if (emails.length === 0) {
        results.dealsSkipped++;
        results.details.push({ deal: dealName, status: "no new emails" });
        continue;
      }

      logFn(`[DealDigest] ${dealName}: ${emails.length} emails found`);

      // 2. Extract key updates via Haiku
      const updates = await extractUpdates(dealName, emails);

      if (!updates) {
        results.dealsSkipped++;
        results.details.push({ deal: dealName, status: "no notable updates" });
        continue;
      }

      // 3. Append to project README
      if (projectDir) {
        const appendResult = await appendToReadme(projectDir, updates, dealName);
        if (appendResult.updated) {
          results.dealsUpdated++;
          results.details.push({ deal: dealName, status: "updated", project: projectDir });
          logFn(`[DealDigest] ${dealName}: README updated (${projectDir})`);
        } else {
          results.dealsSkipped++;
          results.details.push({ deal: dealName, status: appendResult.reason });
        }
      } else {
        // No project dir mapped. Log but don't create one.
        results.dealsSkipped++;
        results.details.push({
          deal: dealName,
          status: "no project dir mapped",
          updates,
        });
        logFn(`[DealDigest] ${dealName}: updates found but no project dir mapped for label "${label}"`);
      }
    } catch (err) {
      results.errors.push({ deal: dealName, error: err.message });
      logFn(`[DealDigest] ${dealName}: ERROR - ${err.message}`);
    }
  }

  logFn(
    `[DealDigest] Complete: ${results.dealsProcessed} deals scanned, ${results.dealsUpdated} updated, ${results.dealsSkipped} skipped, ${results.errors.length} errors`
  );

  return results;
}

module.exports = { runDailyDigest, getEmailUpdates, extractUpdates };
