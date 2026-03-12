// One-time script to create the pipeline Google Sheet
// Run: node setup-pipeline-sheet.js

require("dotenv").config();
const { google } = require("googleapis");

function getAuthedClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function main() {
  const auth = getAuthedClient();
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  // Create the spreadsheet
  const spreadsheet = await sheets.spreadsheets.create({
    resource: {
      properties: { title: "GF Development — Deal Pipeline" },
      sheets: [
        {
          properties: {
            title: "Pipeline",
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    },
  });

  const spreadsheetId = spreadsheet.data.spreadsheetId;
  const sheetId = spreadsheet.data.sheets[0].properties.sheetId;
  console.log(`Created spreadsheet: ${spreadsheetId}`);

  // Set column widths and formatting
  const requests = [
    // Header formatting
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
      },
    },
    // Set row height for header
    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 40 }, fields: "pixelSize" } },
    // Column widths
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 180 }, fields: "pixelSize" } },  // Deal Name
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 120 }, fields: "pixelSize" } },  // Stage
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 120 }, fields: "pixelSize" } },  // Market
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 110 }, fields: "pixelSize" } },  // Rep
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },  // Purchase Price
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },  // Projected Gross
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },  // Contract Signed
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },  // Feasibility Ends
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },  // Close Date
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 }, properties: { pixelSize: 120 }, fields: "pixelSize" } }, // Priority
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 11 }, properties: { pixelSize: 250 }, fields: "pixelSize" } }, // Next Action
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 11, endIndex: 12 }, properties: { pixelSize: 300 }, fields: "pixelSize" } }, // Notes
    // Alternating row colors
    { addBanding: { bandedRange: { bandedRangeId: 1, range: { sheetId, startRowIndex: 1 }, rowProperties: { firstBandColor: { red: 1, green: 1, blue: 1 }, secondBandColor: { red: 0.95, green: 0.95, blue: 0.97 } } } } },
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });

  // Populate with data
  const values = [
    ["Deal Name", "Stage", "Market", "Rep", "Purchase Price", "Projected Gross", "Contract Signed", "Feasibility Ends", "Close Date", "Priority", "Next Action", "Notes"],
    ["WASem Lot 3", "Closing", "WA", "Greg", "", "", "", "", "Apr 2026", "HIGH", "Confirm exact close date", "Contingencies removed. Buyer inspection 3/9 complete."],
    ["Cumley — La Pine", "Contract Signed", "La Pine, OR", "Brian Chaplin", "", "", "2026-03-11", "", "", "HIGH", "List by 3/17", "Cash flow deal. Part of La Pine package."],
    ["Forest — La Pine", "Contract Signed", "La Pine, OR", "Brian Chaplin", "", "", "2026-03-11", "", "", "HIGH", "List by 3/17", "Cash flow deal. Part of La Pine package."],
    ["Sims — La Pine", "Pending Signature", "La Pine, OR", "Brian Chaplin", "$300,000", "$200,000", "", "", "", "HIGH", "Get contract signed", "2 lots, split to 5. Brian following up."],
    ["Tomi Coffer", "Contract Signed", "Kitsap County, WA", "Brian Chaplin", "$125,000", "", "2026-03-11", "2026-06-09", "2026-07-09", "MEDIUM", "Schedule pre-app meeting with county", "1.82 ac. Subdivide play. Need easement + utilities."],
    ["Sage Creek", "Listed", "TBD", "Greg", "", "$25,000", "", "", "", "MEDIUM", "Monitor for offers", "Zero movement. Listed."],
    ["Traditions North", "Entitlement", "Dayton, NV", "Greg", "", "", "", "", "", "LONG-TERM", "Advance entitlement", "Primary long-term value play."],
    ["Brio Vista", "Entitlement", "Boise, ID", "Greg", "", "", "", "", "", "LONG-TERM", "Advance entitlement", "IRA-structured. Lennar LOI meeting 3/9."],
    ["Columbia View Estates", "Active", "Boise, ID", "Greg", "", "", "", "", "", "TBD", "Update status", "Details pending sync."],
    ["Idaho County 154ac", "Active", "Idaho County", "Greg", "", "", "", "", "", "TBD", "Update status", "Seller-financed. Details pending sync."],
    ["Wymore", "Contract Signed", "", "Brian Chaplin", "", "", "", "", "2026-03-19", "", "", "From GHL pipeline"],
    ["Innes", "Contract Signed", "", "Brian Chaplin", "", "", "", "", "2026-06-02", "", "", "From GHL pipeline"],
    ["Standridge", "Escrow Open", "", "Brian Chaplin", "", "", "", "", "2026-03-30", "", "", "From GHL pipeline"],
    ["Rudek", "Listed", "", "Brian Chaplin", "", "$10,000", "", "", "2026-07-03", "", "", "From GHL pipeline"],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Pipeline!A1",
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });

  // Make it accessible to anyone with the link
  await drive.permissions.create({
    fileId: spreadsheetId,
    resource: {
      type: "anyone",
      role: "writer",
    },
  });

  const fileInfo = await drive.files.get({
    fileId: spreadsheetId,
    fields: "webViewLink",
  });

  console.log(`\nPipeline Sheet created and shared!`);
  console.log(`Link: ${fileInfo.data.webViewLink}`);
  console.log(`\nAnyone with the link can edit.`);
  console.log(`Spreadsheet ID: ${spreadsheetId}`);
  console.log(`\nAdd this to your .env:`);
  console.log(`PIPELINE_SHEET_ID=${spreadsheetId}`);
}

main().catch(console.error);
