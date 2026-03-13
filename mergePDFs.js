/**
 * mergePDFs.js
 * 1. Builds an index page (page 2 of final PDF)
 * 2. Fetches drawing PDF, stamps it, inserts as page 3 (if present)
 * 3. Stamps page numbers + logo on ALL pages (QIR + drawing + certs)
 * 4. Stamps heading text (no white strip) on first page of each cert
 * 5. Merges everything into one PDF Buffer
 *
 * Final page order:
 *   p.1          → QIR p.1 (Header + Part Info)
 *   p.2          → Index
 *   p.3          → Part Drawing p.1 (if present) ← NEW
 *   p.4..N+2     → remaining QIR pages (Dimensional, Visual, etc.)
 *   p.N+3..end   → Certificates
 *
 * Bulletproof page positioning:
 *   - Uses CropBox if present, falls back to MediaBox
 *   - All coordinates anchored to actual visible area, not assumed (0,0)
 *   - Works correctly for scanned PDFs, portrait, landscape, any size
 */

const fetch = require('node-fetch');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Logo — fetched once, reused across all requests ──────────
const LOGO_URL = 'https://storage.googleapis.com/glide-prod.appspot.com/uploads-v2/rIdnwOvTnxdsQUtlXKUB/pub/gfde2QvEVFNokJXJQdEP.png';
let logoPngBytes = null;

async function ensureLogo() {
  if (logoPngBytes) return logoPngBytes;
  try {
    const res = await fetch(LOGO_URL, { timeout: 10000 });
    if (res.ok) {
      logoPngBytes = Buffer.from(await res.arrayBuffer());
      console.log(`  Logo fetched: ${(logoPngBytes.length / 1024).toFixed(0)} KB`);
    }
  } catch(e) {
    console.warn('  Logo fetch failed — will skip logo on pages:', e.message);
  }
  return logoPngBytes;
}

// ── Bulletproof visible-area helper ──────────────────────────
// CropBox defines what viewers actually display.
// Falls back to MediaBox if CropBox is absent.
function getVisibleBox(page) {
  try {
    const crop = page.getCropBox();
    if (crop && crop.width > 0 && crop.height > 0) return crop;
  } catch(_) {}
  return page.getMediaBox();
}

// ── Fetch PDF from URL ────────────────────────────────────────
async function fetchPDF(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'QIR-Server/2.0' },
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${String(url).substring(0, 80)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Stamp page number + logo on every page of a PDF ──────────
async function stampPageNumbers(pdfBytes, startPageNum) {
  const pdf       = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font      = await pdf.embedFont(StandardFonts.Helvetica);
  const logoBytes = await ensureLogo();

  let logoImg = null;
  if (logoBytes) {
    try { logoImg = await pdf.embedPng(logoBytes); } catch(e) {}
  }

  pdf.getPages().forEach((page, i) => {
    const box   = getVisibleBox(page);
    const bx    = box.x, by = box.y;
    const width = box.width, height = box.height;

    const shortSide = Math.min(width, height);
    const fontSize  = Math.round(shortSide * 0.014 * 10) / 10;
    const barH      = fontSize * 2;

    page.drawRectangle({ x: bx, y: by, width, height: barH,
      color: rgb(0.96, 0.96, 0.96), opacity: 1.0 });

    if (logoImg) {
      try {
        const LOGO_H   = barH * 0.72;
        const LOGO_PAD = barH * 0.14;
        const logoDims = logoImg.scale(1);
        const scale    = LOGO_H / logoDims.height;
        const lw       = logoDims.width * scale;
        page.drawImage(logoImg, {
          x: bx + LOGO_PAD, y: by + LOGO_PAD,
          width: lw, height: LOGO_H,
        });
      } catch(e) {}
    }

    const pgStr = String(startPageNum + i);
    const pgW   = font.widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, {
      x: bx + width / 2 - pgW / 2,
      y: by + barH * 0.28,
      size: fontSize, font, color: rgb(0.20, 0.20, 0.20),
    });
  });

  return Buffer.from(await pdf.save());
}

// ── Heading stamp — bold text only, NO white strip ────────────
async function stampHeading(pdfBytes, label) {
  if (!label?.trim()) return pdfBytes;
  try {
    const pdf  = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const page = pdf.getPages()[0];
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    const box    = getVisibleBox(page);
    const bx     = box.x, by = box.y;
    const width  = box.width, height = box.height;

    const shortSide = Math.min(width, height);
    const fontSize  = Math.round(shortSide * 0.019 * 10) / 10;
    const topMargin = fontSize * 1.5;

    const textW = font.widthOfTextAtSize(label, fontSize);
    page.drawText(label, {
      x:    bx + (width - textW) / 2,
      y:    by + height - topMargin - fontSize,
      size: fontSize, font,
      color: rgb(0.10, 0.10, 0.10),
    });

    return Buffer.from(await pdf.save());
  } catch(e) { return pdfBytes; }
}

// ── Prepare drawing page: stamp heading + footer, return single-page PDF ──
// Fetches the drawing PDF, takes only page 1, stamps "Part Drawing"
// heading and page number + logo footer, returns stamped bytes.
async function prepareDrawingPage(drawingUrl, pageNum) {
  console.log(`  Fetching drawing PDF: ${String(drawingUrl).substring(0, 70)}...`);
  const rawBytes  = await fetchPDF(drawingUrl);

  // Extract only page 1 into a new single-page document
  const srcPdf    = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
  const singleDoc = await PDFDocument.create();
  const [page1]   = await singleDoc.copyPages(srcPdf, [0]);
  singleDoc.addPage(page1);
  let drawingBytes = Buffer.from(await singleDoc.save());

  // Stamp heading "Part Drawing"
  drawingBytes = await stampHeading(drawingBytes, 'Part Drawing');

  // Stamp page number + logo footer
  drawingBytes = await stampPageNumbers(drawingBytes, pageNum);

  console.log(`  Drawing page prepared (final p.${pageNum})`);
  return drawingBytes;
}

// ── Fit external page to A4 landscape ────────────────────────
// Target: 841.89 × 595.28 pt (A4 landscape)
// Rules:
//   - If either dimension exceeds target → scale DOWN uniformly so both fit
//   - If both dimensions within target   → no scaling, just centre
//   - In both cases: set page to target size, white background, content centred
//   - Never scales up (scale capped at 1.0)
const TARGET_W = 841.89;
const TARGET_H = 595.28;

async function fitPageToA4Landscape(pdfBytes) {
  // We rebuild each page into a new PDF, embedding the original as an XObject.
  // This is the most reliable way to scale+centre PDF page content in pdf-lib
  // without wrestling with raw content stream transforms.
  const srcPdf  = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const outPdf  = await PDFDocument.create();

  for (let i = 0; i < srcPdf.getPageCount(); i++) {
    // Embed the source page as an XObject (form) in the output PDF
    const [embedded] = await outPdf.embedPdf(srcPdf, [i]);

    const srcPage = srcPdf.getPages()[i];
    const pageW   = srcPage.getWidth();
    const pageH   = srcPage.getHeight();

    // Uniform scale — capped at 1.0 (never upscale)
    const scale   = Math.min(TARGET_W / pageW, TARGET_H / pageH, 1.0);
    const scaledW = pageW  * scale;
    const scaledH = pageH  * scale;

    // Offset to centre scaled content on target page
    const offsetX = (TARGET_W - scaledW) / 2;
    const offsetY = (TARGET_H - scaledH) / 2;

    // Create a fresh A4 landscape page
    const newPage = outPdf.addPage([TARGET_W, TARGET_H]);

    // White background
    newPage.drawRectangle({
      x: 0, y: 0, width: TARGET_W, height: TARGET_H,
      color: rgb(1, 1, 1), opacity: 1.0,
    });

    // Draw the embedded page content, scaled and centred
    newPage.drawPage(embedded, {
      x: offsetX, y: offsetY,
      width:  scaledW,
      height: scaledH,
      opacity: 1.0,
    });
  }

  return Buffer.from(await outPdf.save());
}

// ── Index page ────────────────────────────────────────────────
async function buildIndexPage({ qirPageCount, hasDrawing, certEntries }) {
  const doc = await PDFDocument.create();
  const W = 841.89, H = 595.28;
  const page = doc.addPage([W, H]);

  const fontBold   = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await doc.embedFont(StandardFonts.Helvetica);

  const BLACK  = rgb(0.10, 0.10, 0.10);
  const DGRAY  = rgb(0.30, 0.30, 0.30);
  const MGRAY  = rgb(0.55, 0.55, 0.55);
  const LGRAY  = rgb(0.82, 0.82, 0.82);
  const OFFWHT = rgb(0.95, 0.95, 0.95);
  const HDRBG  = rgb(0.88, 0.88, 0.88);

  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });

  // Footer bar (same style as all other pages)
  const shortSide    = Math.min(W, H);
  const PG_FONT_SIZE = Math.round(shortSide * 0.014 * 10) / 10;
  const PG_BAR_H     = PG_FONT_SIZE * 2.8;

  page.drawRectangle({ x: 0, y: 0, width: W, height: PG_BAR_H,
    color: rgb(0.96, 0.96, 0.96), opacity: 1.0 });

  // Logo in footer bar
  const logoBytes = await ensureLogo();
  const LOGO_H    = PG_BAR_H * 0.72;
  const LOGO_PAD  = PG_BAR_H * 0.14;
  if (logoBytes) {
    try {
      const logoImg  = await doc.embedPng(logoBytes);
      const logoDims = logoImg.scale(1);
      const scale    = LOGO_H / logoDims.height;
      const lw       = logoDims.width * scale;
      page.drawImage(logoImg, { x: LOGO_PAD, y: LOGO_PAD, width: lw, height: LOGO_H });
    } catch(e) {}
  }

  // Page number centred in footer
  const p2Str = '2';
  const p2W   = fontNormal.widthOfTextAtSize(p2Str, PG_FONT_SIZE);
  page.drawText(p2Str, {
    x: W / 2 - p2W / 2, y: PG_BAR_H * 0.25,
    size: PG_FONT_SIZE, font: fontNormal, color: rgb(0.20, 0.20, 0.20),
  });

  // Title
  const tocLabel = 'TABLE OF CONTENTS';
  const tocW = fontBold.widthOfTextAtSize(tocLabel, 11);
  page.drawText(tocLabel, { x: W / 2 - tocW / 2, y: H - 52, size: 11, font: fontBold, color: BLACK });

  // Table
  const TBL_X = 40, TBL_W = W - 80, PAD = 10, ROW_H = 24;
  let rowY = H - 72;
  const tableTopY = rowY;

  function drawRow(label, pageNum, isSub = false, isHeader = false) {
    const bg = isHeader ? HDRBG : (isSub ? rgb(1, 1, 1) : OFFWHT);
    page.drawRectangle({ x: TBL_X, y: rowY - ROW_H, width: TBL_W, height: ROW_H, color: bg });
    page.drawLine({ start: { x: TBL_X, y: rowY - ROW_H }, end: { x: TBL_X + TBL_W, y: rowY - ROW_H },
      thickness: 0.3, color: LGRAY });

    const indent   = isSub ? 18 : 0;
    const fontSize = isHeader ? 8.5 : 8;
    const font     = isHeader ? fontBold : fontNormal;
    const color    = isHeader ? BLACK : isSub ? MGRAY : DGRAY;
    const textY    = rowY - ROW_H + (ROW_H - fontSize) / 2 + 1;

    page.drawText(String(label), { x: TBL_X + PAD + indent, y: textY, size: fontSize, font, color });
    const pgStr = String(pageNum);
    const pgW   = (isHeader ? fontBold : fontNormal).widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, { x: TBL_X + TBL_W - PAD - pgW, y: textY, size: fontSize,
      font: isHeader ? fontBold : fontNormal, color: isHeader ? BLACK : DGRAY });
    rowY -= ROW_H;
  }

  page.drawLine({ start: { x: TBL_X, y: tableTopY }, end: { x: TBL_X + TBL_W, y: tableTopY },
    thickness: 0.6, color: DGRAY });

  drawRow('Section', 'Page', false, true);
  drawRow('Report Header & Part Information', 1);
  drawRow('Index', 2);

  // Page 3 is drawing if present, otherwise inspection starts at 3
  // QIR p.2 onwards maps to: final = i === 0 ? 1 : (hasDrawing ? i+3 : i+2)
  // Drawing = p.3 (if present)
  // QIR remaining pages start at p.3 (no drawing) or p.4 (with drawing)
  let nextQirPage = hasDrawing ? 4 : 3;

  if (hasDrawing) {
    drawRow('Part Drawing', 3);
  }

  if (certEntries._hasDim || certEntries._hasVis) {
    drawRow('Inspection', nextQirPage);
    if (certEntries._hasDim) drawRow('Dimensional Inspection', '', true);
    if (certEntries._hasVis) drawRow('Visual Inspection',      '', true);
  }

  // Cert start: QIR pages + 1 (index) + 1 (drawing, if present) + 1 (base offset)
  const certStart = qirPageCount + 1 + (hasDrawing ? 1 : 0) + 1;
  drawRow('Tests & Certificates', certEntries.length > 0 ? certStart : '—');
  for (const c of certEntries) drawRow(c.label, c.startPage, true);

  page.drawLine({ start: { x: TBL_X, y: rowY }, end: { x: TBL_X + TBL_W, y: rowY }, thickness: 0.6, color: DGRAY });
  page.drawLine({ start: { x: TBL_X, y: tableTopY }, end: { x: TBL_X, y: rowY }, thickness: 0.6, color: DGRAY });
  page.drawLine({ start: { x: TBL_X + TBL_W, y: tableTopY }, end: { x: TBL_X + TBL_W, y: rowY }, thickness: 0.6, color: DGRAY });

  return Buffer.from(await doc.save());
}

// ── Main ──────────────────────────────────────────────────────
async function buildMergedPDF(qirBuffer, certs = [], meta = {}) {
  await ensureLogo();

  const qirPdf       = await PDFDocument.load(qirBuffer, { ignoreEncryption: true });
  const qirPageCount = qirPdf.getPageCount();
  const hasDrawing   = !!meta.partDrawingUrl;
  console.log(`  QIR pages: ${qirPageCount}, hasDrawing: ${hasDrawing}`);

  // Fetch drawing page and cert PDFs in parallel
  const [drawingResult, ...certResults] = await Promise.allSettled([
    hasDrawing ? fetchPDF(meta.partDrawingUrl) : Promise.resolve(null),
    ...certs.filter(c => c && c.url && c.url.trim()).map(async (cert) => {
      console.log(`    Fetching cert: ${cert.label} — ${String(cert.url).substring(0, 60)}...`);
      const bytes = await fetchPDF(cert.url);
      const pdf   = await PDFDocument.load(bytes, { ignoreEncryption: true });
      return { label: cert.label || 'Certificate', bytes, pageCount: pdf.getPageCount() };
    }),
  ]);

  // Drawing raw bytes (not yet stamped — we need page numbers first)
  let drawingRawBytes = null;
  if (hasDrawing) {
    if (drawingResult.status === 'fulfilled' && drawingResult.value) {
      drawingRawBytes = drawingResult.value;
    } else {
      console.error(`  Drawing fetch failed: ${drawingResult.reason?.message}`);
    }
  }

  // Cert data
  const certData = [];
  for (const r of certResults) {
    if (r.status === 'fulfilled') certData.push(r.value);
    else console.error(`  Cert fetch failed: ${r.reason?.message}`);
  }

  // ── Page number layout ────────────────────────────────────────
  // p.1           = QIR p.1
  // p.2           = Index
  // p.3           = Part Drawing (if present)
  // p.3 or p.4+   = remaining QIR pages
  // p.N+2 or N+3  = first cert
  const drawingPageNum  = 3;                                          // always p.3 if present
  const qirRemapOffset  = hasDrawing ? 3 : 2;                        // QIR p.2 → final p.4 (drawing) or p.3 (no drawing)
  const certStartPage   = qirPageCount + 1 + (hasDrawing ? 1 : 0) + 1; // = qirPages + index + drawing? + 1
  let   runningPage     = certStartPage;

  const certEntries = certData.map(c => {
    const entry = { ...c, startPage: runningPage };
    runningPage += c.pageCount;
    return entry;
  });
  certEntries._hasDrawing = hasDrawing;
  certEntries._hasDim     = meta.hasDim  || false;
  certEntries._hasVis     = meta.hasVis  || false;

  console.log(`  Page layout: QIR(${qirPageCount}) + Index + ${hasDrawing ? 'Drawing + ' : ''}Certs → total ~${runningPage - 1}`);

  // Build index page
  console.log('  Building index page...');
  const indexBytes = await buildIndexPage({ qirPageCount, hasDrawing, certEntries });

  // Stamp QIR pages
  // p.1 stays as p.1; p.2..N → p.(qirRemapOffset+1)..(qirRemapOffset+N-1)
  const qirForStamp = await PDFDocument.load(qirBuffer, { ignoreEncryption: true });
  const qirFont     = await qirForStamp.embedFont(StandardFonts.Helvetica);
  const logoBytes   = logoPngBytes;
  let   qirLogoImg  = null;
  if (logoBytes) {
    try { qirLogoImg = await qirForStamp.embedPng(logoBytes); } catch(e) {}
  }

  qirForStamp.getPages().forEach((page, i) => {
    const finalNum  = i === 0 ? 1 : i + qirRemapOffset;
    const box       = getVisibleBox(page);
    const bx        = box.x, by = box.y;
    const width     = box.width, height = box.height;
    const shortSide = Math.min(width, height);
    const fontSize  = Math.round(shortSide * 0.014 * 10) / 10;
    const barH      = fontSize * 2;

    page.drawRectangle({ x: bx, y: by, width, height: barH,
      color: rgb(0.96, 0.96, 0.96), opacity: 1.0 });

    if (qirLogoImg) {
      try {
        const LOGO_H   = barH * 0.72;
        const LOGO_PAD = barH * 0.14;
        const logoDims = qirLogoImg.scale(1);
        const scale    = LOGO_H / logoDims.height;
        const lw       = logoDims.width * scale;
        page.drawImage(qirLogoImg, { x: bx + LOGO_PAD, y: by + LOGO_PAD, width: lw, height: LOGO_H });
      } catch(e) {}
    }

    const pgStr = String(finalNum);
    const pgW   = qirFont.widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, {
      x: bx + width / 2 - pgW / 2,
      y: by + barH * 0.28,
      size: fontSize, font: qirFont, color: rgb(0.20, 0.20, 0.20),
    });
  });
  const qirNumbered = Buffer.from(await qirForStamp.save());

  // Prepare drawing page (stamp heading + footer)
  let drawingStamped = null;
  if (drawingRawBytes) {
    try {
      // Extract only page 1 into its own document first
      const srcPdf    = await PDFDocument.load(drawingRawBytes, { ignoreEncryption: true });
      const singleDoc = await PDFDocument.create();
      const [pg1]     = await singleDoc.copyPages(srcPdf, [0]);
      singleDoc.addPage(pg1);
      let drawBytes   = Buffer.from(await singleDoc.save());

      // Fit to A4 landscape (scale down if needed, centre, white background)
      drawBytes = await fitPageToA4Landscape(drawBytes);

      // Stamp heading "Part Drawing" at top
      drawBytes = await stampHeading(drawBytes, 'Part Drawing');

      // Stamp page number + logo at bottom (page 3)
      drawBytes = await stampPageNumbers(drawBytes, drawingPageNum);

      drawingStamped = drawBytes;
      console.log(`  Drawing page stamped as p.${drawingPageNum}`);
    } catch(e) {
      console.error(`  Drawing page preparation failed: ${e.message}`);
    }
  }

  // ── Final merge ───────────────────────────────────────────────
  console.log('  Merging...');
  const merged   = await PDFDocument.create();
  const qirFinal = await PDFDocument.load(qirNumbered, { ignoreEncryption: true });
  const qirPages = await merged.copyPages(qirFinal, qirFinal.getPageIndices());

  // p.1: QIR page 1
  merged.addPage(qirPages[0]);

  // p.2: Index
  const idxPdf    = await PDFDocument.load(indexBytes);
  const [idxPage] = await merged.copyPages(idxPdf, [0]);
  merged.addPage(idxPage);

  // p.3: Part Drawing (if present)
  if (drawingStamped) {
    const drawPdf    = await PDFDocument.load(drawingStamped, { ignoreEncryption: true });
    const [drawPage] = await merged.copyPages(drawPdf, [0]);
    merged.addPage(drawPage);
  }

  // p.4+ (or p.3+ if no drawing): remaining QIR pages
  for (let i = 1; i < qirPages.length; i++) merged.addPage(qirPages[i]);

  // Certs
  for (const cert of certEntries) {
    let bytes = await fitPageToA4Landscape(cert.bytes);
    bytes     = await stampHeading(bytes, cert.label);
    bytes     = await stampPageNumbers(bytes, cert.startPage);
    const cp  = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pgs = await merged.copyPages(cp, cp.getPageIndices());
    pgs.forEach(p => merged.addPage(p));
    console.log(`    "${cert.label}" p.${cert.startPage}–${cert.startPage + cert.pageCount - 1}`);
  }

  console.log(`  Final: ${merged.getPageCount()} pages`);
  return Buffer.from(await merged.save());
}

module.exports = { buildMergedPDF };
