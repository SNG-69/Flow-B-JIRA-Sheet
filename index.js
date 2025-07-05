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
    if (type === "multi" || type === "single") {
      return rawValue.value || "";
    }
    return rawValue.value || "";
  }

  return rawValue;
}

// 👉 NEW: String cleaner to normalize summary/order numbers
function cleanString(str) {
  return (str || "")
    .replace(/\u200B/g, "")      // Remove zero-width spaces
    .replace(/\u00A0/g, "")      // Remove non-breaking spaces
    .replace(/\s+/g, " ")        // Replace multiple spaces with single space
    .trim()                      // Trim leading/trailing spaces
    .toUpperCase();              // Make case-insensitive (optional)
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
    const summary = (fields.summary || "");
    const cleanSummary = cleanString(summary);

    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:AZ1`
    });
    const headers = headerResp.data.values[0];

    const dataResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:A30000`
    });
    const rows = dataResp.data.values;

    let rowNumber = null;
    if (rows) {
      for (let i = 0; i < rows.length; i++) {
        const cellValue = cleanString(rows[i][0]);
        if (cellValue === cleanSummary) {
          rowNumber = i + 2;
          break;
        }
      }
    }

    if (!rowNumber) {
      rowNumber = rows.length + 2;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [[summary]] }
      });
    }

    const updates = [];
    for (const [fieldId, config] of Object.entries(fieldMap)) {
      const colIndex = headers.indexOf(config.header);
      if (colIndex === -1) continue;

      const rawValue = fields[fieldId];
      const cleanValue = getCleanValue(fieldId, rawValue);

      updates.push({
        range: `${SHEET_NAME}!${String.fromCharCode(65 + colIndex)}${rowNumber}`,
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