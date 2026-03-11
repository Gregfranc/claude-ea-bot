const { google } = require("googleapis");
const path = require("path");
const fs = require("fs").promises;

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

function getDrive() {
  return google.drive({ version: "v3", auth: getAuthedClient() });
}

// Find a folder by name, optionally under a parent. Returns folder ID or null.
async function findFolder(name, parentId) {
  const drive = getDrive();
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await drive.files.list({ q, fields: "files(id, name)", pageSize: 1 });
  return res.data.files.length > 0 ? res.data.files[0].id : null;
}

// Create a folder, returns folder ID.
async function createFolder(name, parentId) {
  const drive = getDrive();
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];
  const res = await drive.files.create({ resource: metadata, fields: "id" });
  return res.data.id;
}

// Find or create a folder by name.
async function findOrCreateFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  return await createFolder(name, parentId);
}

// Upload a file (create or update if same name exists in folder).
async function uploadFile(fileName, content, mimeType, folderId) {
  const drive = getDrive();

  // Check if file already exists in folder
  let q = `name='${fileName}' and trashed=false`;
  if (folderId) q += ` and '${folderId}' in parents`;
  const existing = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });

  const media = {
    mimeType: mimeType || "text/markdown",
    body: require("stream").Readable.from([content]),
  };

  if (existing.data.files.length > 0) {
    // Update existing file
    const fileId = existing.data.files[0].id;
    const res = await drive.files.update({
      fileId,
      media,
      fields: "id, name, webViewLink",
    });
    return { id: res.data.id, name: res.data.name, link: res.data.webViewLink, action: "updated" };
  } else {
    // Create new file
    const metadata = { name: fileName };
    if (folderId) metadata.parents = [folderId];
    const res = await drive.files.create({
      resource: metadata,
      media,
      fields: "id, name, webViewLink",
    });
    return { id: res.data.id, name: res.data.name, link: res.data.webViewLink, action: "created" };
  }
}

// Upload the daily recovery backup
async function uploadRecoveryBackup() {
  const PROJECT_ROOT = process.env.EA_PROJECT_PATH || path.resolve(__dirname, "../../");
  const recoveryPath = path.resolve(PROJECT_ROOT, "recovery-doc.md");

  let content;
  try {
    content = await fs.readFile(recoveryPath, "utf-8");
  } catch (err) {
    return { error: `Could not read recovery-doc.md: ${err.message}` };
  }

  // Update the generated date in the content
  const today = new Date().toISOString().split("T")[0];
  content = content.replace(/^Generated:.*$/m, `Generated: ${today}`);

  // Find or create the backup folder
  const folderId = await findOrCreateFolder("Claude EA Backups");

  // Upload with date-stamped name
  const fileName = `recovery-doc-${today}.md`;
  const result = await uploadFile(fileName, content, "text/markdown", folderId);

  // Also upload/update a "latest" copy for easy access
  await uploadFile("recovery-doc-LATEST.md", content, "text/markdown", folderId);

  return { ...result, date: today, folder: "Claude EA Backups" };
}

// Search files in Drive
async function searchFiles(query, maxResults = 10) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `${query} and trashed=false`,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
    pageSize: maxResults,
  });
  return res.data.files || [];
}

module.exports = {
  getDrive,
  findFolder,
  createFolder,
  findOrCreateFolder,
  uploadFile,
  uploadRecoveryBackup,
  searchFiles,
};
