const fs = require("fs");
const path = require("path");

function getGmail() {
  return require("./gmail");
}

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILE_PATH = path.join(DATA_DIR, "triage-profile.json");
const CORRECTIONS_PATH = path.join(DATA_DIR, "triage-corrections.json");

const RESOLVED_PATH = path.join(DATA_DIR, "triage-resolved.json");
const PROMOTION_THRESHOLD = 3;

// Core contacts that should never be demoted to noise
const PROTECTED_SENDERS = [
  "rachel", "brian chaplin", "jarred", "corbell", "marwan",
  "gfdevllc.com", "lapineoregon.gov", "idwr.idaho.gov",
];

const DEFAULT_PROFILE = {
  tier1_senders: [
    "rachel", "brian chaplin", "jarred", "corbell",
    "matt weston", "boiseinfill",
    "erik frechette", "lennar", "dustin barker", "teague haley",
    "chris duff", "seriousland",
    "mark krueger", "landadvisors",
    "dan birchfield", "akaal", "pinondg",
    "james kirkebo", "apexengineering",
    "brian bellairs", "bellairs-gorman",
    "rosann garza", "highdesertrealty",
    "lisa tavares", "lapinerealty",
    "chris snapp", "snappco",
    "kara keeton",
    "emma channpraseut", "idwr.idaho.gov",
    "ashley ivans", "lapineoregon.gov",
    "ben dejean",
    "hunter thompson", "raisingcapital",
    "tim lynch", "timlynchhomes",
    "heidy barnett", "westforkenv",
    "holly cole", "buysellcor",
    "spencer cox", "landai.ai",
    "marwan", "gfdevllc.com",
  ],
  tier1_subjects: [
    "traditions", "brio vista", "la pine", "sims", "cumley", "forest",
    "burnham ridge", "sand hallow", "roberts", "sage creek", "wasem",
    "columbia view", "doe lane", "cagle",
    "loi", "contract", "escrow", "closing", "contingency", "inspection",
    "entitlement", "zoning", "plat", "easement", "utility", "water right",
    "purchase agreement", "boldsign", "signed",
  ],
  noise_senders: [
    "ultramobile", "docusign@mail", "noreply@uber", "no-reply@zoom",
    "incident.io", "noreply@google", "mailer-daemon",
    "drchrono", "notta.zendesk", "linkedin.com",
    "wellsfargo", "notifications-noreply", "columbian-email",
    "cryptoaaron",
  ],
  noise_subjects: [
    "delivery status", "codex unresponsive", "deep research",
    "epaper", "receipt", "coverage in your area", "online access agreement",
    "celsius", "ultra-reliable",
  ],
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadResolved() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(RESOLVED_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveResolved(resolved) {
  ensureDataDir();
  fs.writeFileSync(RESOLVED_PATH, JSON.stringify(resolved, null, 2));
}

function applyTriageCorrection(senderPattern, action) {
  const profile = loadProfile();
  const lower = senderPattern.toLowerCase().trim();

  if (action === "noise") {
    const alreadyNoise = profile.noise_senders.some(
      (s) => lower.includes(s) || s.includes(lower)
    );
    if (!alreadyNoise) {
      profile.noise_senders.push(lower);
    }
    const tier1Idx = profile.tier1_senders.findIndex(
      (s) => lower.includes(s) || s.includes(lower)
    );
    if (tier1Idx !== -1) {
      profile.tier1_senders.splice(tier1Idx, 1);
    }
  } else if (action === "star") {
    const alreadyTier1 = profile.tier1_senders.some(
      (s) => lower.includes(s) || s.includes(lower)
    );
    if (!alreadyTier1) {
      profile.tier1_senders.push(lower);
    }
    const noiseIdx = profile.noise_senders.findIndex(
      (s) => lower.includes(s) || s.includes(lower)
    );
    if (noiseIdx !== -1) {
      profile.noise_senders.splice(noiseIdx, 1);
    }
  }

  saveProfile(profile);

  // Mark as resolved so confused detection skips this sender
  const resolved = loadResolved();
  resolved[lower] = { action, timestamp: new Date().toISOString() };
  saveResolved(resolved);

  // Audit trail
  saveCorrection({
    timestamp: new Date().toISOString(),
    messageId: null,
    from: senderPattern,
    subject: null,
    old_category: "confused",
    new_category: action === "noise" ? "EA/Noise" : "EA/Action",
    signal: "slack_correction",
    sender_pattern: lower,
  });

  return {
    success: true,
    sender: lower,
    action,
    message: `"${lower}" is now ${action === "noise" ? "noise (will auto-archive)" : "starred (will flag as important)"}. Triage profile updated.`,
  };
}

function loadProfile() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(PROFILE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    const profile = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
    return profile;
  }
}

function saveProfile(profile) {
  ensureDataDir();
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
}

function loadCorrections() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(CORRECTIONS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    fs.writeFileSync(CORRECTIONS_PATH, "[]");
    return [];
  }
}

function saveCorrection(correction) {
  const corrections = loadCorrections();
  corrections.push(correction);
  fs.writeFileSync(CORRECTIONS_PATH, JSON.stringify(corrections, null, 2));
  return corrections;
}

function extractSenderPattern(from) {
  const lower = (from || "").toLowerCase();
  const emailMatch = lower.match(/<([^>]+)>/);
  if (emailMatch) {
    const email = emailMatch[1];
    const domain = email.split("@")[1];
    const name = lower.replace(/<[^>]+>/, "").trim();
    if (name && name.length > 2) return name;
    return domain;
  }
  return lower.trim();
}

function getEaCategory(labelIds, labelNameMap) {
  for (const id of labelIds || []) {
    const name = labelNameMap[id];
    if (name === "EA/Action" || name === "EA/FYI" || name === "EA/Noise") {
      return name;
    }
  }
  return null;
}

async function learnFromGreg() {
  const gmail = getGmail();
  const results = { corrections: 0, profile_updates: 0, details: [] };

  try {
    const allLabels = await gmail.listLabels();
    const labelNameMap = {};
    const labelIdMap = {};
    for (const l of allLabels) {
      labelNameMap[l.id] = l.name;
      labelIdMap[l.name] = l.id;
    }

    const profile = loadProfile();
    let profileChanged = false;

    // SIGNAL 1: Starred emails = Greg thinks these are important
    // Only look at starred emails that DON'T have EA/Triaged label
    // (EA/Triaged means the bot starred it, not Greg)
    const starredEmails = await gmail.getRecentStarredAndImportant(2);
    const existingCorrectionsForStarred = loadCorrections();

    for (const email of (starredEmails || [])) {
      // Skip if bot already triaged this (bot-starred, not Greg-starred)
      const hasTriaged = (email.labelIds || []).some(
        (id) => labelNameMap[id] === "EA/Triaged"
      );
      if (hasTriaged) continue;

      const eaCategory = getEaCategory(email.labelIds, labelNameMap);
      if (eaCategory === "EA/Action") continue;

      const senderPattern = extractSenderPattern(email.from);
      if (!senderPattern || senderPattern.length < 2) continue;

      const alreadyTier1 = profile.tier1_senders.some(
        (s) => senderPattern.includes(s) || s.includes(senderPattern)
      );
      if (alreadyTier1) continue;

      // Deduplicate: skip if this messageId already logged as starred
      const alreadyLogged = existingCorrectionsForStarred.some(
        (c) => c.messageId === email.id && c.signal === "starred"
      );
      if (alreadyLogged) continue;

      const oldCategory = eaCategory || "unlabeled";
      saveCorrection({
        timestamp: new Date().toISOString(),
        messageId: email.id,
        from: email.from,
        subject: email.subject,
        old_category: oldCategory,
        new_category: "EA/Action",
        signal: "starred",
        sender_pattern: senderPattern,
      });
      results.corrections++;
      results.details.push({ from: email.from, subject: email.subject, old_category: oldCategory, sender_pattern: senderPattern });
    }

    // SIGNAL 2: Relabel detection - check if Greg removed EA/Noise from previously noise-labeled emails
    const existingCorrections = loadCorrections();
    const noiseMessageIds = existingCorrections
      .filter((c) => c.new_category === "EA/Noise" && c.signal === "manual_noise_label")
      .map((c) => c.messageId);
    const uniqueNoiseIds = [...new Set(noiseMessageIds)];

    if (uniqueNoiseIds.length > 0) {
      const gmailClient = gmail.getGmail();
      const allLabelsForCheck = await gmail.listLabels();
      const noiseLabelId = allLabelsForCheck.find((l) => l.name === "EA/Noise")?.id;

      if (noiseLabelId) {
        for (const msgId of uniqueNoiseIds.slice(0, 20)) {
          try {
            const msg = await gmailClient.users.messages.get({
              userId: "me",
              id: msgId,
              format: "minimal",
            });
            const currentLabels = msg.data.labelIds || [];
            if (!currentLabels.includes(noiseLabelId)) {
              const alreadyReversed = existingCorrections.some(
                (c) => c.messageId === msgId && c.signal === "relabel_from_noise"
              );
              if (alreadyReversed) continue;

              const noiseCorrection = existingCorrections.find(
                (c) => c.messageId === msgId && c.new_category === "EA/Noise"
              );
              if (noiseCorrection) {
                saveCorrection({
                  timestamp: new Date().toISOString(),
                  messageId: msgId,
                  from: noiseCorrection.from,
                  subject: noiseCorrection.subject,
                  old_category: "EA/Noise",
                  new_category: "EA/Action",
                  signal: "relabel_from_noise",
                  sender_pattern: noiseCorrection.sender_pattern,
                });
                results.corrections++;
                console.log(`[Learning] Greg relabeled from noise: ${noiseCorrection.from}`);
              }
            }
          } catch (err) {
            // Message may have been deleted, skip
          }
        }
      }
    }

    // SIGNAL 3: Emails Greg manually labeled EA/Noise = explicit demotion
    const noiseLabel = labelIdMap["EA/Noise"];
    if (noiseLabel) {
      const gmailClient = gmail.getGmail();
      try {
        const noiseRes = await gmailClient.users.messages.list({
          userId: "me",
          q: `label:EA-Noise newer_than:2h`,
          maxResults: 50,
        });

        for (const msg of (noiseRes.data.messages || [])) {
          const full = await gmailClient.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
          });

          const headers = full.data.payload.headers;
          const getHeader = (name) => {
            const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
            return h ? h.value : "";
          };
          const from = getHeader("From");
          const subject = getHeader("Subject");
          const senderPattern = extractSenderPattern(from);
          if (!senderPattern || senderPattern.length < 2) continue;

          // Check if we already logged this exact message as noise
          const existingCorrections = loadCorrections();
          const alreadyLogged = existingCorrections.some(
            (c) => c.messageId === msg.id && c.new_category === "EA/Noise"
          );
          if (alreadyLogged) continue;

          saveCorrection({
            timestamp: new Date().toISOString(),
            messageId: msg.id,
            from,
            subject,
            old_category: "manual",
            new_category: "EA/Noise",
            signal: "manual_noise_label",
            sender_pattern: senderPattern,
          });
          results.corrections++;
          results.details.push({ from, subject, sender_pattern: senderPattern, signal: "manual_noise" });
        }
      } catch (err) {
        console.error("[Learning] Error checking EA/Noise emails:", err.message);
      }
    }

    const corrections = loadCorrections();
    const promotionCounts = {};
    const demotionCounts = {};

    for (const c of corrections) {
      if (c.new_category === "EA/Action" && c.sender_pattern) {
        promotionCounts[c.sender_pattern] = (promotionCounts[c.sender_pattern] || 0) + 1;
      }
      if (c.new_category === "EA/Noise" && c.sender_pattern) {
        demotionCounts[c.sender_pattern] = (demotionCounts[c.sender_pattern] || 0) + 1;
      }
    }

    for (const [pattern, count] of Object.entries(promotionCounts)) {
      if (count >= PROMOTION_THRESHOLD) {
        const alreadyExists = profile.tier1_senders.some(
          (s) => pattern.includes(s) || s.includes(pattern)
        );
        if (!alreadyExists) {
          profile.tier1_senders.push(pattern);
          profileChanged = true;
          results.profile_updates++;
          console.log(`[Learning] Promoted sender to tier1: ${pattern} (${count} corrections)`);
        }

        const noiseIdx = profile.noise_senders.findIndex(
          (s) => pattern.includes(s) || s.includes(pattern)
        );
        if (noiseIdx !== -1) {
          profile.noise_senders.splice(noiseIdx, 1);
          profileChanged = true;
          console.log(`[Learning] Removed from noise: ${pattern}`);
        }
      }
    }

    for (const [pattern, count] of Object.entries(demotionCounts)) {
      if (count >= PROMOTION_THRESHOLD) {
        // Never demote protected senders (core team, government contacts)
        const isProtected = PROTECTED_SENDERS.some(
          (s) => pattern.includes(s) || s.includes(pattern)
        );
        if (isProtected) {
          console.log(`[Learning] Skipping demotion of protected sender: ${pattern}`);
          continue;
        }

        const alreadyNoise = profile.noise_senders.some(
          (s) => pattern.includes(s) || s.includes(pattern)
        );
        if (!alreadyNoise) {
          profile.noise_senders.push(pattern);
          profileChanged = true;
          results.profile_updates++;
          console.log(`[Learning] Demoted sender to noise: ${pattern} (${count} corrections)`);
        }

        const tier1Idx = profile.tier1_senders.findIndex(
          (s) => pattern.includes(s) || s.includes(pattern)
        );
        if (tier1Idx !== -1) {
          profile.tier1_senders.splice(tier1Idx, 1);
          profileChanged = true;
          console.log(`[Learning] Removed from tier1: ${pattern}`);
        }
      }
    }

    if (profileChanged) {
      saveProfile(profile);
    }

    // Detect confused senders: have both promotion and demotion signals
    // Skip senders Greg already resolved via Slack correction
    const resolved = loadResolved();
    results.confused = [];
    for (const pattern of Object.keys(promotionCounts)) {
      if (resolved[pattern]) continue; // Already answered, don't ask again
      if (demotionCounts[pattern] && demotionCounts[pattern] >= 2 && promotionCounts[pattern] >= 2) {
        results.confused.push({
          sender: pattern,
          starred_count: promotionCounts[pattern],
          noise_count: demotionCounts[pattern],
        });
      }
    }

    results.message = results.corrections > 0
      ? `Found ${results.corrections} corrections. ${results.profile_updates} profile rules updated.`
      : "No new corrections detected.";

    return results;
  } catch (err) {
    console.error("[Learning] Error:", err.message);
    return { ...results, error: err.message };
  }
}

module.exports = {
  learnFromGreg,
  loadProfile,
  saveCorrection,
  loadCorrections,
  saveProfile,
  extractSenderPattern,
  applyTriageCorrection,
};
