const express = require("express");
const { google } = require("googleapis");
const fieldMap = require("./fieldMap");
const app = express();

app.use(express.json());

const SHEET_ID = "1XMdC59_ERNFTSesiQ3Tsqgh0aRsvMrru7sZVdIX5lcs";
const SHEET_NAME = "Shopify_Order_Data";

const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  keyFile: "/etc/secrets/credentials.json"
});

const sheets = google.sheets({ version: "v4", auth });

function getCleanValue(fieldId, rawValue) {
  if (!rawValue) return "";
  const type = fieldMap[fieldId]?.type;

  if (Array.isArray(rawValue)) {
    return rawValue.map(v => v.value || "").join(", ");
  }

  if (typeof rawValue === "object") {
    return rawValue.value || "";
  }

  return rawValue;
}

async function updateSheet(rowNumber, updates) {
  const requests = updates.map(update => ({
    range: update.range,
    values: [[update.value]]
  }));

  for (const req of requests) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: req.range,
      valueInputOption: "RAW",
      requestBody: { values: req.values }
    });
  }
}

app.post("/jira-flow-b", async (req, res) => {
  try {
    const issue = req.body.issue;
    const fields = issue.fields;
    const originalSummary = (fields.summary || "").trim();
    const normalizedSummary = originalSummary.replace(/\s+/g, "");

    // Get headers
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:AZ1`
    });
    const headers = headerResp.data.values[0];

    // Get existing rows (Order Numbers / Summaries)
    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:A30000`
    });
    const rows = dataResp.data.values || [];

    let rowNumber = null;
    for (let i = 0; i < rows.length; i++) {
      const sheetValue = (rows[i][0] || "").replace(/\s+/g, "").trim();
      if (sheetValue === normalizedSummary) {
        rowNumber = i + 2;
        break;
      }
    }

    // If no match, append new row
    if (!rowNumber) {
      rowNumber = rows.length + 2;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [[originalSummary]] }
      });
    }

    // Build updates
    const updates = [];
    for (const [fieldId, config] of Object.entries(fieldMap)) {
      const colIndex = headers.indexOf(config.header);
      if (colIndex === -1) continue;

      const rawValue = fields[fieldId];
      const cleanValue = getCleanValue(fieldId, rawValue);

      const colLetter = getColumnLetter(colIndex + 1);
      updates.push({
        range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
        value: cleanValue
      });
    }

    await updateSheet(rowNumber, updates);

    console.log(`✅ Updated row ${rowNumber} for issue ${originalSummary}`);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error processing webhook:", err);
    res.status(500).send("Internal Server Error");
  }
});

function getColumnLetter(colNum) {
  let letter = "";
  while (colNum > 0) {
    let remainder = (colNum - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    colNum = Math.floor((colNum - 1) / 26);
  }
  return letter;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));