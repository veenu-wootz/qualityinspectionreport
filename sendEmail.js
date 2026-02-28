/**
 * sendEmail.js
 * Sends the final merged PDF via Gmail SMTP.
 *
 * Recipients:
 *   - Submitter:     from data.your_email  (Clappia variable {your_email})
 *   - Internal team: INTERNAL_EMAILS env var (comma-separated)
 */

const nodemailer = require('nodemailer');

// Build transporter once — reused across requests
let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,   // Gmail App Password, NOT your real password
      },
    });
  }
  return transporter;
}

/**
 * @param {object} data         — form data (for email body content)
 * @param {Buffer} pdfBuffer    — merged final PDF
 * @param {string} filename     — e.g. "QIR-2025-0001-2025-01-15.pdf"
 */
async function sendQIREmail(data, pdfBuffer, filename) {
  const transport = getTransporter();

  // ── Build recipient list ─────────────────────────────────
  const recipients = [];

  // 1. Submitter from Clappia's {your_email} field
  if (data.your_email && data.your_email.trim()) {
    recipients.push(data.your_email.trim());
  }

  // 2. Fixed internal team from env
  const internalEmails = (process.env.INTERNAL_EMAILS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  recipients.push(...internalEmails);

  if (recipients.length === 0) {
    console.warn('sendEmail: no recipients found — email not sent');
    return;
  }

  // Deduplicate
  const to = [...new Set(recipients)].join(', ');

  // ── Email content ────────────────────────────────────────
  const subject = `Quality Inspection Report — ${data.report_no || 'New Report'} | ${data.part_name || ''}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1a1a2e; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">
          Quality Inspection Report
        </h2>
        <p style="color: #aaa; margin: 4px 0 0; font-size: 13px;">
          ${data.report_no || '—'}
        </p>
      </div>

      <div style="background: #f9f9f9; padding: 24px; border: 1px solid #e0e0e0; border-top: none;">
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 6px 0; color: #888; width: 130px;">Part Name</td>
            <td style="padding: 6px 0; font-weight: 600;">${data.part_name || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888;">Customer</td>
            <td style="padding: 6px 0; font-weight: 600;">${data.customer || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888;">Item Code</td>
            <td style="padding: 6px 0;">${data.item_code || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888;">RM Grade</td>
            <td style="padding: 6px 0;">${data.rm_grade || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888;">Heat No.</td>
            <td style="padding: 6px 0;">${data.heat_no || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888;">Order Qty</td>
            <td style="padding: 6px 0;">${data.order_qty || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888;">Date</td>
            <td style="padding: 6px 0;">${data.submission_date || '—'}</td>
          </tr>
          ${data.conclusion ? `
          <tr>
            <td style="padding: 6px 0; color: #888; vertical-align: top;">Conclusion</td>
            <td style="padding: 6px 0;">${data.conclusion}</td>
          </tr>` : ''}
        </table>
      </div>

      <div style="background: #fff; padding: 16px 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0; font-size: 13px; color: #555;">
          The complete Quality Inspection Report with all certificates is attached as a PDF.
        </p>
        ${data.your_email ? `
        <p style="margin: 8px 0 0; font-size: 12px; color: #aaa;">
          Submitted by: ${data.your_email}
        </p>` : ''}
      </div>
    </div>
  `;

  // Plain text fallback
  const text = [
    `Quality Inspection Report — ${data.report_no || 'New Report'}`,
    '',
    `Part Name:   ${data.part_name || '—'}`,
    `Customer:    ${data.customer || '—'}`,
    `Item Code:   ${data.item_code || '—'}`,
    `RM Grade:    ${data.rm_grade || '—'}`,
    `Heat No.:    ${data.heat_no || '—'}`,
    `Order Qty:   ${data.order_qty || '—'}`,
    `Date:        ${data.submission_date || '—'}`,
    data.conclusion ? `\nConclusion: ${data.conclusion}` : '',
    '',
    'The full report PDF with all certificates is attached.',
  ].join('\n');

  // ── Send ─────────────────────────────────────────────────
  const info = await transport.sendMail({
    from: `"QIR System" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
    attachments: [
      {
        filename,
        content:     pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });

  console.log(`  Email sent to: ${to}`);
  console.log(`  Message ID: ${info.messageId}`);
  return info;
}

module.exports = { sendQIREmail };
