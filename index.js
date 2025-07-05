import express from "express";
import { google } from "googleapis";
import fs from "fs";
import { FIELD_MAP } from "./fieldMap.js";

// ✅ Use secret file path for Render
const creds = JSON.parse(fs.readFileSync("/etc/secrets/credentials.json", "utf8"));

const app = express();
app.use(express.json());

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Shopify_Order_Data";

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

app.post("/jira-flow-b", async (req, res) => {
  try {
    const issue = req.body.issue;
    const fields = issue.fields;
    const summary = fields.summary;

    // Step 1: Find the matching row based on the summary (Column A)
    const dataRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:A100000`,
    });

    const rows = dataRes.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === summary);
    if (rowIndex === -1) return res.status(200).send("Row not found.");
    const rowNumber = rowIndex + 2;

    // Step 2: Get the header row (Row 1) to find where to write
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:AL1`,
    });
    const headers = headerRes.data.values[0];

    // Step 3: Prepare custom field updates
    const updates = [];

    for (const [fieldId, columnHeader] of Object.entries(FIELD_MAP)) {
      const colIndex = headers.indexOf(columnHeader);
      if (colIndex !== -1) {
        updates.push({
          range: `${SHEET_NAME}!${columnToLetter(colIndex + 1)}${rowNumber}`,
          values: [[fields[fieldId] || ""]],
        });
      }
    }

    // Step 4: Apply the updates
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: "RAW",
          data: updates,
        },
      });
    }

    res.status(200).send("Custom fields updated successfully.");
  } catch (err) {
    console.error("Webhook Error:", err.message);
    res.status(500).send("Internal server error.");
  }
});

app.get("/", (req, res) => res.send("Flow B live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// Helper to convert 1-based index to column letters (e.g., 1 → A, 27 → AA)
function columnToLetter(col) {
  let temp = "";
  while (col > 0) {
    let rem = (col - 1) % 26;
    temp = String.fromCharCode(65 + rem) + temp;
    col = Math.floor((col - 1) / 26);
  }
  return temp;
}