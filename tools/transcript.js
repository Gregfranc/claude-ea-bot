// Meeting transcript processing: summarize, classify, and file to Google Drive
const Anthropic = require("@anthropic-ai/sdk");
const drive = require("./drive");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Temp storage for uploaded file content (avoids passing huge text through agent tool calls)
const uploadedFiles = new Map();

function storeUploadedFile(text, fileName, mimeType) {
  const id = `file-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  uploadedFiles.set(id, { text, fileName, mimeType, timestamp: Date.now() });
  // Auto-cleanup after 30 minutes
  setTimeout(() => uploadedFiles.delete(id), 30 * 60 * 1000);
  return id;
}

function getUploadedFile(id) {
  return uploadedFiles.get(id) || null;
}

// Known projects/deals for classification
const KNOWN_PROJECTS = [
  "Traditions North",
  "Brio Vista",
  "Columbia View Estates",
  "Idaho County 154ac",
  "Sage Creek",
  "La Pine OR",
  "Wasem Lot 3",
  "Tomi Coffe",
  "Sims",
  "Cumley",
  "Forest",
];

async function processTranscript({ file_ref, transcript_text, file_name, source }) {
  // Resolve transcript text from file ref or direct input
  let text, fileName;

  if (file_ref) {
    const uploaded = getUploadedFile(file_ref);
    if (!uploaded) {
      return { error: "File reference not found or expired. Upload the file again." };
    }
    text = uploaded.text;
    fileName = uploaded.fileName || "transcript";
  } else if (transcript_text) {
    text = transcript_text;
    fileName = file_name || "transcript";
  } else {
    return { error: "Provide either file_ref (from an uploaded file) or transcript_text." };
  }

  if (text.trim().length < 50) {
    return { error: "Transcript text is too short to process (minimum 50 characters)." };
  }

  // Truncate to fit Haiku context if needed
  const maxChars = 150000;
  const truncated = text.length > maxChars;
  const inputText = truncated ? text.substring(0, maxChars) : text;

  try {
    console.log(`[Transcript] Processing ${fileName} (${(text.length / 1024).toFixed(1)} KB)...`);

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: `You are summarizing a meeting transcript for Greg Francis, CEO of GF Development LLC (land development company).

Known projects/deals: ${KNOWN_PROJECTS.join(", ")}

Analyze this transcript and return a structured summary in this exact markdown format:

# Meeting Summary
**Date:** [extract from transcript or use "Unknown"]
**Participants:** [list names mentioned]
**Source:** ${source || "Unknown"}
**Project:** [match to one of the known projects above, or "General" if no match]
**Duration:** [estimate if possible, otherwise "Unknown"]

## Key Decisions
- [list each decision made, or "None" if no decisions]

## Action Items
- [ ] [Person]: [action item with deadline if mentioned]

## Follow-ups
- [items that need follow-up but aren't immediate action items]

## Key Discussion Points
- [2-4 bullet summary of main topics discussed]

${truncated ? "\nNote: Transcript was truncated due to length. Summary covers the first portion only." : ""}

TRANSCRIPT:
${inputText}`
      }],
    });

    const summary = response.content[0].text;

    // Extract project classification from the summary
    const projectMatch = summary.match(/\*\*Project:\*\*\s*(.+)/);
    const projectName = projectMatch ? projectMatch[1].trim() : "General";

    // Save to Google Drive
    let driveResult = null;
    try {
      const mtFolderId = await drive.findOrCreateFolder("Meeting Transcripts");
      const projectFolderId = await drive.findOrCreateFolder(projectName, mtFolderId);

      const date = new Date().toISOString().split("T")[0];
      const baseName = fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
      const summaryFileName = `${date}_${baseName}_summary.md`;
      const originalFileName = `${date}_${baseName}_original.txt`;

      const summaryResult = await drive.uploadFile(
        summaryFileName,
        summary,
        "text/markdown",
        projectFolderId
      );

      const originalResult = await drive.uploadFile(
        originalFileName,
        text,
        "text/plain",
        projectFolderId
      );

      driveResult = {
        folder: `Meeting Transcripts/${projectName}`,
        summary: { name: summaryResult.name, link: summaryResult.link },
        original: { name: originalResult.name, link: originalResult.link },
      };

      console.log(`[Transcript] Filed to Drive: Meeting Transcripts/${projectName}/`);
    } catch (driveErr) {
      console.error("[Transcript] Drive upload error:", driveErr.message);
      driveResult = { error: `Could not save to Drive: ${driveErr.message}` };
    }

    // Clean up the stored file now that it's processed
    if (file_ref) uploadedFiles.delete(file_ref);

    return {
      success: true,
      summary,
      project: projectName,
      drive: driveResult,
      truncated,
    };
  } catch (err) {
    console.error("[Transcript] Processing error:", err.message);
    return { error: `Failed to process transcript: ${err.message}` };
  }
}

module.exports = { processTranscript, storeUploadedFile, getUploadedFile };
