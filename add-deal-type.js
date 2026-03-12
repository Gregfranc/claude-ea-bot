// Add Deal Type column with dropdown to pipeline sheet
require("dotenv").config();
const { google } = require("googleapis");

const SHEET_ID_STR = process.env.PIPELINE_SHEET_ID;

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

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID_STR });
  const sheetId = meta.data.sheets[0].properties.sheetId;

  // Insert column at index 2 (after Stage, before Market)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: {
      requests: [
        {
          insertDimension: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
            inheritFromBefore: true,
          },
        },
      ],
    },
  });

  // Set header
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_STR,
    range: "Pipeline!C1",
    valueInputOption: "USER_ENTERED",
    resource: { values: [["Deal Type"]] },
  });

  // Add dropdown and column width
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: {
      requests: [
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 140 }, fields: "pixelSize" } },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 50, startColumnIndex: 2, endColumnIndex: 3 },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "Flip" },
                  { userEnteredValue: "Small Subdivide" },
                  { userEnteredValue: "Large Subdivide" },
                ],
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ],
    },
  });

  console.log("Added Deal Type column with dropdown: Flip, Small Subdivide, Large Subdivide");
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID_STR}/edit`);
}

main().catch(console.error);
