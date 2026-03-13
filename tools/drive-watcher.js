// Drive Folder Watcher: polls deal status folders in Google Drive,
// detects when deal folders move between statuses, cascades updates
// to triage labels, project files, and Slack notifications.

const fs = require("fs");
const path = require("path");
const drive = require("./drive");
const files = require("./files");

let learningModule;
try {
  learningModule = require("./learning");
} catch {
  learningModule = null;
}

// --- Status folder IDs (Google Drive) ---
const STATUS_FOLDERS = {
  "In Contract": "13UmS7zfC6TAI7w0WLfq3fHsVmWlNU1_5",
  "Closed": "1qMHr28GJVP4R2Xuo1FDk7iMRwlkS5lWD",
  "Lost": "1Gex4meBRkxRwK3NJlOgGLpg6_cT2wFTn",
  "Negotiating": "1iOJYH3_WkV6_cBZ1CMLPwol8aGSNlZtg",
};

// Gmail label prefix per status
const LABEL_PREFIX = {
  "In Contract": "CONTRACTED/",
  "Negotiating": "Negotiating Deals/",
  "Closed": "CLOSED/",
  "Lost": "LOST/",
};

const STATE_FILE = path.join(__dirname, "../data/drive-watcher-state.json");

// --- State persistence ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastScan: null, dealLocations: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Scan all status folders ---
async function scanAllFolders() {
  const results = {};

  for (const [status, folderId] of Object.entries(STATUS_FOLDERS)) {
    try {
      const listing = await drive.listFolder(folderId, 100);
      const folders = (listing.files || listing || []).filter(
        (f) => f.mimeType === "application/vnd.google-apps.folder"
      );
      for (const folder of folders) {
        results[folder.id] = {
          name: folder.name,
          status,
          parentId: folderId,
        };
      }
    } catch (err) {
      console.error(`[DriveWatcher] Error scanning ${status} folder:`, err.message);
    }
  }

  return results;
}

// --- Detect changes between old and new state ---
function detectChanges(oldLocations, newLocations) {
  const changes = [];

  for (const [folderId, newInfo] of Object.entries(newLocations)) {
    const oldInfo = oldLocations[folderId];

    if (!oldInfo) {
      // New folder detected (first time seeing it)
      changes.push({
        type: "new",
        folderId,
        name: newInfo.name,
        toStatus: newInfo.status,
        fromStatus: null,
      });
    } else if (oldInfo.status !== newInfo.status) {
      // Folder moved between status folders
      changes.push({
        type: "moved",
        folderId,
        name: newInfo.name,
        fromStatus: oldInfo.status,
        toStatus: newInfo.status,
      });
    }
  }

  // Check for folders that disappeared (deleted or moved outside tracked folders)
  for (const [folderId, oldInfo] of Object.entries(oldLocations)) {
    if (!newLocations[folderId]) {
      changes.push({
        type: "removed",
        folderId,
        name: oldInfo.name,
        fromStatus: oldInfo.status,
        toStatus: null,
      });
    }
  }

  return changes;
}

// --- Cascade: add triage label for deal ---
function addTriageLabel(dealName, status) {
  if (!learningModule) return false;

  try {
    const profile = learningModule.loadProfile();
    const prefix = LABEL_PREFIX[status];
    if (!prefix) return false;

    const label = prefix + dealName;

    // Check if label already exists
    const existing = (profile.deal_labels || []).find(
      (d) => d.label === label || d.deal.toLowerCase() === dealName.toLowerCase()
    );
    if (existing) return false;

    // Add new deal label
    if (!profile.deal_labels) profile.deal_labels = [];
    profile.deal_labels.push({
      label,
      deal: dealName,
      context: `Auto-detected from Drive folder. Status: ${status}.`,
    });

    learningModule.saveProfile(profile);
    return true;
  } catch (err) {
    console.error(`[DriveWatcher] Error adding triage label for ${dealName}:`, err.message);
    return false;
  }
}

// --- Cascade: update triage label prefix when status changes ---
function updateTriageLabelPrefix(dealName, fromStatus, toStatus) {
  if (!learningModule) return false;

  try {
    const profile = learningModule.loadProfile();
    const oldPrefix = LABEL_PREFIX[fromStatus];
    const newPrefix = LABEL_PREFIX[toStatus];
    if (!oldPrefix || !newPrefix) return false;

    const dealLabels = profile.deal_labels || [];
    const idx = dealLabels.findIndex(
      (d) => d.label.startsWith(oldPrefix) && d.deal.toLowerCase().includes(dealName.toLowerCase())
    );

    if (idx === -1) return false;

    // Update label prefix
    const oldLabel = dealLabels[idx].label;
    const dealPart = oldLabel.replace(oldPrefix, "");
    dealLabels[idx].label = newPrefix + dealPart;
    dealLabels[idx].context = (dealLabels[idx].context || "") + ` Moved to ${toStatus}.`;

    learningModule.saveProfile(profile);
    return true;
  } catch (err) {
    console.error(`[DriveWatcher] Error updating label for ${dealName}:`, err.message);
    return false;
  }
}

// --- Cascade: create project README for new deal ---
async function createProjectReadme(dealName) {
  const dirName = dealName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const filePath = `projects/${dirName}/README.md`;

  // Check if already exists
  const existing = await files.readProjectFile(filePath);
  if (!existing.error) return { created: false, reason: "already exists", path: filePath };

  const today = new Date().toISOString().split("T")[0];
  const content = `# ${dealName}

**Status:** In Contract
**Created:** ${today}
**Source:** Auto-detected from Google Drive folder

## Key Dates
- Contract date: TBD
- Close date: TBD

## Deal Summary
_Details pending. Update this file with deal specifics._

## Contacts
_Add key contacts here._

## Activity Log (Auto-Updated)
`;

  try {
    await files.writeProjectFile(filePath, content);
    return { created: true, path: filePath, dirName };
  } catch (err) {
    return { created: false, reason: err.message };
  }
}

// --- Main watcher run ---
async function runWatcher(sendDM, logFn = console.log) {
  logFn("[DriveWatcher] Scanning status folders...");

  const oldState = loadState();
  const newLocations = await scanAllFolders();

  const dealCount = Object.keys(newLocations).length;
  logFn(`[DriveWatcher] Found ${dealCount} deal folders across ${Object.keys(STATUS_FOLDERS).length} status folders.`);

  // First run: just save state, no notifications
  if (!oldState.lastScan) {
    logFn("[DriveWatcher] First run. Saving baseline state.");
    saveState({
      lastScan: new Date().toISOString(),
      dealLocations: newLocations,
    });
    return {
      firstRun: true,
      dealsFound: dealCount,
      changes: [],
    };
  }

  const changes = detectChanges(oldState.dealLocations, newLocations);

  if (changes.length === 0) {
    logFn("[DriveWatcher] No changes detected.");
    saveState({
      lastScan: new Date().toISOString(),
      dealLocations: newLocations,
    });
    return { changes: [], dealsFound: dealCount };
  }

  logFn(`[DriveWatcher] ${changes.length} change(s) detected.`);

  const notifications = [];

  for (const change of changes) {
    logFn(`[DriveWatcher] ${change.type}: "${change.name}" ${change.fromStatus || "new"} → ${change.toStatus || "removed"}`);

    if (change.type === "moved") {
      // Deal moved between status folders
      const updated = updateTriageLabelPrefix(change.name, change.fromStatus, change.toStatus);
      logFn(`[DriveWatcher] Triage label updated: ${updated}`);

      // Create project README if moved to In Contract and doesn't exist
      if (change.toStatus === "In Contract") {
        const readme = await createProjectReadme(change.name);
        if (readme.created) {
          logFn(`[DriveWatcher] Created project README: ${readme.path}`);
        }
      }

      notifications.push(
        `*Deal Status Change:* "${change.name}" moved from *${change.fromStatus}* to *${change.toStatus}*`
      );
    } else if (change.type === "new") {
      // New folder detected
      const labelAdded = addTriageLabel(change.name, change.toStatus);
      if (labelAdded) {
        logFn(`[DriveWatcher] Added triage label for "${change.name}"`);
      }

      // Create project README for new In Contract or Negotiating deals
      if (change.toStatus === "In Contract" || change.toStatus === "Negotiating") {
        const readme = await createProjectReadme(change.name);
        if (readme.created) {
          logFn(`[DriveWatcher] Created project README: ${readme.path}`);
        }
      }

      notifications.push(
        `*New Deal Detected:* "${change.name}" found in *${change.toStatus}*`
      );
    } else if (change.type === "removed") {
      notifications.push(
        `*Deal Folder Removed:* "${change.name}" no longer in *${change.fromStatus}* (moved outside tracked folders or deleted)`
      );
    }
  }

  // Send consolidated DM to Greg
  if (sendDM && notifications.length > 0) {
    const header = `*Drive Folder Watcher* (${new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CST)\n`;
    const msg = header + notifications.join("\n") + "\n\n_Triage labels and project files updated automatically. Review pipeline sheet manually._";
    try {
      await sendDM(msg);
    } catch (err) {
      logFn(`[DriveWatcher] Failed to send DM: ${err.message}`);
    }
  }

  // Save new state
  saveState({
    lastScan: new Date().toISOString(),
    dealLocations: newLocations,
  });

  return {
    changes,
    notifications,
    dealsFound: dealCount,
  };
}

// --- Get current snapshot (for on-demand status check) ---
function getSnapshot() {
  const state = loadState();
  if (!state.lastScan) return { error: "No scan data yet. Watcher hasn't run." };

  const byStatus = {};
  for (const [, info] of Object.entries(state.dealLocations)) {
    if (!byStatus[info.status]) byStatus[info.status] = [];
    byStatus[info.status].push(info.name);
  }

  return {
    lastScan: state.lastScan,
    byStatus,
    totalDeals: Object.keys(state.dealLocations).length,
  };
}

module.exports = { runWatcher, getSnapshot, scanAllFolders, STATUS_FOLDERS };
