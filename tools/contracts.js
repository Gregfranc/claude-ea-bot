const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, TabStopPosition, TabStopType, BorderStyle,
  Header, Footer, PageNumber, NumberFormat,
} = require("docx");
const drive = require("./drive");
const path = require("path");
const fs = require("fs").promises;

const PROJECT_ROOT = process.env.EA_PROJECT_PATH || path.resolve(__dirname, "../../");
const TEMPLATES_DIR = path.resolve(PROJECT_ROOT, "templates/contracts");

// --- Template Library ---

async function listTemplates() {
  try {
    const files = await fs.readdir(TEMPLATES_DIR);
    const templates = files.filter((f) => f.endsWith(".md"));
    if (templates.length === 0) {
      return { templates: [], note: "No contract templates found. Templates should be built in templates/contracts/ as .md files." };
    }
    return { templates: templates.map((f) => f.replace(".md", "")) };
  } catch {
    return { templates: [], note: "Template directory does not exist yet. It will be created when templates are built." };
  }
}

async function readTemplate(templateName) {
  try {
    const filePath = path.resolve(TEMPLATES_DIR, `${templateName}.md`);
    const content = await fs.readFile(filePath, "utf-8");
    return { name: templateName, content };
  } catch (err) {
    return { error: `Template "${templateName}" not found: ${err.message}` };
  }
}

// --- Precedent Search ---
// Searches Google Drive for similar past contracts across deal folders

async function searchPrecedent(dealType, market, keywords) {
  const results = [];

  // Search by deal type
  if (dealType) {
    const typeQuery = `name contains '${dealType}' and (mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/vnd.google-apps.document') and trashed=false`;
    try {
      const files = await drive.searchFiles(typeQuery, 10);
      results.push(...files.map((f) => ({ ...f, matchType: "deal_type" })));
    } catch {}
  }

  // Search by market
  if (market) {
    const marketQuery = `name contains '${market}' and (mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/vnd.google-apps.document') and trashed=false`;
    try {
      const files = await drive.searchFiles(marketQuery, 10);
      results.push(...files.map((f) => ({ ...f, matchType: "market" })));
    } catch {}
  }

  // Search by keywords
  if (keywords) {
    const kwQuery = `fullText contains '${keywords}' and (mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/vnd.google-apps.document') and trashed=false`;
    try {
      const files = await drive.searchFiles(kwQuery, 10);
      results.push(...files.map((f) => ({ ...f, matchType: "keywords" })));
    } catch {}
  }

  // Also search for "contract", "agreement", "amendment", "purchase" in general
  const generalQuery = `(name contains 'contract' or name contains 'agreement' or name contains 'amendment' or name contains 'purchase') and (mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/vnd.google-apps.document') and trashed=false`;
  try {
    const files = await drive.searchFiles(generalQuery, 15);
    results.push(...files.map((f) => ({ ...f, matchType: "general" })));
  } catch {}

  // Deduplicate by file ID
  const seen = new Set();
  const unique = results.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  return {
    found: unique.length,
    files: unique.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      link: f.webViewLink,
      matchType: f.matchType,
    })),
    note: unique.length > 0
      ? `Found ${unique.length} potential precedent documents. Use read_drive_file to read the most relevant ones before drafting.`
      : "No precedent contracts found in Drive. Draft from scratch or ask Greg to upload examples.",
  };
}

// --- DOCX Generation ---
// Converts structured contract text into a professional .docx file

function parseContractToDocx(contractText, title) {
  const lines = contractText.split("\n");
  const children = [];

  // Title
  children.push(
    new Paragraph({
      children: [new TextRun({ text: title || "PURCHASE AND SALE AGREEMENT", bold: true, size: 28, font: "Times New Roman" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    })
  );

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ spacing: { after: 100 } }));
      continue;
    }

    // Section headers (e.g., "ARTICLE 1: PROPERTY" or "1. PROPERTY")
    const sectionMatch = trimmed.match(/^(?:ARTICLE\s+\d+[:.]\s*|SECTION\s+\d+[:.]\s*|\d+\.\s+)([A-Z][A-Z\s&,]+)$/);
    if (sectionMatch || trimmed === trimmed.toUpperCase() && trimmed.length > 3 && trimmed.length < 80) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed, bold: true, size: 24, font: "Times New Roman" })],
          spacing: { before: 300, after: 200 },
        })
      );
      continue;
    }

    // Subsection headers (e.g., "1.1 Purchase Price" or "(a) Purchase Price")
    const subMatch = trimmed.match(/^(?:\d+\.\d+\s+|\([a-z]\)\s+)/);
    if (subMatch) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: trimmed, bold: true, size: 22, font: "Times New Roman" })],
          spacing: { before: 200, after: 100 },
          indent: { left: 360 },
        })
      );
      continue;
    }

    // Signature lines
    if (trimmed.startsWith("___") || trimmed.startsWith("---")) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: "________________________________________", font: "Times New Roman", size: 22 })],
          spacing: { before: 400, after: 100 },
        })
      );
      continue;
    }

    // Regular paragraph
    children.push(
      new Paragraph({
        children: [new TextRun({ text: trimmed, size: 22, font: "Times New Roman" })],
        spacing: { after: 100 },
        indent: trimmed.startsWith("(") ? { left: 720 } : undefined,
      })
    );
  }

  return children;
}

async function generateContractDoc(contractText, fileName, docType, dealName) {
  // Build date prefix: YYMMDD
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const datePrefix = `${yy}${mm}${dd}`;

  // Build file name
  const safeName = fileName || `${dealName || "Contract"} - ${docType || "Agreement"}`;
  const fullName = `${datePrefix} ${safeName}.docx`;

  // Determine document title from doc type
  const titleMap = {
    "purchase-agreement": "PURCHASE AND SALE AGREEMENT",
    "amendment": "AMENDMENT TO PURCHASE AND SALE AGREEMENT",
    "extension": "AMENDMENT TO PURCHASE AND SALE AGREEMENT\nEXTENSION OF TIME",
    "assignment": "ASSIGNMENT OF PURCHASE AND SALE AGREEMENT",
    "lot-sale": "LOT PURCHASE AND SALE AGREEMENT",
    "option": "OPTION TO PURCHASE AGREEMENT",
    "earnest-money": "EARNEST MONEY AGREEMENT",
  };
  const title = titleMap[docType] || docType?.toUpperCase() || "AGREEMENT";

  const docChildren = parseContractToDocx(contractText, title);

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: "CONFIDENTIAL", italics: true, size: 18, font: "Times New Roman", color: "888888" })],
                alignment: AlignmentType.RIGHT,
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: "Page ", size: 18, font: "Times New Roman" }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, font: "Times New Roman" }),
                  new TextRun({ text: " of ", size: 18, font: "Times New Roman" }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, font: "Times New Roman" }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        children: docChildren,
      },
    ],
  });

  // Generate buffer
  const buffer = await Packer.toBuffer(doc);

  // Upload to Drive in Contracts/Drafts folder
  const contractsFolderId = await drive.findOrCreateFolder("Contracts");
  const draftsFolderId = await drive.findOrCreateFolder("Drafts", contractsFolderId);

  // If deal-specific, create a subfolder
  let targetFolderId = draftsFolderId;
  if (dealName) {
    targetFolderId = await drive.findOrCreateFolder(dealName, draftsFolderId);
  }

  // Upload the .docx
  const driveObj = drive.getDrive();
  const media = {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: require("stream").Readable.from([buffer]),
  };
  const metadata = {
    name: fullName,
    parents: [targetFolderId],
  };

  const res = await driveObj.files.create({
    resource: metadata,
    media,
    fields: "id, name, webViewLink",
  });

  return {
    id: res.data.id,
    name: res.data.name,
    link: res.data.webViewLink,
    folder: dealName ? `Contracts/Drafts/${dealName}` : "Contracts/Drafts",
    size: buffer.length,
    note: `Contract draft "${fullName}" uploaded to Google Drive. Greg can review and edit in Google Docs or download the .docx.`,
  };
}

module.exports = {
  listTemplates,
  readTemplate,
  searchPrecedent,
  generateContractDoc,
};
