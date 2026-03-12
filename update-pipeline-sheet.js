// Update existing pipeline sheet: add dropdowns, Projected Sale Price column
// Run: node update-pipeline-sheet.js

require("dotenv").config();
const { google } = require("googleapis");

const SHEET_ID_STR = process.env.PIPELINE_SHEET_ID;
if (!SHEET_ID_STR) { console.error("PIPELINE_SHEET_ID not set"); process.exit(1); }

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

  // First get the sheet's numeric ID
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID_STR });
  const sheetId = meta.data.sheets[0].properties.sheetId;

  // Get current data to find row count
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_STR,
    range: "Pipeline!A1:L100",
  });
  const rowCount = (current.data.values || []).length;
  const dataRows = Math.max(rowCount, 50); // apply validation to at least 50 rows

  // Read current headers
  const headers = current.data.values[0];
  console.log("Current headers:", headers.join(", "));

  // Insert "Projected Sale" column after "Projected Gross" (index 5 = col F, so insert at index 6)
  // Current: A=Deal Name, B=Stage, C=Market, D=Rep, E=Purchase Price, F=Projected Gross, G=Contract Signed...
  // New:     A=Deal Name, B=Stage, C=Market, D=Rep, E=Purchase Price, F=Projected Sale, G=Projected Gross, H=Contract Signed...

  const requests = [
    // Insert column at index 5 (after Purchase Price, before Projected Gross)
    {
      insertDimension: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 },
        inheritFromBefore: true,
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID_STR, resource: { requests } });

  // Set the new column header
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_STR,
    range: "Pipeline!F1",
    valueInputOption: "USER_ENTERED",
    resource: { values: [["Projected Sale"]] },
  });

  // Set column width for new column
  const requests2 = [
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 130 }, fields: "pixelSize" } },

    // Stage dropdown (col B = index 1)
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: "Lead" },
              { userEnteredValue: "Offer Sent" },
              { userEnteredValue: "Pending Signature" },
              { userEnteredValue: "Contract Signed" },
              { userEnteredValue: "Due Diligence" },
              { userEnteredValue: "Listed" },
              { userEnteredValue: "Escrow Open" },
              { userEnteredValue: "Closing" },
              { userEnteredValue: "Entitlement" },
              { userEnteredValue: "Active" },
              { userEnteredValue: "Closed" },
              { userEnteredValue: "Cancelled" },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },

    // Rep dropdown (col D = index 3)
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: 3, endColumnIndex: 4 },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: "Greg" },
              { userEnteredValue: "Brian Chaplin" },
              { userEnteredValue: "Rachel Rife" },
              { userEnteredValue: "Marwan Mousa" },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },

    // Priority dropdown (col K = index 10, shifted by 1 from the insert)
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: 10, endColumnIndex: 11 },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: "URGENT" },
              { userEnteredValue: "HIGH" },
              { userEnteredValue: "MEDIUM" },
              { userEnteredValue: "LOW" },
              { userEnteredValue: "LONG-TERM" },
              { userEnteredValue: "TBD" },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },

    // Format currency columns (E=Purchase Price, F=Projected Sale, G=Projected Gross)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: 4, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "CURRENCY", pattern: "$#,##0" },
          },
        },
        fields: "userEnteredFormat.numberFormat",
      },
    },

    // Format date columns (H=Contract Signed, I=Feasibility Ends, J=Close Date)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: 7, endColumnIndex: 10 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" },
          },
        },
        fields: "userEnteredFormat.numberFormat",
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID_STR, resource: { requests: requests2 } });

  console.log("\nUpdated pipeline sheet:");
  console.log("- Added 'Projected Sale' column");
  console.log("- Stage dropdown: Lead, Offer Sent, Pending Signature, Contract Signed, Due Diligence, Listed, Escrow Open, Closing, Entitlement, Active, Closed, Cancelled");
  console.log("- Rep dropdown: Greg, Brian Chaplin, Rachel Rife, Marwan Mousa");
  console.log("- Priority dropdown: URGENT, HIGH, MEDIUM, LOW, LONG-TERM, TBD");
  console.log("- Currency formatting on price columns");
  console.log("- Date formatting on date columns");
  console.log(`\nSheet: https://docs.google.com/spreadsheets/d/${SHEET_ID_STR}/edit`);
}

main().catch(console.error);
