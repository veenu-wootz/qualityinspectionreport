/**
 * server.js
 * QIR PDF Generation Server
 *
 * Single endpoint: POST /generate
 * Receives Clappia webhook → generates QIR PDF → fetches & merges cert PDFs
 * → emails final PDF to submitter + internal team
 *
 * Deploy on Render:
 *   1. Push this folder to a GitHub repo
 *   2. New Web Service on Render → connect repo
 *   3. Build command: npm install
 *   4. Start command: node server.js
 *   5. Add environment variables in Render dashboard
 */

require('dotenv').config();

const express = require('express');
const { generateQIR }     = require('./generateQIR');
const { buildMergedPDF }  = require('./mergePDFs');
const { sendQIREmail }    = require('./sendEmail');

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any origin (needed for local HTML file testing + Clappia)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Parse JSON bodies up to 50MB (base64 images can be large)
app.use(express.json({ limit: '50mb' }));

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'QIR Generator', version: '1.0.0' });
});

// ── Main endpoint ─────────────────────────────────────────────
/**
 * POST /generate
 *
 * Expected body from Clappia REST API action:
 * {
 *   // ── Report header ──
 *   "report_no":        "<<[report_no]>>",
 *   "submission_date":  "<<[$submission_date]>>",
 *   "your_email":       "<<[your_email]>>",       // Clappia submitter email
 *
 *   // ── Part info ──
 *   "part_name":   "<<[part_name]>>",
 *   "rm_grade":    "<<[rm_grade]>>",
 *   "customer":    "<<[customer]>>",
 *   "item_code":   "<<[item_code]>>",
 *   "heat_no":     "<<[heat_no]>>",
 *   "order_qty":   "<<[order_qty]>>",
 *   "remarks":     "<<[remarks]>>",
 *   "conclusion":  "<<[conclusion]>>",
 *
 *   // ── Images (base64 data URLs OR null) ──
 *   "part_drawing": "<<[part_drawi]>>",
 *   "insp_image":   null,
 *
 *   // ── Dimensional rows ──
 *   "sampleCount": 5,
 *   "dimRows": [
 *     {
 *       "index": 1,
 *       "parameter":  "<<[parameter#1]>>",
 *       "specificat": "<<[specificat#1]>>",
 *       "instrument": "<<[instrument#1]>>",
 *       "samples":    ["<<[sample_1#1]>>", "<<[sample_2#1]>>", ...],
 *       "status_1":   "<<[status_1#1]>>",
 *       "qc_photo":   "<<[qc_photo#1]>>"           // base64 or null
 *     },
 *     ...up to N rows
 *   ],
 *
 *   // ── Visual rows ──
 *   "visRows": [
 *     {
 *       "index":     1,
 *       "parameter": "<<[visual_inspection#1]>>",
 *       "status":    "<<[status_visual#1]>>",
 *       "comments":  "<<[comments#1]>>",
 *       "photo":     null
 *     },
 *     ...
 *   ],
 *
 *   // ── Certificate PDFs to merge (pre-signed S3 URLs from Clappia) ──
 *   // Must be fetched within 5 minutes of Clappia sending this webhook.
 *   "certificates": [
 *     { "label": "Mill TC",         "url": "https://s3.amazonaws.com/..." },
 *     { "label": "Hardness Report", "url": "https://s3.amazonaws.com/..." }
 *   ]
 * }
 */
app.post('/generate', async (req, res) => {
  const startTime = Date.now();
  const data = req.body;

  // Basic validation
  if (!data || !data.part_name) {
    return res.status(400).json({
      error: 'Invalid payload — at minimum part_name is required'
    });
  }

  const reportNo = data.report_no || `QIR-${new Date().getFullYear()}-XXXX`;
  const date     = data.submission_date || new Date().toISOString().split('T')[0];
  const filename = `QIR-${reportNo}-${date}.pdf`.replace(/[^a-zA-Z0-9\-_.]/g, '_');

  console.log(`\n── New report request ──────────────────────`);
  console.log(`  Report No:  ${reportNo}`);
  console.log(`  Part:       ${data.part_name}`);
  console.log(`  Submitter:  ${data.your_email || 'not provided'}`);
  console.log(`  Certs:      ${(data.certificates || []).length}`);

  try {

    // ── Step 1: Generate QIR PDF ────────────────────────────
    console.log('\n[1/3] Generating QIR PDF...');
    const qirBuffer = generateQIR(data);
    console.log(`  Done — ${(qirBuffer.length / 1024).toFixed(0)} KB`);

    // ── Step 2: Fetch certs + merge ─────────────────────────
    console.log('\n[2/3] Fetching certificates and merging...');
    const mergedBuffer = await buildMergedPDF(qirBuffer, data.certificates || []);
    console.log(`  Done — merged PDF: ${(mergedBuffer.length / 1024).toFixed(0)} KB`);

    // ── Step 3: Send email ───────────────────────────────────
    console.log('\n[3/3] Sending email...');
    await sendQIREmail(data, mergedBuffer, filename);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✓ Complete in ${elapsed}s — ${filename}`);
    console.log(`────────────────────────────────────────────\n`);

    res.json({
      success:  true,
      filename,
      elapsed:  `${elapsed}s`,
      pages:    'generated',
      certs:    (data.certificates || []).length,
    });

  } catch (err) {
    console.error(`\n✗ Error processing ${reportNo}:`, err);
    res.status(500).json({
      error:   err.message,
      report:  reportNo,
    });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nQIR Server running on port ${PORT}`);
  console.log(`POST http://localhost:${PORT}/generate`);
  console.log(`Health: http://localhost:${PORT}/\n`);

  // Warn about missing config on startup
  if (!process.env.GMAIL_USER)         console.warn('⚠  GMAIL_USER not set');
  if (!process.env.GMAIL_APP_PASSWORD) console.warn('⚠  GMAIL_APP_PASSWORD not set');
  if (!process.env.INTERNAL_EMAILS)    console.warn('⚠  INTERNAL_EMAILS not set');
});
