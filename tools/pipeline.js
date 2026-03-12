const { google } = require("googleapis");

function getAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
}

function getAuthedClient() {
  const auth = getAuth();
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

function getSheets() {
  return google.sheets({ version: "v4", auth: getAuthedClient() });
}

const SHEET_ID = () => process.env.PIPELINE_SHEET_ID;

// Read all pipeline data as objects
async function getAllDeals() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: "Pipeline!A1:L100",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const deal = {};
    headers.forEach((h, i) => {
      deal[h] = row[i] || "";
    });
    return deal;
  });
}

// Get a formatted pipeline summary
async function getPipelineSummary() {
  const deals = await getAllDeals();
  if (deals.length === 0) return "No deals in pipeline.";

  // Group by stage
  const stages = {};
  deals.forEach((d) => {
    const stage = d["Stage"] || "Unknown";
    if (!stages[stage]) stages[stage] = [];
    stages[stage].push(d);
  });

  // Order stages by urgency
  const stageOrder = ["Closing", "Escrow Open", "Listed", "Contract Signed", "Pending Signature", "Entitlement", "Active", "TBD"];
  const lines = ["*GF Development — Deal Pipeline*\n"];

  for (const stage of stageOrder) {
    if (!stages[stage]) continue;
    lines.push(`*${stage}* (${stages[stage].length})`);
    for (const d of stages[stage]) {
      const parts = [`  ${d["Deal Name"]}`];
      if (d["Market"]) parts.push(`| ${d["Market"]}`);
      if (d["Close Date"]) parts.push(`| Close: ${d["Close Date"]}`);
      if (d["Projected Gross"]) parts.push(`| Gross: ${d["Projected Gross"]}`);
      if (d["Next Action"]) parts.push(`| Next: ${d["Next Action"]}`);
      lines.push(parts.join(" "));
    }
    lines.push("");
  }

  // Handle any stages not in the order list
  for (const stage of Object.keys(stages)) {
    if (stageOrder.includes(stage)) continue;
    lines.push(`*${stage}* (${stages[stage].length})`);
    for (const d of stages[stage]) {
      lines.push(`  ${d["Deal Name"]} | ${d["Market"] || "TBD"}`);
    }
    lines.push("");
  }

  lines.push(`_Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID()}/edit_`);
  return lines.join("\n");
}

// Look up a specific deal by name (fuzzy match)
async function lookupDeal(query) {
  const deals = await getAllDeals();
  const q = query.toLowerCase();

  // Try exact match first, then partial
  let match = deals.find((d) => d["Deal Name"].toLowerCase() === q);
  if (!match) {
    match = deals.find((d) => d["Deal Name"].toLowerCase().includes(q));
  }
  if (!match) {
    // Try matching on any field
    match = deals.find((d) => Object.values(d).some((v) => v.toLowerCase().includes(q)));
  }

  if (!match) {
    const names = deals.map((d) => d["Deal Name"]).join(", ");
    return { found: false, message: `No deal matching "${query}". Current deals: ${names}` };
  }

  return { found: true, deal: match };
}

// Update a deal field
async function updateDeal(dealName, field, value) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: "Pipeline!A1:L100",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return { error: "No data in pipeline sheet." };

  const headers = rows[0];
  const colIndex = headers.findIndex((h) => h.toLowerCase() === field.toLowerCase());
  if (colIndex === -1) {
    return { error: `Column "${field}" not found. Available: ${headers.join(", ")}` };
  }

  const q = dealName.toLowerCase();
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] && r[0].toLowerCase().includes(q));
  if (rowIndex === -1) {
    return { error: `Deal "${dealName}" not found.` };
  }

  const colLetter = String.fromCharCode(65 + colIndex);
  const range = `Pipeline!${colLetter}${rowIndex + 1}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[value]] },
  });

  return { success: true, deal: rows[rowIndex][0], field: headers[colIndex], value, range };
}

module.exports = {
  getAllDeals,
  getPipelineSummary,
  lookupDeal,
  updateDeal,
};
