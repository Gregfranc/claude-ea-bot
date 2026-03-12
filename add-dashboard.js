// Add Dashboard tab to pipeline sheet
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

  // First get current headers to map columns correctly
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_STR,
    range: "Pipeline!1:1",
  });
  const headers = current.data.values[0];
  console.log("Current headers:", headers.join(", "));

  // Find column letters
  const colOf = (name) => {
    const idx = headers.findIndex(h => h === name);
    if (idx === -1) throw new Error(`Column "${name}" not found`);
    return String.fromCharCode(65 + idx);
  };

  const stageCol = colOf("Stage");
  const dealTypeCol = colOf("Deal Type");
  const stateCol = colOf("State");
  const countyCol = colOf("County");
  const repCol = colOf("Rep");
  const priorityCol = colOf("Priority");
  const purchaseCol = colOf("Purchase Price");
  const projSaleCol = colOf("Projected Sale");
  const projGrossCol = colOf("Projected Gross");
  const closeDateCol = colOf("Close Date");
  const dealNameCol = "A";

  console.log(`Columns: Stage=${stageCol}, DealType=${dealTypeCol}, State=${stateCol}, County=${countyCol}, Rep=${repCol}, Priority=${priorityCol}, Purchase=${purchaseCol}, ProjSale=${projSaleCol}, ProjGross=${projGrossCol}, Close=${closeDateCol}`);

  // Add Dashboard sheet
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID_STR });
  const existingSheets = meta.data.sheets.map(s => s.properties.title);

  if (existingSheets.includes("Dashboard")) {
    console.log("Dashboard sheet already exists, deleting and recreating...");
    const dashSheet = meta.data.sheets.find(s => s.properties.title === "Dashboard");
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID_STR,
      resource: { requests: [{ deleteSheet: { sheetId: dashSheet.properties.sheetId } }] },
    });
  }

  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: {
      requests: [
        { addSheet: { properties: { title: "Dashboard", gridProperties: { frozenRowCount: 0 } } } },
      ],
    },
  });
  const dashSheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  const P = "Pipeline";
  const lastRow = 100;

  // Build dashboard content
  const values = [
    // Row 1: Title
    ["GF DEVELOPMENT — PIPELINE DASHBOARD", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", ""],

    // Row 3-4: Summary KPIs
    ["PIPELINE SUMMARY", "", "", "", "REVENUE PROJECTIONS", "", "", "", ""],
    [
      "Total Deals",
      `=COUNTA(${P}!${dealNameCol}2:${dealNameCol}${lastRow})`,
      "",
      "",
      "Total Purchase Price",
      `=SUM(${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      "",
      "",
      "",
    ],
    [
      "Active Deals",
      `=COUNTA(${P}!${dealNameCol}2:${dealNameCol}${lastRow})-COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closed")-COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Cancelled")`,
      "",
      "",
      "Total Projected Sale",
      `=SUM(${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      "",
      "",
      "",
    ],
    [
      "Closed Deals",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closed")`,
      "",
      "",
      "Total Projected Gross",
      `=SUM(${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "",
      "",
      "",
    ],
    [
      "Cancelled Deals",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Cancelled")`,
      "",
      "",
      "Avg Projected Gross",
      `=IFERROR(AVERAGE(${P}!${projGrossCol}2:${projGrossCol}${lastRow}),0)`,
      "",
      "",
      "",
    ],
    ["", "", "", "", "", "", "", "", ""],

    // Row 9: By Stage
    ["DEALS BY STAGE", "", "COUNT", "TOTAL PURCHASE", "TOTAL PROJ SALE", "TOTAL PROJ GROSS", "", "", ""],
    [
      "", "Lead",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Lead")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Lead",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Lead",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Lead",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Offer Sent",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Offer Sent")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Offer Sent",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Offer Sent",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Offer Sent",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Pending Signature",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Pending Signature")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Pending Signature",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Pending Signature",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Pending Signature",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Contract Signed",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Contract Signed")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Contract Signed",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Contract Signed",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Contract Signed",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Due Diligence",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Due Diligence")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Due Diligence",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Due Diligence",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Due Diligence",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Listed",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Listed")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Listed",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Listed",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Listed",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Escrow Open",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Escrow Open")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Escrow Open",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Escrow Open",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Escrow Open",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Closing",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closing")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closing",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closing",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closing",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Entitlement",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Entitlement")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Entitlement",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Entitlement",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Entitlement",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Closed",
      `=COUNTIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closed")`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closed",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closed",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stageCol}2:${stageCol}${lastRow},"Closed",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    ["", "", "", "", "", "", "", "", ""],

    // By Deal Type
    ["DEALS BY TYPE", "", "COUNT", "TOTAL PURCHASE", "TOTAL PROJ SALE", "TOTAL PROJ GROSS", "", "", ""],
    [
      "", "Flip",
      `=COUNTIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Flip")`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Flip",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Flip",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Flip",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Small Subdivide",
      `=COUNTIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Small Subdivide")`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Small Subdivide",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Small Subdivide",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Small Subdivide",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Large Subdivide",
      `=COUNTIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Large Subdivide")`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Large Subdivide",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Large Subdivide",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${dealTypeCol}2:${dealTypeCol}${lastRow},"Large Subdivide",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    ["", "", "", "", "", "", "", "", ""],

    // By Rep
    ["DEALS BY REP", "", "COUNT", "TOTAL PURCHASE", "TOTAL PROJ SALE", "TOTAL PROJ GROSS", "", "", ""],
    [
      "", "Greg",
      `=COUNTIF(${P}!${repCol}2:${repCol}${lastRow},"Greg")`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Greg",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Greg",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Greg",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Brian Chaplin",
      `=COUNTIF(${P}!${repCol}2:${repCol}${lastRow},"Brian Chaplin")`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Brian Chaplin",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Brian Chaplin",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Brian Chaplin",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Rachel Rife",
      `=COUNTIF(${P}!${repCol}2:${repCol}${lastRow},"Rachel Rife")`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Rachel Rife",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Rachel Rife",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${repCol}2:${repCol}${lastRow},"Rachel Rife",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    ["", "", "", "", "", "", "", "", ""],

    // By State
    ["DEALS BY STATE", "", "COUNT", "TOTAL PURCHASE", "TOTAL PROJ SALE", "TOTAL PROJ GROSS", "", "", ""],
    [
      "", "Oregon",
      `=COUNTIF(${P}!${stateCol}2:${stateCol}${lastRow},"Oregon")`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Oregon",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Oregon",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Oregon",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Washington",
      `=COUNTIF(${P}!${stateCol}2:${stateCol}${lastRow},"Washington")`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Washington",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Washington",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Washington",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "Idaho",
      `=COUNTIF(${P}!${stateCol}2:${stateCol}${lastRow},"Idaho")`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Idaho",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Idaho",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${stateCol}2:${stateCol}${lastRow},"Idaho",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    ["", "", "", "", "", "", "", "", ""],

    // By Priority
    ["DEALS BY PRIORITY", "", "COUNT", "TOTAL PURCHASE", "TOTAL PROJ SALE", "TOTAL PROJ GROSS", "", "", ""],
    [
      "", "URGENT",
      `=COUNTIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"URGENT")`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"URGENT",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"URGENT",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"URGENT",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "HIGH",
      `=COUNTIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"HIGH")`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"HIGH",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"HIGH",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"HIGH",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "MEDIUM",
      `=COUNTIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"MEDIUM")`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"MEDIUM",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"MEDIUM",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"MEDIUM",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    [
      "", "LONG-TERM",
      `=COUNTIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"LONG-TERM")`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"LONG-TERM",${P}!${purchaseCol}2:${purchaseCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"LONG-TERM",${P}!${projSaleCol}2:${projSaleCol}${lastRow})`,
      `=SUMIF(${P}!${priorityCol}2:${priorityCol}${lastRow},"LONG-TERM",${P}!${projGrossCol}2:${projGrossCol}${lastRow})`,
      "", "", "",
    ],
    ["", "", "", "", "", "", "", "", ""],

    // Upcoming Closings
    ["UPCOMING CLOSINGS (next 90 days)", "", "", "", "", "", "", "", ""],
    [
      "Deal", "Stage", "Close Date", "Projected Gross", "Days Until Close", "", "", "", "",
    ],
    [
      `=IFERROR(SORT(FILTER(${P}!${dealNameCol}2:${dealNameCol}${lastRow}, ${P}!${closeDateCol}2:${closeDateCol}${lastRow}<>""`, "", "", "", "", "", "", "", "",
    ],
  ];

  // Remove the incomplete SORT/FILTER row and replace with a simpler approach
  values.pop();
  // We'll add the upcoming closings section as a note
  values.push(["(Sort Pipeline tab by Close Date to see upcoming closings)", "", "", "", "", "", "", "", ""]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_STR,
    range: "Dashboard!A1",
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });

  // Format the dashboard
  const formatRequests = [
    // Title row
    {
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.1, green: 0.1, blue: 0.1 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 16 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    // Section headers (rows 3, 9, 22, 27, 32, 37, 42)
    ...[2, 8, 21, 26, 31, 36, 41, 46].map(row => ({
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: row, endRowIndex: row + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.2, green: 0.3, blue: 0.5 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    })),
    // KPI values bold
    {
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: 3, endRowIndex: 7, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: 3, endRowIndex: 7, startColumnIndex: 5, endColumnIndex: 6 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 }, numberFormat: { type: "CURRENCY", pattern: "$#,##0" } } },
        fields: "userEnteredFormat(textFormat,numberFormat)",
      },
    },
    // Currency formatting on dollar columns in breakdowns (cols D, E, F = 3,4,5)
    {
      repeatCell: {
        range: { sheetId: dashSheetId, startRowIndex: 8, endRowIndex: 50, startColumnIndex: 3, endColumnIndex: 6 },
        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    // Column widths
    { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 200 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 160 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 80 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 140 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 160 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashSheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 140 }, fields: "pixelSize" } },
    // Merge title
    { mergeCells: { range: { sheetId: dashSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 }, mergeType: "MERGE_ALL" } },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_STR,
    resource: { requests: formatRequests },
  });

  console.log("\nDashboard tab created with:");
  console.log("- Pipeline Summary (total deals, active, closed, cancelled)");
  console.log("- Revenue Projections (total purchase, sale, gross, avg gross)");
  console.log("- Deals by Stage (count + dollars per stage)");
  console.log("- Deals by Type (Flip, Small Subdivide, Large Subdivide)");
  console.log("- Deals by Rep (Greg, Brian, Rachel)");
  console.log("- Deals by State (Oregon, Washington, Idaho)");
  console.log("- Deals by Priority (Urgent, High, Medium, Long-term)");
  console.log(`\nSheet: https://docs.google.com/spreadsheets/d/${SHEET_ID_STR}/edit#gid=${dashSheetId}`);
}

main().catch(console.error);
