/**
 * mergePDFs.js
 * 1. Builds an index page (page 2 of final PDF)
 * 2. Stamps page numbers + logo on ALL pages (QIR + certs)
 * 3. Stamps heading text (no white strip) on first page of each cert
 * 4. Merges everything into one PDF Buffer
 *
 * Bulletproof page positioning:
 *   - Uses CropBox if present, falls back to MediaBox
 *   - All coordinates anchored to actual visible area, not assumed (0,0)
 *   - Works correctly for scanned PDFs, portrait, landscape, any size
 */

const fetch = require('node-fetch');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Logo — fetched once at module load, reused across requests ──
// Stored as base64 PNG bytes so pdf-lib can embed it directly.
const LOGO_URL = 'https://res.cloudinary.com/dbwg6zz3l/image/upload/w_300,f_png,q_90/v1753101276/Black_Blue_ctiycp.png';
let   logoPngBytes = null;   // Buffer | null

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
// If absent, MediaBox is the full page — use that instead.
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

// ── Index page ────────────────────────────────────────────────
async function buildIndexPage({ qirPageCount, certEntries }) {
  const doc  = await PDFDocument.create();
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

  page.drawRectangle({ x:0, y:0, width:W, height:H, color:rgb(1,1,1) });

  // Page number bar at bottom (same style as all other pages)
  const shortSide    = Math.min(W, H);
  const PG_FONT_SIZE = Math.round(shortSide * 0.014 * 10) / 10;
  const PG_BAR_H     = PG_FONT_SIZE * 2.8;

  page.drawRectangle({ x:0, y:0, width:W, height:PG_BAR_H,
    color:rgb(0.96,0.96,0.96), opacity:1.0 });

  // Logo in page number bar (left side) — same as all other pages
  const logoBytes = await ensureLogo();
  const LOGO_H    = PG_BAR_H * 0.72;
  const LOGO_PAD  = PG_BAR_H * 0.14;
  if (logoBytes) {
    try {
      const logoImg  = await doc.embedPng(logoBytes);
      const logoDims = logoImg.scale(1);
      const scale    = LOGO_H / logoDims.height;
      const lw       = logoDims.width * scale;
      page.drawImage(logoImg, {
        x: LOGO_PAD, y: LOGO_PAD,
        width: lw, height: LOGO_H,
      });
    } catch(e) { /* skip logo silently */ }
  }

  // Page number centred
  const p2Str = '2';
  const p2W   = fontNormal.widthOfTextAtSize(p2Str, PG_FONT_SIZE);
  page.drawText(p2Str, {
    x: W/2 - p2W/2, y: PG_BAR_H * 0.25,
    size: PG_FONT_SIZE, font: fontNormal, color: rgb(0.20,0.20,0.20),
  });

  // TABLE OF CONTENTS title
  const tocLabel = 'TABLE OF CONTENTS';
  const tocW = fontBold.widthOfTextAtSize(tocLabel, 11);
  page.drawText(tocLabel, { x: W/2 - tocW/2, y: H-52, size:11, font:fontBold, color:BLACK });

  // Table
  const TBL_X = 40, TBL_W = W - 80, PAD = 10, ROW_H = 24;
  let rowY = H - 72;
  const tableTopY = rowY;

  function drawRow(label, pageNum, isSub=false, isHeader=false) {
    const bg = isHeader ? HDRBG : (isSub ? rgb(1,1,1) : OFFWHT);
    page.drawRectangle({ x:TBL_X, y:rowY-ROW_H, width:TBL_W, height:ROW_H, color:bg });
    page.drawLine({ start:{x:TBL_X,y:rowY-ROW_H}, end:{x:TBL_X+TBL_W,y:rowY-ROW_H},
      thickness:0.3, color:LGRAY });

    const indent   = isSub ? 18 : 0;
    const fontSize = isHeader ? 8.5 : 8;
    const font     = isHeader ? fontBold : fontNormal;
    const color    = isHeader ? BLACK : isSub ? MGRAY : DGRAY;
    const textY    = rowY - ROW_H + (ROW_H - fontSize) / 2 + 1;

    page.drawText(String(label), { x:TBL_X+PAD+indent, y:textY, size:fontSize, font, color });

    const pgStr = String(pageNum);
    const pgW   = (isHeader ? fontBold : fontNormal).widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, { x:TBL_X+TBL_W-PAD-pgW, y:textY, size:fontSize,
      font: isHeader ? fontBold : fontNormal, color: isHeader ? BLACK : DGRAY });

    rowY -= ROW_H;
  }

  page.drawLine({ start:{x:TBL_X,y:tableTopY}, end:{x:TBL_X+TBL_W,y:tableTopY},
    thickness:0.6, color:DGRAY });

  drawRow('Section', 'Page', false, true);
  drawRow('Report Header & Part Information', 1);
  drawRow('Index', 2);

  let nextQirPage = 3;
  if (certEntries._hasDrawing) drawRow('Part Drawing', nextQirPage++);

  if (certEntries._hasDim || certEntries._hasVis) {
    drawRow('Inspection', nextQirPage);
    if (certEntries._hasDim) drawRow('Dimensional Inspection', '', true);
    if (certEntries._hasVis) drawRow('Visual Inspection',      '', true);
  }

  const certStart = qirPageCount + 2;
  drawRow('Tests & Certificates', certEntries.length > 0 ? certStart : '—');
  for (const c of certEntries) drawRow(c.label, c.startPage, true);

  page.drawLine({ start:{x:TBL_X,y:rowY}, end:{x:TBL_X+TBL_W,y:rowY}, thickness:0.6, color:DGRAY });
  page.drawLine({ start:{x:TBL_X,y:tableTopY}, end:{x:TBL_X,y:rowY}, thickness:0.6, color:DGRAY });
  page.drawLine({ start:{x:TBL_X+TBL_W,y:tableTopY}, end:{x:TBL_X+TBL_W,y:rowY}, thickness:0.6, color:DGRAY });

  return Buffer.from(await doc.save());
}

// ── Stamp page number + logo on every page of a PDF ──────────
async function stampPageNumbers(pdfBytes, startPageNum) {
  const pdf      = await PDFDocument.load(pdfBytes, { ignoreEncryption:true });
  const font     = await pdf.embedFont(StandardFonts.Helvetica);
  const logoBytes = await ensureLogo();

  // Embed logo once per document
  let logoImg = null;
  if (logoBytes) {
    try { logoImg = await pdf.embedPng(logoBytes); } catch(e) {}
  }

  pdf.getPages().forEach((page, i) => {
    const box    = getVisibleBox(page);
    const bx     = box.x, by = box.y;
    const width  = box.width, height = box.height;

    const shortSide = Math.min(width, height);
    const fontSize  = Math.round(shortSide * 0.014 * 10) / 10;
    const barH      = fontSize * 2.8;

    // Grey bar anchored to actual bottom of visible area
    page.drawRectangle({ x:bx, y:by, width, height:barH,
      color:rgb(0.96,0.96,0.96), opacity:1.0 });

    // Logo — left side of bar, vertically centred in bar
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

    // Page number — centred
    const pgStr = String(startPageNum + i);
    const pgW   = font.widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, {
      x: bx + width/2 - pgW/2,
      y: by + barH * 0.28,
      size: fontSize, font, color: rgb(0.20,0.20,0.20),
    });
  });

  return Buffer.from(await pdf.save());
}

// ── Heading stamp — bold text only, NO white strip ────────────
// Drawn directly onto the page content, top-centre.
// Uses CropBox/MediaBox to find the actual top edge.
async function stampHeading(pdfBytes, label) {
  if (!label?.trim()) return pdfBytes;
  try {
    const pdf  = await PDFDocument.load(pdfBytes, { ignoreEncryption:true });
    const page = pdf.getPages()[0];
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);

    const box    = getVisibleBox(page);
    const bx     = box.x;
    const by     = box.y;
    const width  = box.width;
    const height = box.height;

    const shortSide = Math.min(width, height);
    const fontSize  = Math.round(shortSide * 0.019 * 10) / 10;
    // Position: just inside the top edge with a small margin
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

// ── Main ──────────────────────────────────────────────────────
async function buildMergedPDF(qirBuffer, certs = [], meta = {}) {
  // Pre-fetch logo early so it's ready for all stamp operations
  await ensureLogo();

  const qirPdf       = await PDFDocument.load(qirBuffer, { ignoreEncryption:true });
  const qirPageCount = qirPdf.getPageCount();
  console.log(`  QIR pages: ${qirPageCount}`);

  // Fetch all cert PDFs in parallel
  console.log(`  Fetching ${certs.filter(c => c.url).length} certificate(s)...`);
  const certResults = await Promise.allSettled(
    certs.filter(c => c && c.url && c.url.trim()).map(async (cert) => {
      console.log(`    Fetching: ${cert.label} — ${String(cert.url).substring(0, 60)}...`);
      const bytes = await fetchPDF(cert.url);
      const pdf   = await PDFDocument.load(bytes, { ignoreEncryption:true });
      return { label: cert.label || 'Certificate', bytes, pageCount: pdf.getPageCount() };
    })
  );

  const certData = [];
  for (const r of certResults) {
    if (r.status === 'fulfilled') certData.push(r.value);
    else console.error(`  Cert fetch failed: ${r.reason?.message}`);
  }

  // Page number layout:
  // p.1 = QIR p.1 | p.2 = Index | p.3..N+1 = rest of QIR | p.N+2 = first cert
  const certStartPage = qirPageCount + 2;
  let   runningPage   = certStartPage;
  const certEntries   = certData.map(c => {
    const entry = { ...c, startPage: runningPage };
    runningPage += c.pageCount;
    return entry;
  });

  certEntries._hasDrawing = meta.hasDrawing || false;
  certEntries._hasDim     = meta.hasDim     || false;
  certEntries._hasVis     = meta.hasVis     || false;

  // Build index
  console.log('  Building index page...');
  const indexBytes = await buildIndexPage({ qirPageCount, certEntries });

  // Stamp QIR page numbers + logo
  // QIR p.1 → final p.1 | QIR p.2..N → final p.3..N+1
  const qirForStamp = await PDFDocument.load(qirBuffer, { ignoreEncryption:true });
  const qirFont     = await qirForStamp.embedFont(StandardFonts.Helvetica);
  const logoBytes   = logoPngBytes;
  let   qirLogoImg  = null;
  if (logoBytes) {
    try { qirLogoImg = await qirForStamp.embedPng(logoBytes); } catch(e) {}
  }

  qirForStamp.getPages().forEach((page, i) => {
    const finalNum = i === 0 ? 1 : i + 2;
    const box    = getVisibleBox(page);
    const bx     = box.x, by = box.y;
    const width  = box.width, height = box.height;
    const shortSide = Math.min(width, height);
    const fontSize  = Math.round(shortSide * 0.014 * 10) / 10;
    const barH      = fontSize * 2.8;

    page.drawRectangle({ x:bx, y:by, width, height:barH,
      color:rgb(0.96,0.96,0.96), opacity:1.0 });

    if (qirLogoImg) {
      try {
        const LOGO_H   = barH * 0.72;
        const LOGO_PAD = barH * 0.14;
        const logoDims = qirLogoImg.scale(1);
        const scale    = LOGO_H / logoDims.height;
        const lw       = logoDims.width * scale;
        page.drawImage(qirLogoImg, {
          x: bx + LOGO_PAD, y: by + LOGO_PAD,
          width: lw, height: LOGO_H,
        });
      } catch(e) {}
    }

    const pgStr = String(finalNum);
    const pgW   = qirFont.widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, {
      x: bx + width/2 - pgW/2,
      y: by + barH * 0.28,
      size: fontSize, font: qirFont, color: rgb(0.20,0.20,0.20),
    });
  });
  const qirNumbered = Buffer.from(await qirForStamp.save());

  // Merge
  console.log('  Merging...');
  const merged   = await PDFDocument.create();
  const qirFinal = await PDFDocument.load(qirNumbered, { ignoreEncryption:true });
  const qirPages = await merged.copyPages(qirFinal, qirFinal.getPageIndices());

  merged.addPage(qirPages[0]);
  const idxPdf    = await PDFDocument.load(indexBytes);
  const [idxPage] = await merged.copyPages(idxPdf, [0]);
  merged.addPage(idxPage);
  for (let i = 1; i < qirPages.length; i++) merged.addPage(qirPages[i]);

  for (const cert of certEntries) {
    let bytes = await stampHeading(cert.bytes, cert.label);
    bytes     = await stampPageNumbers(bytes, cert.startPage);
    const cp  = await PDFDocument.load(bytes, { ignoreEncryption:true });
    const pgs = await merged.copyPages(cp, cp.getPageIndices());
    pgs.forEach(p => merged.addPage(p));
    console.log(`    "${cert.label}" p.${cert.startPage}–${cert.startPage + cert.pageCount - 1}`);
  }

  console.log(`  Final: ${merged.getPageCount()} pages`);
  return Buffer.from(await merged.save());
}

module.exports = { buildMergedPDF };
