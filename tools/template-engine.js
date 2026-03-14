const path = require("path");
const fs = require("fs").promises;

const PROJECT_ROOT = process.env.EA_PROJECT_PATH || path.resolve(__dirname, "../../");
const TEMPLATES_DIR = path.resolve(PROJECT_ROOT, "templates/contracts");
const SHARED_DIR = path.resolve(TEMPLATES_DIR, "_shared");

// --- Load Templates ---

async function loadTemplate(type, state) {
  const filePath = path.resolve(TEMPLATES_DIR, type, `${state.toLowerCase()}.md`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    return { content: body, meta: frontmatter, path: filePath };
  } catch (err) {
    // Try generic fallback
    const genericPath = path.resolve(TEMPLATES_DIR, type, "generic.md");
    try {
      const raw = await fs.readFile(genericPath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      return { content: body, meta: frontmatter, path: genericPath, note: `No ${state} template, using generic.` };
    } catch {
      return null;
    }
  }
}

async function loadSharedSection(name) {
  const filePath = path.resolve(SHARED_DIR, `${name}.md`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { body } = parseFrontmatter(raw);
    return body;
  } catch {
    return null;
  }
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s) => s.trim());
      }
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body: match[2] };
}

// --- List available templates ---

async function listAvailableTemplates() {
  const result = {};
  try {
    const types = await fs.readdir(TEMPLATES_DIR);
    for (const type of types) {
      if (type.startsWith("_") || type === "README.md") continue;
      const typePath = path.resolve(TEMPLATES_DIR, type);
      const stat = await fs.stat(typePath);
      if (!stat.isDirectory()) continue;
      const files = await fs.readdir(typePath);
      result[type] = files.filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", ""));
    }
  } catch {
    // templates dir may not exist yet
  }
  return result;
}

// --- Merge Fields ---

function mergeFields(template, fields) {
  let result = template;

  // Process conditional blocks: {{#if key}}...{{/if}}
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
    return fields[key] ? content : "";
  });

  // Replace field placeholders: {{field_name}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in fields) return fields[key];
    return match; // leave unfilled for validation
  });

  // Clean up extra blank lines from removed conditional blocks
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

// --- Validate Merge ---

function validateMerge(content) {
  const unfilled = [];
  const regex = /\{\{(\w+)\}\}/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!unfilled.includes(match[1])) {
      unfilled.push(match[1]);
    }
  }
  return unfilled;
}

// --- Get Required Fields ---

function getRequiredFields(templateContent) {
  const fields = new Set();
  // Match {{field_name}} but not {{#if ...}} or {{/if}}
  const regex = /\{\{(?!#if|\/if)(\w+)\}\}/g;
  let match;
  while ((match = regex.exec(templateContent)) !== null) {
    fields.add(match[1]);
  }
  return Array.from(fields);
}

// --- Compose Multi-Section Document ---

const PAGE_BREAK = "\n---PAGE BREAK---\n";

function composeDocument(options) {
  const { coverLetter, contractBody, aboutMe } = options;
  const sections = [];

  if (coverLetter) {
    sections.push({ type: "cover-letter", content: coverLetter });
  }

  if (contractBody) {
    sections.push({ type: "contract", content: contractBody });
  }

  if (aboutMe) {
    sections.push({ type: "about-me", content: aboutMe });
  }

  return sections;
}

// --- Number to Words ---

function numberToWords(num) {
  if (typeof num === "string") num = parseFloat(num.replace(/[$,]/g, ""));
  if (isNaN(num) || num < 0) return "";

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  if (num === 0) return "Zero";

  function convert(n) {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + convert(n % 100) : "");
    if (n < 1000000) return convert(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + convert(n % 1000) : "");
    if (n < 1000000000) return convert(Math.floor(n / 1000000)) + " Million" + (n % 1000000 ? " " + convert(n % 1000000) : "");
    return convert(Math.floor(n / 1000000000)) + " Billion" + (n % 1000000000 ? " " + convert(n % 1000000000) : "");
  }

  const dollars = Math.floor(num);
  const cents = Math.round((num - dollars) * 100);

  let result = convert(dollars);
  if (cents > 0) {
    result += ` and ${cents}/100`;
  }
  return result;
}

// --- Format Currency ---

function formatCurrency(num) {
  if (typeof num === "string") num = parseFloat(num.replace(/[$,]/g, ""));
  if (isNaN(num)) return "";
  return "$" + num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// --- Build Standard Fields ---
// Computes derived fields from raw input

function buildStandardFields(raw) {
  const fields = { ...raw };

  // Always set buyer
  fields.buyer_name = fields.buyer_name || "GF Development LLC";

  // Today's date
  if (!fields.effective_date) {
    fields.effective_date = formatDate(new Date());
  }
  fields.today_date = formatDate(new Date());

  // Price formatting
  if (fields.purchase_price) {
    const priceNum = parseFloat(String(fields.purchase_price).replace(/[$,]/g, ""));
    fields.purchase_price = formatCurrency(priceNum);
    fields.purchase_price_words = numberToWords(priceNum);
  }

  // Earnest money formatting
  if (fields.earnest_money) {
    const emNum = parseFloat(String(fields.earnest_money).replace(/[$,]/g, ""));
    fields.earnest_money = formatCurrency(emNum);
    fields.earnest_money_words = numberToWords(emNum);
  }

  // Defaults
  fields.due_diligence_days = fields.due_diligence_days || "30";
  fields.closing_days = fields.closing_days || "30";

  // Compute closing date if not provided
  if (!fields.closing_date && fields.closing_days) {
    const d = new Date();
    d.setDate(d.getDate() + parseInt(fields.closing_days));
    fields.closing_date = formatDate(d);
  }

  return fields;
}

function formatDate(d) {
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

module.exports = {
  loadTemplate,
  loadSharedSection,
  listAvailableTemplates,
  mergeFields,
  validateMerge,
  getRequiredFields,
  composeDocument,
  numberToWords,
  formatCurrency,
  buildStandardFields,
  formatDate,
  PAGE_BREAK,
};
