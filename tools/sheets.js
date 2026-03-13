// Google Sheets read/write tool
// Allows the bot to read and write any Google Sheet by URL or ID

const { google } = require("googleapis");

function getAuthedClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return auth;
}

function getSheets() {
  return google.sheets({ version: "v4", auth: getAuthedClient() });
}

// Extract spreadsheet ID from URL or return as-is if already an ID
function parseSpreadsheetId(urlOrId) {
  if (!urlOrId) return null;
  // Match Google Sheets URL pattern
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Already an ID (no slashes)
  if (!urlOrId.includes("/")) return urlOrId;
  return null;
}

// Get spreadsheet metadata (title, sheet names)
async function getSpreadsheetInfo(urlOrId) {
  const spreadsheetId = parseSpreadsheetId(urlOrId);
  if (!spreadsheetId) return { error: "Invalid spreadsheet URL or ID." };

  const sheets = getSheets();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties",
  });

  const sheetNames = res.data.sheets.map((s) => ({
    name: s.properties.title,
    index: s.properties.index,
    rowCount: s.properties.gridProperties.rowCount,
    colCount: s.properties.gridProperties.columnCount,
  }));

  return {
    title: res.data.properties.title,
    spreadsheetId,
    sheets: sheetNames,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

// Read a range from a spreadsheet. Returns headers + rows as objects.
async function readSheet(urlOrId, range) {
  const spreadsheetId = parseSpreadsheetId(urlOrId);
  if (!spreadsheetId) return { error: "Invalid spreadsheet URL or ID." };

  const sheets = getSheets();

  // If no range, read first sheet entirely
  if (!range) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });
    const firstSheet = meta.data.sheets[0]?.properties?.title || "Sheet1";
    range = `'${firstSheet}'`;
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return { data: [], message: "Sheet is empty." };

  // First row as headers, rest as data objects
  const headers = rows[0];
  const data = rows.slice(1).map((row, i) => {
    const obj = { _row: i + 2 }; // 1-indexed, +1 for header
    headers.forEach((h, j) => {
      obj[h] = row[j] || "";
    });
    return obj;
  });

  return {
    spreadsheetId,
    range: res.data.range,
    headers,
    rowCount: data.length,
    data,
  };
}

// Write values to a specific range
async function writeSheet(urlOrId, range, values) {
  const spreadsheetId = parseSpreadsheetId(urlOrId);
  if (!spreadsheetId) return { error: "Invalid spreadsheet URL or ID." };

  if (!range) return { error: "Range is required (e.g. 'Sheet1!A1:D5')." };
  if (!values || !Array.isArray(values) || values.length === 0) {
    return { error: "Values must be a non-empty array of arrays." };
  }

  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });

  return {
    spreadsheetId,
    updatedRange: res.data.updatedRange,
    updatedRows: res.data.updatedRows,
    updatedColumns: res.data.updatedColumns,
    updatedCells: res.data.updatedCells,
  };
}

// Append rows to the end of a sheet
async function appendSheet(urlOrId, range, values) {
  const spreadsheetId = parseSpreadsheetId(urlOrId);
  if (!spreadsheetId) return { error: "Invalid spreadsheet URL or ID." };

  if (!range) return { error: "Range is required (e.g. 'Sheet1!A:Z')." };
  if (!values || !Array.isArray(values) || values.length === 0) {
    return { error: "Values must be a non-empty array of arrays." };
  }

  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values },
  });

  return {
    spreadsheetId,
    updatedRange: res.data.updates?.updatedRange,
    updatedRows: res.data.updates?.updatedRows,
    updatedCells: res.data.updates?.updatedCells,
  };
}

// Create a new spreadsheet, returns { spreadsheetId, url }
async function createSpreadsheet(title, headers) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.create({
    resource: {
      properties: { title },
      sheets: [
        {
          properties: { title: "Sheet1" },
          data: headers
            ? [{ startRow: 0, startColumn: 0, rowData: [{ values: headers.map((h) => ({ userEnteredValue: { stringValue: h } })) }] }]
            : undefined,
        },
      ],
    },
  });
  return {
    spreadsheetId: res.data.spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${res.data.spreadsheetId}/edit`,
  };
}

module.exports = {
  parseSpreadsheetId,
  getSpreadsheetInfo,
  readSheet,
  writeSheet,
  appendSheet,
  createSpreadsheet,
};
