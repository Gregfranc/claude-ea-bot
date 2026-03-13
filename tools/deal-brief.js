// Deal Brief: compound tool that chains email + project files + pipeline + calendar + knowledge base
// Returns a comprehensive deal status update in one shot

const gmail = require("./gmail");
const calendar = require("./calendar");
const files = require("./files");
const pipeline = require("./pipeline");
let meetingNotes;
try {
  meetingNotes = require("./meeting-notes");
} catch {
  meetingNotes = null;
}
let rag;
try {
  rag = require("./rag");
} catch {
  rag = null;
}

let learningModule;
try {
  learningModule = require("./learning");
} catch {
  learningModule = null;
}

// Map deal names to search terms (addresses, people, APNs)
// Falls back to deal name if no mapping found
function getDealSearchTerms(dealName) {
  const q = dealName.toLowerCase();

  // Load deal labels from triage profile for context
  let dealLabels = [];
  if (learningModule) {
    try {
      const profile = learningModule.loadProfile();
      dealLabels = profile.deal_labels || [];
    } catch {}
  }

  // Find matching deal label for additional context
  const matchedLabel = dealLabels.find(
    (d) =>
      d.deal.toLowerCase().includes(q) ||
      d.label.toLowerCase().includes(q) ||
      q.includes(d.deal.split(" - ")[0].toLowerCase())
  );

  // Extract keywords from deal label context
  const contextKeywords = matchedLabel
    ? matchedLabel.context.split(/[.,]/).map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    dealName,
    label: matchedLabel ? matchedLabel.label : null,
    context: matchedLabel ? matchedLabel.context : "",
    contextKeywords,
  };
}

// Find the project directory for a deal
function guessProjectDir(dealName) {
  const q = dealName.toLowerCase();
  const mappings = {
    cumley: "la-pine-or",
    forest: "la-pine-or",
    forrest: "la-pine-or",
    sims: "la-pine-or",
    sim: "la-pine-or",
    "la pine": "la-pine-or",
    traditions: "traditions-north",
    brio: "brio-vista",
    columbia: "columbia-view-estates",
    sage: "sage-creek",
    wasem: "wasem-lot-3",
    coffer: "tomi-coffe",
    tomi: "tomi-coffe",
    kitsap: "tomi-coffe",
    idaho: "idaho-county-154ac",
  };

  for (const [key, dir] of Object.entries(mappings)) {
    if (q.includes(key)) return dir;
  }
  // Try direct match on directory name
  return q.replace(/\s+/g, "-").toLowerCase();
}

// Build Gmail search queries for a deal
function buildEmailQueries(dealName) {
  const q = dealName.toLowerCase();
  const queries = [];

  // Always search by deal name
  queries.push(dealName);

  // Add address/location-specific queries
  if (q.includes("cumley")) {
    queries.push('"pannier ct" OR cumley');
  } else if (q.includes("forest") || q.includes("forrest")) {
    queries.push('"parkway dr" OR "dale forrest"');
  } else if (q.includes("sims") || q.includes("sim")) {
    queries.push('"doe ln" OR "doe lane" OR sims');
  } else if (q.includes("coffer") || q.includes("tomi") || q.includes("kitsap")) {
    queries.push("coffer OR kitsap OR tomi");
  } else if (q.includes("wasem")) {
    queries.push("wasem OR harmon");
  } else if (q.includes("sage")) {
    queries.push('"sage creek" OR midvale');
  } else if (q.includes("traditions")) {
    queries.push('"traditions north" OR dayton');
  } else if (q.includes("brio")) {
    queries.push('"brio vista"');
  }

  return queries;
}

// Build calendar search queries for a deal
function buildCalendarQueries(dealName) {
  const q = dealName.toLowerCase();
  const queries = [dealName];

  if (q.includes("coffer") || q.includes("tomi") || q.includes("kitsap")) {
    queries.push("kitsap");
    queries.push("tomi");
  } else if (q.includes("cumley") || q.includes("forest") || q.includes("sims")) {
    queries.push("la pine");
  } else if (q.includes("wasem")) {
    queries.push("wasem");
  } else if (q.includes("traditions")) {
    queries.push("traditions");
    queries.push("dayton");
  } else if (q.includes("brio")) {
    queries.push("brio");
    queries.push("hillside");
  }

  return queries;
}

/**
 * Full deal brief (owner version): email + project files + pipeline + calendar + meeting notes + RAG
 */
async function getDealBrief(dealName, daysBack = 7) {
  const sections = [];
  const errors = [];

  // Run all data sources in parallel
  const [pipelineResult, projectResult, emailResults, calendarResults, meetingResult, ragResult] =
    await Promise.allSettled([
      // 1. Pipeline sheet
      pipeline.lookupDeal(dealName),

      // 2. Project README
      (async () => {
        const dir = guessProjectDir(dealName);
        return await files.readProjectFile(`projects/${dir}/README.md`);
      })(),

      // 3. Gmail (last N days)
      (async () => {
        const queries = buildEmailQueries(dealName);
        const allEmails = [];
        const seen = new Set();
        for (const query of queries) {
          try {
            const result = await gmail.searchEmails(
              `${query} newer_than:${daysBack}d`,
              10
            );
            for (const email of result.results || []) {
              if (!seen.has(email.id)) {
                seen.add(email.id);
                allEmails.push(email);
              }
            }
          } catch (err) {
            errors.push(`Email search "${query}": ${err.message}`);
          }
        }
        // Sort by date descending
        allEmails.sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );
        return allEmails;
      })(),

      // 4. Calendar (next 30 days)
      (async () => {
        const queries = buildCalendarQueries(dealName);
        const allEvents = [];
        const seen = new Set();
        for (const query of queries) {
          try {
            const result = await calendar.listEvents(30);
            for (const event of result.events || []) {
              const summary = (event.summary || "").toLowerCase();
              const desc = (event.description || "").toLowerCase();
              if (
                (summary.includes(query.toLowerCase()) ||
                  desc.includes(query.toLowerCase())) &&
                !seen.has(event.id)
              ) {
                seen.add(event.id);
                allEvents.push(event);
              }
            }
          } catch (err) {
            errors.push(`Calendar search "${query}": ${err.message}`);
          }
        }
        return allEvents;
      })(),

      // 5. Meeting notes
      (async () => {
        if (!meetingNotes) return [];
        try {
          return await meetingNotes.searchMeetingNotes(dealName, true);
        } catch {
          return [];
        }
      })(),

      // 6. Knowledge base (RAG)
      (async () => {
        if (!rag) return null;
        try {
          return await rag.search(`${dealName} status update`, { deal: dealName }, 3);
        } catch {
          return null;
        }
      })(),
    ]);

  // --- Format pipeline ---
  if (pipelineResult.status === "fulfilled" && pipelineResult.value.found) {
    const d = pipelineResult.value.deal;
    const fields = Object.entries(d)
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    sections.push(`*Pipeline Sheet*\n${fields}`);
  } else if (pipelineResult.status === "fulfilled" && !pipelineResult.value.found) {
    sections.push(`*Pipeline Sheet*\n  ${pipelineResult.value.message}`);
  }

  // --- Format project file ---
  if (projectResult.status === "fulfilled" && projectResult.value.content) {
    // Truncate to key info
    const content = projectResult.value.content;
    const truncated =
      content.length > 2000 ? content.substring(0, 2000) + "..." : content;
    sections.push(`*Project File*\n${truncated}`);
  }

  // --- Format emails ---
  if (emailResults.status === "fulfilled") {
    const emails = emailResults.value;
    if (emails.length > 0) {
      const emailLines = emails.slice(0, 10).map((e) => {
        const date = new Date(e.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const fromName = (e.from || "").split("<")[0].trim() || e.from;
        return `  ${date} | ${fromName} | ${e.subject}`;
      });
      sections.push(
        `*Recent Emails (${emails.length} in last ${daysBack}d)*\n${emailLines.join("\n")}`
      );
    } else {
      sections.push(`*Recent Emails*\n  No emails in last ${daysBack} days.`);
    }
  }

  // --- Format calendar ---
  if (calendarResults.status === "fulfilled") {
    const events = calendarResults.value;
    if (events.length > 0) {
      const eventLines = events.map((e) => {
        const start = new Date(e.start).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        return `  ${start} | ${e.summary}`;
      });
      sections.push(`*Upcoming Calendar*\n${eventLines.join("\n")}`);
    } else {
      sections.push("*Upcoming Calendar*\n  No related events in next 30 days.");
    }
  }

  // --- Format meeting notes ---
  if (meetingResult.status === "fulfilled") {
    const notes = meetingResult.value;
    if (Array.isArray(notes) && notes.length > 0) {
      const noteLines = notes.slice(0, 5).map((n) => {
        return `  ${n.date || "?"} | ${n.title || n.subject || "Untitled"}`;
      });
      sections.push(`*Meeting Notes*\n${noteLines.join("\n")}`);
    }
  }

  // --- Format RAG results ---
  if (ragResult.status === "fulfilled" && ragResult.value && ragResult.value.results) {
    const results = ragResult.value.results;
    if (results.length > 0) {
      const ragLines = results.slice(0, 3).map((r) => {
        const preview = (r.text || "").substring(0, 150).replace(/\n/g, " ");
        return `  ${r.source || "?"}: ${preview}...`;
      });
      sections.push(`*Knowledge Base*\n${ragLines.join("\n")}`);
    }
  }

  // --- Errors ---
  if (errors.length > 0) {
    sections.push(`_Errors: ${errors.join("; ")}_`);
  }

  const header = `*Deal Brief: ${dealName}*\n_Generated ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}_\n`;
  return header + "\n" + sections.join("\n\n");
}

/**
 * Team deal brief: project files + pipeline + meeting notes + knowledge base (NO email or calendar details)
 */
async function getTeamDealBrief(dealName) {
  const sections = [];

  const [pipelineResult, projectResult, meetingResult, ragResult] =
    await Promise.allSettled([
      pipeline.lookupDeal(dealName),

      (async () => {
        const dir = guessProjectDir(dealName);
        return await files.readProjectFile(`projects/${dir}/README.md`);
      })(),

      (async () => {
        if (!meetingNotes) return [];
        try {
          return await meetingNotes.searchMeetingNotes(dealName, false); // public only
        } catch {
          return [];
        }
      })(),

      (async () => {
        if (!rag) return null;
        try {
          return await rag.search(`${dealName} status`, { deal: dealName, teamOnly: true }, 3);
        } catch {
          return null;
        }
      })(),
    ]);

  // Pipeline
  if (pipelineResult.status === "fulfilled" && pipelineResult.value.found) {
    const d = pipelineResult.value.deal;
    const fields = Object.entries(d)
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    sections.push(`*Pipeline Sheet*\n${fields}`);
  } else if (pipelineResult.status === "fulfilled") {
    sections.push(`*Pipeline Sheet*\n  ${pipelineResult.value.message || "Not found."}`);
  }

  // Project file
  if (projectResult.status === "fulfilled" && projectResult.value.content) {
    const content = projectResult.value.content;
    const truncated =
      content.length > 2000 ? content.substring(0, 2000) + "..." : content;
    sections.push(`*Project File*\n${truncated}`);
  }

  // Meeting notes (public only)
  if (meetingResult.status === "fulfilled") {
    const notes = meetingResult.value;
    if (Array.isArray(notes) && notes.length > 0) {
      const noteLines = notes.slice(0, 5).map((n) => {
        return `  ${n.date || "?"} | ${n.title || n.subject || "Untitled"}`;
      });
      sections.push(`*Meeting Notes*\n${noteLines.join("\n")}`);
    }
  }

  // RAG
  if (ragResult.status === "fulfilled" && ragResult.value && ragResult.value.results) {
    const results = ragResult.value.results;
    if (results.length > 0) {
      const ragLines = results.slice(0, 3).map((r) => {
        const preview = (r.text || "").substring(0, 150).replace(/\n/g, " ");
        return `  ${r.source || "?"}: ${preview}...`;
      });
      sections.push(`*Knowledge Base*\n${ragLines.join("\n")}`);
    }
  }

  const header = `*Deal Brief: ${dealName}*\n_Generated ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}_\n`;
  return header + "\n" + sections.join("\n\n");
}

module.exports = { getDealBrief, getTeamDealBrief };
