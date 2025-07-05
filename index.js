import express from "express";
import { google } from "googleapis";
import fs from "fs";
import { FIELD_MAP } from "./fieldMap.js";

// ✅ Updated path for Render secret file
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

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:A1000`,
    });

    const rows = result.data.values;
    const rowIndex = rows.findIndex(row => row[0] === summary);

    if (rowIndex === -1) return res.status(200).send("Row not found.");
    const rowNumber = rowIndex + 2;

    const updates = Object.keys(FIELD_MAP).map((fieldId, i) => ({
      range: `${SHEET_NAME}!${String.fromCharCode(86 + i)}${rowNumber}`, // V onwards
      values: [[fields[fieldId] || ""]],
    }));

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });

    res.status(200).send("Updated custom fields successfully.");
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).send("Internal server error.");
  }
});

app.get("/", (req, res) => res.send("Flow B live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
