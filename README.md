# QIR Server

Receives a Clappia webhook, generates the Quality Inspection Report PDF,
merges certificate PDFs from S3 URLs, and emails the final PDF to the
submitter and internal team.

---

## Deploy on Render (10 minutes)

1. Push this folder to a GitHub repo (can be private)
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Instance type:** Free (or Starter $7/mo for no spin-down)
5. Add environment variables (see below)
6. Deploy — Render gives you a URL like `https://qir-server.onrender.com`

---

## Environment Variables

Set these in Render dashboard → Environment:

| Variable | Value |
|---|---|
| `GMAIL_USER` | `your-service@gmail.com` |
| `GMAIL_APP_PASSWORD` | 16-char app password from Google |
| `INTERNAL_EMAILS` | `team@co.com,manager@co.com` |
| `PORT` | `3000` (Render sets this automatically) |

### Getting a Gmail App Password
1. Google Account → Security
2. Enable 2-Step Verification (required)
3. Security → App Passwords → Generate
4. Select "Mail" + "Other" → copy the 16-char password

---

## Clappia Setup

### 1. REST API Action

In your Clappia form → Integrations → REST API Action:

- **URL:** `https://your-app.onrender.com/generate`
- **Method:** POST
- **Headers:** `Content-Type: application/json`
- **Trigger:** On form submission

### 2. JSON Payload

Copy this into the Clappia REST API body editor.
Replace `<<[field_name]>>` tokens with your actual Clappia field names.

```json
{
  "report_no":       "<<[report_no]>>",
  "submission_date": "<<[$submission_date]>>",
  "your_email":      "<<[your_email]>>",
  "part_name":       "<<[part_name]>>",
  "rm_grade":        "<<[rm_grade]>>",
  "customer":        "<<[customer]>>",
  "item_code":       "<<[item_code]>>",
  "heat_no":         "<<[heat_no]>>",
  "order_qty":       "<<[order_qty]>>",
  "remarks":         "<<[remarks]>>",
  "conclusion":      "<<[conclusion]>>",
  "part_drawing":    null,
  "insp_image":      null,
  "sampleCount":     5,
  "dimRows": [
    {
      "index": 1,
      "parameter":  "<<[parameter#1]>>",
      "specificat": "<<[specificat#1]>>",
      "instrument": "<<[instrument#1]>>",
      "samples":    ["<<[sample_1#1]>>","<<[sample_2#1]>>","<<[sample_3#1]>>","<<[sample_4#1]>>","<<[sample_5#1]>>"],
      "status_1":   "<<[status_1#1]>>",
      "qc_photo":   null
    },
    {
      "index": 2,
      "parameter":  "<<[parameter#2]>>",
      "specificat": "<<[specificat#2]>>",
      "instrument": "<<[instrument#2]>>",
      "samples":    ["<<[sample_1#2]>>","<<[sample_2#2]>>","<<[sample_3#2]>>","<<[sample_4#2]>>","<<[sample_5#2]>>"],
      "status_1":   "<<[status_1#2]>>",
      "qc_photo":   null
    }
  ],
  "visRows": [
    {
      "index":     1,
      "parameter": "<<[visual_inspection#1]>>",
      "status":    "<<[status_visual#1]>>",
      "comments":  "<<[comments#1]>>",
      "photo":     null
    }
  ],
  "certificates": [
    { "label": "<<[test_name#1]>>", "url": "<<[upload_doc#1]>>" },
    { "label": "<<[test_name#2]>>", "url": "<<[upload_doc#2]>>" },
    { "label": "<<[test_name#3]>>", "url": "<<[upload_doc#3]>>" },
    { "label": "<<[test_name#4]>>", "url": "<<[upload_doc#4]>>" },
    { "label": "<<[test_name#5]>>", "url": "<<[upload_doc#5]>>" }
  ]
}
```

> **Note on certificates:** Clappia sends pre-signed S3 URLs that expire in
> 5 minutes. The server fetches all cert PDFs immediately on receiving the
> webhook — this takes 2-10 seconds, well within the window.
>
> Empty certificate slots (where the user didn't upload a file) will have
> empty URL strings. The server automatically skips those.

---

## API Reference

### `GET /`
Health check. Returns `{ status: "ok" }`.

### `POST /generate`
Generates and emails the QIR report.

**Request:** JSON body (see payload above)

**Response (success):**
```json
{
  "success": true,
  "filename": "QIR-QIR-2025-0001-2025-01-15.pdf",
  "elapsed": "8.3s",
  "certs": 3
}
```

**Response (error):**
```json
{
  "error": "description of what went wrong",
  "report": "QIR-2025-0001"
}
```

---

## Constraints & Notes

| Item | Detail |
|---|---|
| S3 URL expiry | 5 min — server fetches immediately, no issue in practice |
| Free tier cold start | ~30s wake-up after 15min inactivity — still within S3 window |
| PDF attachment size | Gmail allows up to 25MB attachments |
| Email volume | Gmail SMTP: ~500/day. Use SendGrid if you need more |
| Images in PDF | Currently null in payload — add base64 when Clappia supports it |
| Memory | pdf-lib merge uses ~2x the total PDF size in RAM. 512MB free tier handles typical reports fine |

---

## Local Development

```bash
cp .env.example .env
# fill in .env values

npm install
node server.js

# Test with curl:
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d @test-payload.json
```
