// Add filter view to pipeline sheet
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

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: {
      requests: [
        {
          setBasicFilter: {
            filter: {
              range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 13 },
            },
          },
        },
      ],
    },
  });

  console.log("Filter arrows added to all column headers.");
  console.log(`Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID_STR}/edit`);
}

main().catch(console.error);
