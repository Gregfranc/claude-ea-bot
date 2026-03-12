// Team-scoped Google Drive access
// Enforces folder whitelist so team members can only access shared project folders.

const drive = require("./drive");

// Cache of all folder IDs (including nested subfolders) under whitelisted folders
let folderCache = new Set();
let cacheBuiltAt = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function buildFolderCache(whitelistedFolderIds) {
  const newCache = new Set(whitelistedFolderIds);

  async function addSubfolders(parentId, depth = 0) {
    if (depth > 5) return; // max recursion depth
    try {
      const files = await drive.listFolder(parentId, 100);
      for (const file of files) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          newCache.add(file.id);
          await addSubfolders(file.id, depth + 1);
        }
      }
    } catch (err) {
      console.error(`[Drive-Team] Error scanning folder ${parentId}:`, err.message);
    }
  }

  for (const folderId of whitelistedFolderIds) {
    await addSubfolders(folderId);
  }

  folderCache = newCache;
  cacheBuiltAt = Date.now();
  console.log(`[Drive-Team] Folder cache built: ${newCache.size} folders indexed.`);
  return newCache;
}

async function ensureCache(whitelistedFolderIds) {
  if (!cacheBuiltAt || Date.now() - cacheBuiltAt > CACHE_TTL) {
    await buildFolderCache(whitelistedFolderIds);
  }
  return folderCache;
}

// Check if a file is inside a whitelisted folder tree
async function isFileInWhitelist(fileId, whitelistedFolderIds) {
  const cache = await ensureCache(whitelistedFolderIds);
  const driveClient = drive.getDrive();
  try {
    const res = await driveClient.files.get({
      fileId,
      fields: "parents",
    });
    const parents = res.data.parents || [];
    return parents.some((pid) => cache.has(pid));
  } catch {
    return false;
  }
}

// Team-scoped Drive search: only returns files inside whitelisted folders
async function teamSearchDrive(query, maxResults = 10, whitelistedFolderIds) {
  if (!whitelistedFolderIds || whitelistedFolderIds.length === 0) {
    return { error: "No shared Drive folders configured yet. Ask Greg to set TEAM_DRIVE_FOLDERS." };
  }

  const cache = await ensureCache(whitelistedFolderIds);
  const folderIds = Array.from(cache);

  // If the cache has a reasonable number of folders, scope the search directly
  if (folderIds.length <= 100) {
    const parentClauses = folderIds.map((id) => `'${id}' in parents`).join(" or ");
    const escapedQuery = query.replace(/'/g, "\\'");
    const searchQuery = `(name contains '${escapedQuery}' or fullText contains '${escapedQuery}') and (${parentClauses}) and trashed=false`;

    try {
      const driveClient = drive.getDrive();
      const res = await driveClient.files.list({
        q: searchQuery,
        fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
        pageSize: maxResults,
        orderBy: "modifiedTime desc",
      });

      const files = (res.data.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        type: humanMimeType(f.mimeType),
        modified: f.modifiedTime,
        link: f.webViewLink,
      }));

      return { count: files.length, files, query };
    } catch (err) {
      // If query too long, fall back to search-then-filter
      if (err.message && (err.message.includes("query") || err.message.includes("Request URI"))) {
        return await teamSearchDriveFallback(query, maxResults, whitelistedFolderIds);
      }
      throw err;
    }
  }

  // Too many folders for inline query, use fallback
  return await teamSearchDriveFallback(query, maxResults, whitelistedFolderIds);
}

// Fallback: search all of Drive, then filter results by parent whitelist
async function teamSearchDriveFallback(query, maxResults, whitelistedFolderIds) {
  const cache = await ensureCache(whitelistedFolderIds);
  const driveClient = drive.getDrive();

  const escapedQuery = query.replace(/'/g, "\\'");
  const searchQuery = `(name contains '${escapedQuery}' or fullText contains '${escapedQuery}') and trashed=false`;
  const res = await driveClient.files.list({
    q: searchQuery,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink, parents)",
    pageSize: maxResults * 3, // fetch extra since we filter
    orderBy: "modifiedTime desc",
  });

  const filtered = (res.data.files || [])
    .filter((f) => (f.parents || []).some((pid) => cache.has(pid)))
    .slice(0, maxResults)
    .map((f) => ({
      id: f.id,
      name: f.name,
      type: humanMimeType(f.mimeType),
      modified: f.modifiedTime,
      link: f.webViewLink,
    }));

  return { count: filtered.length, files: filtered, query };
}

// List contents of a whitelisted folder
async function teamListFolder(folderId, maxResults = 25, whitelistedFolderIds) {
  if (!whitelistedFolderIds || whitelistedFolderIds.length === 0) {
    return { error: "No shared Drive folders configured." };
  }

  const cache = await ensureCache(whitelistedFolderIds);
  if (!cache.has(folderId)) {
    return { error: "That folder is not in the shared project folders." };
  }

  const files = await drive.listFolder(folderId, maxResults);
  return {
    count: files.length,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      type: humanMimeType(f.mimeType),
      modified: f.modifiedTime,
      link: f.webViewLink,
    })),
  };
}

// Read a file, but only if it's inside a whitelisted folder tree
async function teamReadFile(fileId, whitelistedFolderIds) {
  if (!whitelistedFolderIds || whitelistedFolderIds.length === 0) {
    return { error: "No shared Drive folders configured." };
  }

  const inWhitelist = await isFileInWhitelist(fileId, whitelistedFolderIds);
  if (!inWhitelist) {
    return { error: "That file is not in the shared project folders." };
  }

  return await drive.readFile(fileId);
}

function humanMimeType(mimeType) {
  const map = {
    "application/vnd.google-apps.document": "Google Doc",
    "application/vnd.google-apps.spreadsheet": "Google Sheet",
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/vnd.google-apps.folder": "Folder",
    "application/pdf": "PDF",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word Doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "image/png": "PNG Image",
    "image/jpeg": "JPEG Image",
    "text/plain": "Text File",
    "text/csv": "CSV",
    "text/markdown": "Markdown",
  };
  return map[mimeType] || mimeType;
}

module.exports = {
  teamSearchDrive,
  teamListFolder,
  teamReadFile,
  buildFolderCache,
};
