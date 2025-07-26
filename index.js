const express = require("express");
const { google } = require("googleapis");
const { Queue, Worker } = require("bullmq");
const fieldMap = require("./fieldMap");

const app = express();
app.use(express.json());

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  keyFile: "/etc/secrets/credentials.json"
});
const sheets = google.sheets({ version: "v4", auth });

// Redis connection config
const connection = {
  host: "redis-18864.c82.us-east-1-2.ec2.redns.redis-cloud.com",
  port: 18864,
  username: "default",
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null
};

// ✅ Queue with job cleanup to prevent Redis OOM
const updateQueue = new Queue("jira-flow-b", {
  connection,
  defaultJobOptions: {
    removeOnComplete: {
      age: 1800, // 30 minutes
      count: 500
    },
    removeOnFail: {
      age: 3600, // 1 hour
      count: 100
    }
  }
});

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

// Worker: process jobs and auto-clean memory
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
      console.log(`❌ Summary "${originalSummary}" not found in sheet. Skipping update.`);
      return;
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
  {
    connection,
    removeOnComplete: {
      age: 1800,
      count: 500
    },
    removeOnFail: {
      age: 3600,
      count: 100
    }
  }
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
