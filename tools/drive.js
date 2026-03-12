const { google } = require("googleapis");
const path = require("path");
const fs = require("fs").promises;
const pdfParse = require("pdf-parse");

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

// List files in a Drive folder
async function listFolder(folderId, maxResults = 25) {
  const drive = getDrive();
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
    pageSize: maxResults,
    orderBy: "modifiedTime desc",
  });
  return res.data.files || [];
}

// Read/download file content from Drive
async function readFile(fileId) {
  const drive = getDrive();

  // Get file metadata first
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size",
  });
  const { name, mimeType } = meta.data;

  // Google Workspace files need export
  if (mimeType === "application/vnd.google-apps.document") {
    const res = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" }
    );
    return { name, mimeType, content: res.data };
  }
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export(
      { fileId, mimeType: "text/csv" },
      { responseType: "text" }
    );
    return { name, mimeType, content: res.data };
  }
  if (mimeType === "application/vnd.google-apps.folder") {
    const files = await listFolder(fileId);
    return { name, mimeType, content: `Folder contents:\n${files.map((f) => `- ${f.name} (${f.mimeType})`).join("\n")}`, files };
  }

  // Binary files: download and try to extract text
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buffer = Buffer.from(res.data);

  // PDF: proper text extraction using pdf-parse
  if (mimeType === "application/pdf") {
    try {
      const data = await pdfParse(buffer);
      const text = data.text.trim();
      if (text.length > 50) {
        return { name, mimeType, content: text.substring(0, 5000), pages: data.numpages, note: `Extracted ${data.numpages} pages (truncated to 5000 chars). Full text available if needed.` };
      }
      return { name, mimeType, content: "(PDF appears to be scanned/image-based with no extractable text.)", size: buffer.length, pages: data.numpages };
    } catch (err) {
      return { name, mimeType, content: `(PDF parsing failed: ${err.message})`, size: buffer.length };
    }
  }

  // Text-based files
  if (mimeType && (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml"))) {
    return { name, mimeType, content: buffer.toString("utf-8").substring(0, 10000) };
  }

  // Word docs: basic text extraction
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/ {3,}/g, " ").trim();
    if (text.length > 100) {
      return { name, mimeType, content: text.substring(0, 10000), note: "Basic .docx text extraction." };
    }
    return { name, mimeType, content: "(Could not extract text from .docx)", size: buffer.length };
  }

  return { name, mimeType, content: `(Binary file, ${buffer.length} bytes. Cannot display as text.)`, size: buffer.length };
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
  readFile,
  listFolder,
};
