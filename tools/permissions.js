// Team configuration and permissions
// Three tiers: owner (Greg), team (Rachel, Brian, Marwan), public (anyone else)

const TEAM_CONFIG = {
  "U092AE1836K": {
    name: "Greg Francis",
    tier: "owner",
  },
  "U0A158D74JX": {
    name: "Rachel Rife",
    tier: "team",
  },
  "U09H9TZDQ3F": {
    name: "Brian Chaplin",
    tier: "team",
  },
  "U0934C901FB": {
    name: "Marwan Mousa",
    tier: "team",
  },
};

// Whitelisted Google Drive folder IDs for team access.
// Only files inside these folders (and their subfolders) are accessible to team members.
// Set TEAM_DRIVE_FOLDERS in .env as comma-separated folder IDs.
// To find a folder ID: open the folder in Google Drive, the ID is in the URL after /folders/
const TEAM_DRIVE_FOLDERS = (process.env.TEAM_DRIVE_FOLDERS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

function getUserTier(userId) {
  const user = TEAM_CONFIG[userId];
  if (!user) return "public";
  return user.tier;
}

function getUserConfig(userId) {
  return TEAM_CONFIG[userId] || null;
}

function getUserName(userId) {
  const user = TEAM_CONFIG[userId];
  return user ? user.name : "Unknown";
}

function getTeamDriveFolders() {
  return TEAM_DRIVE_FOLDERS;
}

function isTeamOrAbove(userId) {
  const tier = getUserTier(userId);
  return tier === "owner" || tier === "team";
}

function isOwner(userId) {
  return getUserTier(userId) === "owner";
}

module.exports = {
  TEAM_CONFIG,
  getUserTier,
  getUserConfig,
  getUserName,
  getTeamDriveFolders,
  isTeamOrAbove,
  isOwner,
};
