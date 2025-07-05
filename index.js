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

// Helper to convert column index to column letter (A, B, ..., Z, AA, AB, etc.)
function columnToLetter(col) {
  let letter = '';
  while (col >= 0) {
    letter = String.fromCharCode((col % 26) + 65) + letter;
    col = Math.floor(col / 26) - 1;
  }
  return letter;
}

// Helper to clean values
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

// Update multiple fields
async function updateSheet(rowNumber, updates) {
  for (const update of updates) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: update.range,
      valueInputOption: "RAW",
      requestBody: { values: [[update.value]] }
    });
  }
}

// Main webhook handler
app.post("/jira-flow-b", async (req, res) => {
  try {
    const issue = req.body.issue;
    const fields = issue.fields;
    const summary = (fields.summary || "").replace(/\s+/g, " ").trim();

    // Get headers
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:AZ1`
    });
    const headers = headerResp.data.values[0];

    // Get order numbers (column A)
    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:A30000`
    });
    const rows = dataResp.data.values || [];

    // Find matching row (ignoring extra spaces)
    let rowNumber = null;
    for (let i = 0; i < rows.length; i++) {
      const existing = (rows[i][0] || "").replace(/\s+/g, " ").trim();
      if (existing === summary) {
        rowNumber = i + 2;
        break;
      }
    }

    // If not found, append a new row
    if (!rowNumber) {
      rowNumber = rows.length + 2;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [[summary]] }
      });
    }

    // Prepare updates
    const updates = [];
    for (const [fieldId, config] of Object.entries(fieldMap)) {
      const colIndex = headers.indexOf(config.header);
      if (colIndex === -1) continue;

      const cleanValue = getCleanValue(fieldId, fields[fieldId]);
      const colLetter = columnToLetter(colIndex);
      updates.push({
        range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
        value: cleanValue
      });
    }

    await updateSheet(rowNumber, updates);

    console.log(`✅ Updated row ${rowNumber} for issue ${summary}`);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error processing webhook:", err);
    res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));