const express = require("express");
const { google } = require("googleapis");
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const fieldMap = require("./fieldMap");

const app = express();
app.use(express.json());

const SHEET_ID = "1XMdC59_ERNFTSesiQ3Tsqgh0aRsvMrru7sZVdIX5lcs";
const SHEET_NAME = "Shopify_Order_Data";

// Redis connection using Render env var
const redisConnection = new Redis(process.env.REDIS_URL);

// BullMQ queue setup
const updatesQueue = new Queue("sheetUpdates", { connection: redisConnection });

const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  keyFile: "/etc/secrets/credentials.json"
});
const sheets = google.sheets({ version: "v4", auth });

function getCleanValue(fieldId, rawValue) {
  if (!rawValue) return "";
  const type = fieldMap[fieldId]?.type;
  if (Array.isArray(rawValue)) return rawValue.map(v => v.value || "").join(", ");
  if (typeof rawValue === "object") return rawValue.value || "";
  return rawValue;
}

app.post("/jira-flow-b", async (req, res) => {
  try {
    const issue = req.body.issue;
    const fields = issue.fields;
    const summary = (fields.summary || "").replace(/\s+/g, "").trim();

    // Queue job
    await updatesQueue.add("update", { summary, fields });

    res.status(200).send("Update queued");
  } catch (err) {
    console.error("❌ Error queueing update:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Worker to process updates
new Worker("sheetUpdates", async job => {
  const { summary, fields } = job.data;

  // Fetch headers
  const headerResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:AZ1`
  });
  const headers = headerResp.data.values[0];

  // Fetch rows
  const dataResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:A30000`
  });
  const rows = dataResp.data.values;

  let rowNumber = null;
  if (rows) {
    for (let i = 0; i < rows.length; i++) {
      const val = (rows[i][0] || "").replace(/\s+/g, "").trim();
      if (val === summary) {
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

  // Prepare updates
  const data = Object.entries(fieldMap).map(([fieldId, config]) => {
    const colIndex = headers.indexOf(config.header);
    if (colIndex === -1) return null;
    const value = getCleanValue(fieldId, fields[fieldId]);
    return {
      range: `${SHEET_NAME}!${String.fromCharCode(65 + colIndex)}${rowNumber}`,
      values: [[value]]
    };
  }).filter(x => x);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data
    }
  });

  console.log(`✅ Updated row ${rowNumber} for ${summary}`);
}, { connection: redisConnection });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 App running on port ${PORT}`));
