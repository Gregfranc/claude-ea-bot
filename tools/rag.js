// RAG Knowledge Base: Pinecone + Gemini Embedding 2
// Indexes all Google Drive documents for semantic search from Slack bot and Claude Code.
// Chunks documents, embeds via Gemini, stores in Pinecone with metadata.

const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenAI } = require("@google/genai");
const drive = require("./drive");
const permissions = require("./permissions");
const fs = require("fs");
const path = require("path");

// --- Config ---
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 3072;
const PINECONE_INDEX_NAME = "gfdev-knowledge";
const CHUNK_MAX_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 400;
const MAX_RESULTS_DEFAULT = 5;
const SYNC_STATE_FILE = path.join(__dirname, "../data/rag-sync-state.json");

// Known deals for metadata matching (mirrors meeting-notes.js KNOWN_PROJECTS)
const KNOWN_DEALS = [
  "Traditions North", "Brio Vista", "Columbia View Estates",
  "Idaho County 154ac", "Sage Creek", "La Pine OR",
  "Wasem Lot 3", "Tomi Coffe", "Sims", "Cumley", "Forest",
  "Inness", "Kohls", "Standridge", "Rudeck", "Bell",
];

// File types to skip (can't extract text)
const SKIP_MIME_TYPES = [
  "image/", "video/", "audio/",
  "application/zip", "application/x-zip",
  "application/x-rar", "application/gzip",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.shortcut",
];

// --- Lazy Initialization ---
let pineconeClient = null;
let pineconeIndex = null;
let geminiClient = null;

function getPinecone() {
  if (!pineconeClient) {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error("PINECONE_API_KEY not set in .env");
    }
    pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pineconeClient;
}

async function getIndex() {
  if (!pineconeIndex) {
    const pc = getPinecone();
    const indexes = await pc.listIndexes();
    const existing = indexes.indexes?.find((idx) => idx.name === PINECONE_INDEX_NAME);

    // If index exists but wrong dimension, delete and recreate
    if (existing && existing.dimension !== EMBEDDING_DIMENSIONS) {
      console.log(`[RAG] Index has wrong dimensions (${existing.dimension} vs ${EMBEDDING_DIMENSIONS}). Deleting and recreating...`);
      await pc.deleteIndex(PINECONE_INDEX_NAME);
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!existing || existing.dimension !== EMBEDDING_DIMENSIONS) {
      console.log(`[RAG] Creating Pinecone index "${PINECONE_INDEX_NAME}" (${EMBEDDING_DIMENSIONS} dims)...`);
      await pc.createIndex({
        name: PINECONE_INDEX_NAME,
        dimension: EMBEDDING_DIMENSIONS,
        metric: "cosine",
        spec: { serverless: { cloud: "aws", region: "us-east-1" } },
      });
      console.log("[RAG] Waiting for index to initialize...");
      await new Promise((r) => setTimeout(r, 30000));
    }
    pineconeIndex = pc.index(PINECONE_INDEX_NAME);
  }
  return pineconeIndex;
}

function getGemini() {
  if (!geminiClient) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY not set in .env");
    }
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

// --- Sync State ---
function loadSyncState() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf-8"));
  } catch {
    return {
      last_sync: null,
      files_indexed: 0,
      total_chunks: 0,
      failed_files: [],
      indexed_files: {}, // { drive_file_id: { modifiedTime, chunks } }
    };
  }
}

function saveSyncState(state) {
  const dir = path.dirname(SYNC_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Rate Limiting ---
// Free tier: 100 embed requests/minute. Space them ~700ms apart to stay safe.
const EMBED_DELAY_MS = 700;
let lastEmbedTime = 0;

async function rateLimitedEmbed(text, retries = 3) {
  const ai = getGemini();
  for (let attempt = 0; attempt < retries; attempt++) {
    // Enforce minimum delay between calls
    const now = Date.now();
    const elapsed = now - lastEmbedTime;
    if (elapsed < EMBED_DELAY_MS) {
      await new Promise((r) => setTimeout(r, EMBED_DELAY_MS - elapsed));
    }
    lastEmbedTime = Date.now();

    try {
      const result = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      return result.embeddings[0].values;
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        // Parse retry delay from error, default 60s
        const retryMatch = msg.match(/retryDelay.*?(\d+)s/i) || msg.match(/retry in (\d+)/i);
        const waitSec = retryMatch ? parseInt(retryMatch[1]) + 5 : 60;
        console.log(`[RAG] Rate limited. Waiting ${waitSec}s before retry ${attempt + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err; // Non-rate-limit error, don't retry
    }
  }
  throw new Error("Rate limit retries exhausted");
}

// --- Embedding ---
async function embedText(text) {
  return rateLimitedEmbed(text);
}

async function embedBatch(texts) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i++) {
    const vec = await rateLimitedEmbed(texts[i]);
    embeddings.push(vec);
  }
  return embeddings;
}

// --- Chunking ---
function chunkText(text, maxChars = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP_CHARS) {
  if (!text || text.trim().length === 0) return [];
  // Clean up text
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // If text fits in one chunk, just return it
  if (text.length <= maxChars) return [text.trim()];

  // Split on double newlines (paragraphs) or headers
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;
    if (candidate.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Overlap: keep end of previous chunk
      const overlapText = current.slice(-overlap);
      current = overlapText + "\n\n" + para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Handle case where a single paragraph exceeds maxChars
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      finalChunks.push(chunk);
    } else {
      // Force-split on sentences or at maxChars
      for (let i = 0; i < chunk.length; i += maxChars - overlap) {
        finalChunks.push(chunk.slice(i, i + maxChars).trim());
      }
    }
  }

  return finalChunks.filter((c) => c.length > 20);
}

// --- Metadata ---
function classifyFileType(name, mimeType) {
  const lower = (name || "").toLowerCase();
  if (lower.includes("contract") || lower.includes("agreement") || lower.includes("amendment") || lower.includes("addendum") || lower.includes("psa")) return "contract";
  if (lower.includes("meeting") || lower.includes("transcript") || lower.includes("notes by gemini") || lower.includes("read ai")) return "meeting-note";
  if (lower.includes("plat") || lower.includes("survey")) return "plat";
  if (lower.includes("letter") || lower.includes("correspondence")) return "letter";
  if (lower.includes("invoice") || lower.includes("receipt") || lower.includes("statement")) return "financial";
  if ((mimeType || "").includes("spreadsheet") || (mimeType || "").includes("excel") || (mimeType || "").includes("csv")) return "spreadsheet";
  return "other";
}

function matchDeal(name, folderPath) {
  const searchText = ((name || "") + " " + (folderPath || "")).toLowerCase();
  for (const deal of KNOWN_DEALS) {
    if (searchText.includes(deal.toLowerCase())) return deal;
  }
  // Partial matches
  if (searchText.includes("la pine") || searchText.includes("lapine")) return "La Pine OR";
  if (searchText.includes("traditions")) return "Traditions North";
  if (searchText.includes("brio")) return "Brio Vista";
  if (searchText.includes("columbia view")) return "Columbia View Estates";
  if (searchText.includes("wasem")) return "Wasem Lot 3";
  if (searchText.includes("tomi") || searchText.includes("coffe")) return "Tomi Coffe";
  return "none";
}

function shouldSkipFile(mimeType) {
  return SKIP_MIME_TYPES.some((skip) => (mimeType || "").startsWith(skip));
}

// --- Drive Crawling ---
async function crawlDriveFolder(folderId, folderPath, state, progressCb) {
  const driveApi = drive.getDrive();
  let pageToken = null;
  const files = [];

  do {
    const res = await driveApi.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, parents)",
      pageSize: 100,
      pageToken,
    });
    if (res.data.files) files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const results = { indexed: 0, skipped: 0, failed: 0, subfolders: 0 };

  for (const file of files) {
    // Recurse into subfolders
    if (file.mimeType === "application/vnd.google-apps.folder") {
      results.subfolders++;
      const subPath = folderPath ? `${folderPath}/${file.name}` : file.name;
      if (progressCb) progressCb(`Scanning folder: ${subPath}`);
      const subResults = await crawlDriveFolder(file.id, subPath, state, progressCb);
      results.indexed += subResults.indexed;
      results.skipped += subResults.skipped;
      results.failed += subResults.failed;
      results.subfolders += subResults.subfolders;
      continue;
    }

    // Skip unsupported file types
    if (shouldSkipFile(file.mimeType)) {
      results.skipped++;
      continue;
    }

    // Check if already indexed and not modified
    const existing = state.indexed_files[file.id];
    if (existing && existing.modifiedTime === file.modifiedTime) {
      results.skipped++;
      continue;
    }

    // Ingest this file
    try {
      const chunkCount = await ingestFile(file.id, file.name, file.mimeType, file.webViewLink, folderPath, file.modifiedTime, folderId);
      state.indexed_files[file.id] = {
        modifiedTime: file.modifiedTime,
        chunks: chunkCount,
        name: file.name,
      };
      results.indexed++;
      if (progressCb) progressCb(`Indexed: ${file.name} (${chunkCount} chunks)`);
      // Save state after each file for crash safety
      saveSyncState(state);
    } catch (err) {
      results.failed++;
      console.error(`[RAG] Failed to index ${file.name}: ${err.message}`);
      state.failed_files.push({
        id: file.id,
        name: file.name,
        error: err.message,
        last_attempt: new Date().toISOString(),
      });
      // Keep only last 50 failures
      if (state.failed_files.length > 50) state.failed_files = state.failed_files.slice(-50);
    }

    // Rate limiting is handled per-embed-call in rateLimitedEmbed()
  }

  return results;
}

// --- Ingestion ---
async function ingestFile(fileId, fileName, mimeType, webViewLink, folderPath, modifiedTime, parentFolderId) {
  // Read file content via existing drive.js
  const fileData = await drive.readFile(fileId);
  const content = fileData.content;

  if (!content || content.length < 50 || content.startsWith("(Binary file") || content.startsWith("(PDF appears") || content.startsWith("(Could not")) {
    return 0;
  }

  // Chunk the content
  const chunks = chunkText(content);
  if (chunks.length === 0) return 0;

  // Delete old vectors for this file (if re-indexing)
  const index = await getIndex();
  try {
    // Delete by ID prefix pattern
    const oldIds = Array.from({ length: 200 }, (_, i) => `${fileId}_chunk_${i}`);
    // Pinecone delete by IDs (ignores non-existent IDs)
    await index.deleteMany(oldIds);
  } catch {
    // Ignore delete errors on fresh index
  }

  // Embed all chunks
  const embeddings = await embedBatch(chunks);

  // Build vectors with metadata
  const fileType = classifyFileType(fileName, mimeType);
  const dealName = matchDeal(fileName, folderPath);

  const vectors = chunks.map((text, i) => ({
    id: `${fileId}_chunk_${i}`,
    values: embeddings[i],
    metadata: {
      drive_file_id: fileId,
      file_name: fileName || "unknown",
      file_type: fileType,
      deal_name: dealName,
      drive_folder_id: parentFolderId || "",
      drive_folder_path: folderPath || "",
      chunk_index: i,
      total_chunks: chunks.length,
      modified_time: modifiedTime || "",
      web_view_link: webViewLink || "",
      text: text.substring(0, 2000), // Store full chunk text in metadata for retrieval
    },
  }));

  // Upsert to Pinecone in batches of 100
  for (let i = 0; i < vectors.length; i += 100) {
    const batch = vectors.slice(i, i + 100);
    await index.upsert(batch);
  }

  return chunks.length;
}

// --- Search (with freshness check) ---
async function search(query, filters = {}, topK = MAX_RESULTS_DEFAULT) {
  const index = await getIndex();
  const queryEmbedding = await embedText(query);

  // Build metadata filter
  const metadataFilter = {};
  if (filters.deal && filters.deal !== "none") {
    metadataFilter.deal_name = { $eq: filters.deal };
  }
  if (filters.fileType) {
    metadataFilter.file_type = { $eq: filters.fileType };
  }

  // Team members: filter to whitelisted folders
  if (filters.teamOnly) {
    const teamFolders = permissions.getTeamDriveFolders();
    if (teamFolders.length > 0) {
      metadataFilter.drive_folder_id = { $in: teamFolders };
    }
  }

  const queryParams = {
    vector: queryEmbedding,
    topK: Math.min(topK, 10),
    includeMetadata: true,
  };
  if (Object.keys(metadataFilter).length > 0) {
    queryParams.filter = metadataFilter;
  }

  const results = await index.query(queryParams);

  if (!results.matches || results.matches.length === 0) {
    return { query, results: [], message: "No matching documents found." };
  }

  // Freshness check: re-index any stale files before returning results
  const staleReindexed = await refreshStaleResults(results.matches);

  // If any files were re-indexed, re-run the query to get updated text
  if (staleReindexed > 0) {
    const freshResults = await index.query(queryParams);
    if (freshResults.matches && freshResults.matches.length > 0) {
      return {
        query,
        freshness_note: `${staleReindexed} file(s) were updated since last index and re-indexed on the fly.`,
        results: freshResults.matches.map(formatMatch),
      };
    }
  }

  return {
    query,
    results: results.matches.map(formatMatch),
  };
}

function formatMatch(match) {
  return {
    text: match.metadata.text || "",
    file_name: match.metadata.file_name,
    deal: match.metadata.deal_name,
    file_type: match.metadata.file_type,
    folder: match.metadata.drive_folder_path,
    link: match.metadata.web_view_link,
    relevance: match.score?.toFixed(3),
    chunk: `${(match.metadata.chunk_index || 0) + 1}/${match.metadata.total_chunks || "?"}`,
  };
}

// Check if any search results come from files that have been modified since indexing.
// If so, re-index those files on the spot so the user gets fresh content.
async function refreshStaleResults(matches) {
  const driveApi = drive.getDrive();
  const state = loadSyncState();
  const checkedFiles = new Set();
  let reindexed = 0;

  for (const match of matches) {
    const fileId = match.metadata.drive_file_id;
    if (!fileId || checkedFiles.has(fileId)) continue;
    checkedFiles.add(fileId);

    const indexedModTime = match.metadata.modified_time;
    if (!indexedModTime) continue;

    try {
      // Quick metadata-only call to check current modifiedTime
      const meta = await driveApi.files.get({
        fileId,
        fields: "id, name, mimeType, modifiedTime, webViewLink, parents",
      });
      const currentModTime = meta.data.modifiedTime;

      if (currentModTime && currentModTime !== indexedModTime) {
        console.log(`[RAG] Stale file detected: ${meta.data.name} (indexed: ${indexedModTime}, current: ${currentModTime}). Re-indexing...`);
        const parentId = (meta.data.parents && meta.data.parents[0]) || "";
        const folderPath = state.indexed_files[fileId]?.folderPath || match.metadata.drive_folder_path || "";
        const chunks = await ingestFile(fileId, meta.data.name, meta.data.mimeType, meta.data.webViewLink, folderPath, currentModTime, parentId);
        if (chunks > 0) {
          state.indexed_files[fileId] = { modifiedTime: currentModTime, chunks, name: meta.data.name };
          saveSyncState(state);
          reindexed++;
        }
      }
    } catch (err) {
      // File might have been deleted or permission revoked. Skip quietly.
      console.error(`[RAG] Freshness check failed for ${fileId}: ${err.message}`);
    }
  }

  return reindexed;
}

// --- Sync ---
async function syncDrive(progressCb) {
  const state = loadSyncState();
  const startTime = new Date().toISOString();

  if (progressCb) progressCb("Starting Drive sync...");

  // Get root folder contents (My Drive)
  const driveApi = drive.getDrive();
  const rootRes = await driveApi.files.get({
    fileId: "root",
    fields: "id",
  });
  const rootId = rootRes.data.id;

  const results = await crawlDriveFolder(rootId, "", state, progressCb);

  // Update state
  state.last_sync = startTime;
  state.files_indexed = Object.keys(state.indexed_files).length;
  state.total_chunks = Object.values(state.indexed_files).reduce((sum, f) => sum + (f.chunks || 0), 0);
  saveSyncState(state);

  const summary = {
    started: startTime,
    completed: new Date().toISOString(),
    files_indexed_this_run: results.indexed,
    files_skipped: results.skipped,
    files_failed: results.failed,
    folders_scanned: results.subfolders,
    total_files_in_index: state.files_indexed,
    total_chunks_in_index: state.total_chunks,
  };

  if (progressCb) progressCb(`Sync complete: ${results.indexed} indexed, ${results.skipped} skipped, ${results.failed} failed.`);
  console.log("[RAG] Sync complete:", JSON.stringify(summary));
  return summary;
}

async function fullReindex(progressCb) {
  if (progressCb) progressCb("Starting full reindex (clearing existing data)...");

  // Clear Pinecone index
  try {
    const index = await getIndex();
    await index.deleteAll();
    if (progressCb) progressCb("Pinecone index cleared.");
  } catch (err) {
    console.error("[RAG] Error clearing index:", err.message);
  }

  // Reset sync state
  const freshState = {
    last_sync: null,
    files_indexed: 0,
    total_chunks: 0,
    failed_files: [],
    indexed_files: {},
  };
  saveSyncState(freshState);

  // Run full sync
  return await syncDrive(progressCb);
}

// --- Stats ---
async function getStats() {
  const state = loadSyncState();
  let indexStats = {};
  try {
    const index = await getIndex();
    const stats = await index.describeIndexStats();
    indexStats = {
      total_vectors: stats.totalRecordCount || 0,
      dimension: stats.dimension || EMBEDDING_DIMENSIONS,
    };
  } catch (err) {
    indexStats = { error: err.message };
  }

  return {
    last_sync: state.last_sync,
    files_indexed: state.files_indexed,
    total_chunks: state.total_chunks,
    failed_files_count: state.failed_files.length,
    recent_failures: state.failed_files.slice(-5).map((f) => `${f.name}: ${f.error}`),
    pinecone: indexStats,
  };
}

module.exports = {
  search,
  syncDrive,
  fullReindex,
  getStats,
  embedText,
  chunkText,
  ingestFile,
};
