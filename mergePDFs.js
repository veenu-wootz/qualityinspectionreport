/**
 * mergePDFs.js
 * Fetches PDFs from URLs (pre-signed S3 or any public URL),
 * optionally stamps a heading on the first page of each,
 * then merges everything into one Buffer.
 *
 * Key constraint: pre-signed S3 URLs expire in 5 minutes.
 * All fetches happen immediately on receipt of the webhook — no delay.
 */

const fetch   = require('node-fetch');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

/**
 * Fetch a PDF from a URL and return its bytes as Buffer.
 * Throws if the fetch fails or response is not a PDF.
 */
async function fetchPDF(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'QIR-Server/1.0' },
    timeout: 30000,   // 30s timeout per file
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${res.status} for ${url.substring(0, 80)}...`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    console.warn(`Warning: content-type "${contentType}" — attempting to use as PDF anyway`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Stamp a heading label on the first page of a PDF.
 * Draws a white bar at the top with bold text + red accent line.
 * Returns new PDF bytes as Buffer.
 */
async function stampHeading(pdfBytes, label) {
  if (!label || !label.trim()) return pdfBytes;

  try {
    const pdf  = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const page = pdf.getPages()[0];
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { width, height } = page.getSize();

    const fontSize = 14;
    const textW    = font.widthOfTextAtSize(label, fontSize);
    const barH     = 28;

    // White background bar
    page.drawRectangle({
      x: 0, y: height - barH,
      width, height: barH,
      color: rgb(1, 1, 1),
      opacity: 0.9,
    });

    // Red accent line below bar
    page.drawLine({
      start: { x: 0,     y: height - barH },
      end:   { x: width, y: height - barH },
      thickness: 1.5,
      color: rgb(0.78, 0.29, 0.17),
    });

    // Heading text centred
    page.drawText(label, {
      x:    (width - textW) / 2,
      y:    height - barH + (barH - fontSize) / 2 + 2,
      size: fontSize,
      font,
      color: rgb(0.1, 0.1, 0.18),
    });

    return Buffer.from(await pdf.save());
  } catch (e) {
    console.warn(`stampHeading failed for "${label}": ${e.message} — using original`);
    return pdfBytes;
  }
}

/**
 * Merge an array of PDF buffers into one.
 * @param {Buffer[]} buffers
 * @returns {Promise<Buffer>}
 */
async function mergeBuffers(buffers) {
  const merged = await PDFDocument.create();

  for (const buf of buffers) {
    try {
      const src   = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    } catch (e) {
      console.warn(`Skipping a PDF that could not be parsed: ${e.message}`);
    }
  }

  return Buffer.from(await merged.save());
}

/**
 * Main function.
 *
 * @param {Buffer} qirBuffer  — the generated QIR PDF
 * @param {Array}  certs      — [{ url: string, label: string }, ...]
 *   url:   pre-signed S3 URL or any fetchable PDF URL
 *   label: heading to stamp on first page (empty string = no stamp)
 *
 * @returns {Promise<Buffer>} merged PDF
 */
async function buildMergedPDF(qirBuffer, certs = []) {
  const buffers = [qirBuffer];

  // Fetch all cert PDFs in parallel — important for beating the 5-min S3 expiry
  const certResults = await Promise.allSettled(
    certs
      .filter(c => c && c.url && c.url.trim())
      .map(async (cert) => {
        console.log(`  Fetching: ${cert.label || 'unnamed'} — ${cert.url.substring(0, 60)}...`);
        const bytes = await fetchPDF(cert.url);
        return { bytes, label: cert.label || '' };
      })
  );

  for (const result of certResults) {
    if (result.status === 'fulfilled') {
      const { bytes, label } = result.value;
      const stamped = await stampHeading(bytes, label);
      buffers.push(stamped);
    } else {
      console.error(`  Failed to fetch a certificate PDF: ${result.reason?.message}`);
      // Continue — don't fail the whole report for one missing cert
    }
  }

  console.log(`  Merging ${buffers.length} PDFs (1 QIR + ${buffers.length - 1} certs)...`);
  return mergeBuffers(buffers);
}

module.exports = { buildMergedPDF };
