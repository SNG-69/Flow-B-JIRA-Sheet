const express = require("express");
const { google } = require("googleapis");
const { Queue, Worker } = require("bullmq");
const fieldMap = require("./fieldMap");

const app = express();
app.use(express.json());

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;

const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  keyFile: "/etc/secrets/credentials.json"
});
const sheets = google.sheets({ version: "v4", auth });

// Debug Redis URL
console.log("🔑 Using Redis URL:", process.env.REDIS_URL);

// Redis connection config
const connection = {
  url: process.env.REDIS_URL,
  maxRetriesPerRequest: null,
  tls: {}  // ✅ Needed for Redis Cloud (rediss://)
};

// BullMQ queue
const updateQueue = new Queue("jira-flow-b", { connection });

// Helper: clean field value
function getCleanValue(fieldId, rawValue) {
  if (!rawValue) return "";
  if (Array.isArray(rawValue)) {
    return rawValue.map(v => v.value || "").join(", ");
  }
  if (typeof rawValue === "object") {
    return rawValue.value || "";
  }
  return rawValue;
}

// Helper: update Google Sheet
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

// POST: add job to queue
app.post("/jira-flow-b", async (req, res) => {
  try {
    await updateQueue.add("update-job", req.body);
    res.status(200).send("Job queued");
  } catch (err) {
    console.error("❌ Failed to queue job:", err);
    res.status(500).send("Failed to queue job");
  }
});

// Worker: process jobs
new Worker(
  "jira-flow-b",
  async job => {
    const issue = job.data.issue;
    const fields = issue.fields;
    const originalSummary = (fields.summary || "").trim();
    const normalizedSummary = originalSummary.replace(/\s+/g, "");

    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:AZ1`
    });
    const headers = headerResp.data.values[0];

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

    if (!rowNumber) {
      rowNumber = rows.length + 2;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [[originalSummary]] }
      });
    }

    const updates = [];
    for (const [fieldId, config] of Object.entries(fieldMap)) {
      const colIndex = headers.indexOf(config.header);
      if (colIndex === -1) continue;

      const cleanValue = getCleanValue(fieldId, fields[fieldId]);
      const colLetter = getColumnLetter(colIndex + 1);

      updates.push({
        range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
        value: cleanValue
      });
    }

    await updateSheet(rowNumber, updates);
    console.log(`✅ Updated row ${rowNumber} for issue ${originalSummary}`);
  },
  { connection }
);

// Helper: convert column index to letter
function getColumnLetter(colNum) {
  let letter = "";
  while (colNum > 0) {
    let rem = (colNum - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    colNum = Math.floor((colNum - 1) / 26);
  }
  return letter;
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 App running on port ${PORT}`);
});