// Replace Market with County + State columns, add dropdowns
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

  // Get current headers to find Market column
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_STR,
    range: "Pipeline!1:1",
  });
  const headers = current.data.values[0];
  const marketIdx = headers.findIndex(h => h === "Market");

  if (marketIdx === -1) {
    console.error("Market column not found. Headers:", headers.join(", "));
    process.exit(1);
  }
  console.log(`Found Market at column index ${marketIdx} (col ${String.fromCharCode(65 + marketIdx)})`);

  // Step 1: Rename Market to County
  const colLetter = String.fromCharCode(65 + marketIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_STR,
    range: `Pipeline!${colLetter}1`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [["County"]] },
  });

  // Step 2: Insert State column right after County
  const stateIdx = marketIdx + 1;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: {
      requests: [
        {
          insertDimension: {
            range: { sheetId, dimension: "COLUMNS", startIndex: stateIdx, endIndex: stateIdx + 1 },
            inheritFromBefore: true,
          },
        },
      ],
    },
  });

  // Set State header
  const stateColLetter = String.fromCharCode(65 + stateIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_STR,
    range: `Pipeline!${stateColLetter}1`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [["State"]] },
  });

  // All counties combined
  const allCounties = [
    // Oregon (36)
    "Baker", "Benton", "Clackamas", "Clatsop", "Columbia", "Coos", "Crook",
    "Curry", "Deschutes", "Douglas", "Gilliam", "Grant", "Harney", "Hood River",
    "Jackson", "Jefferson", "Josephine", "Klamath", "Lake", "Lane", "Lincoln",
    "Linn", "Malheur", "Marion", "Morrow", "Multnomah", "Polk", "Sherman",
    "Tillamook", "Umatilla", "Union", "Wallowa", "Wasco", "Washington",
    "Wheeler", "Yamhill",
    // Washington (39)
    "Adams", "Asotin", "Chelan", "Clallam", "Clark", "Cowlitz",
    "Ferry", "Franklin", "Garfield", "Grays Harbor",
    "Island", "King", "Kitsap", "Kittitas", "Klickitat", "Lewis",
    "Mason", "Okanogan", "Pacific", "Pend Oreille", "Pierce",
    "San Juan", "Skagit", "Skamania", "Snohomish", "Spokane", "Stevens",
    "Thurston", "Wahkiakum", "Walla Walla", "Whatcom", "Whitman", "Yakima",
    // Idaho (44)
    "Ada", "Bannock", "Bear Lake", "Benewah", "Bingham", "Blaine",
    "Boise", "Bonner", "Bonneville", "Boundary", "Butte", "Camas", "Canyon",
    "Caribou", "Cassia", "Clearwater", "Custer", "Elmore",
    "Fremont", "Gem", "Gooding", "Idaho", "Jerome", "Kootenai",
    "Latah", "Lemhi", "Lyon", "Madison", "Minidoka", "Nez Perce",
    "Oneida", "Owyhee", "Payette", "Power", "Shoshone", "Teton", "Twin Falls",
    "Valley",
  ];

  // Dedupe and sort
  const uniqueCounties = [...new Set(allCounties)].sort();

  // Step 3: Add dropdowns
  const dataRows = 50;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: {
      requests: [
        // Column widths
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: marketIdx, endIndex: marketIdx + 1 }, properties: { pixelSize: 140 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: stateIdx, endIndex: stateIdx + 1 }, properties: { pixelSize: 100 }, fields: "pixelSize" } },

        // County dropdown
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: marketIdx, endColumnIndex: marketIdx + 1 },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: uniqueCounties.map(c => ({ userEnteredValue: c })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },

        // State dropdown
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: dataRows, startColumnIndex: stateIdx, endColumnIndex: stateIdx + 1 },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "Oregon" },
                  { userEnteredValue: "Washington" },
                  { userEnteredValue: "Idaho" },
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

  // Step 4: Try to migrate existing Market data to County/State
  const allData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_STR,
    range: "Pipeline!A2:Z50",
  });
  const rows = allData.data.values || [];

  // Map old market values to county/state
  const marketMap = {
    "La Pine, OR": { county: "Deschutes", state: "Oregon" },
    "Kitsap County, WA": { county: "Kitsap", state: "Washington" },
    "Boise, ID": { county: "Ada", state: "Idaho" },
    "Dayton, NV": { county: "Lyon", state: "Nevada" },
    "Idaho County": { county: "Idaho", state: "Idaho" },
    "WA": { county: "", state: "Washington" },
    "TBD": { county: "", state: "" },
  };

  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const countyVal = rows[i][marketIdx] || "";
    const mapped = marketMap[countyVal];
    if (mapped) {
      const rowNum = i + 2;
      updates.push({
        range: `Pipeline!${colLetter}${rowNum}`,
        values: [[mapped.county]],
      });
      updates.push({
        range: `Pipeline!${stateColLetter}${rowNum}`,
        values: [[mapped.state]],
      });
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID_STR,
      resource: {
        valueInputOption: "USER_ENTERED",
        data: updates,
      },
    });
    console.log(`Migrated ${updates.length / 2} rows from Market to County/State`);
  }

  console.log("\nDone:");
  console.log("- Renamed Market -> County");
  console.log("- Added State column");
  console.log(`- County dropdown: ${uniqueCounties.length} counties (OR + WA + ID)`);
  console.log("- State dropdown: Oregon, Washington, Idaho");
  console.log(`\nSheet: https://docs.google.com/spreadsheets/d/${SHEET_ID_STR}/edit`);
}

main().catch(console.error);
