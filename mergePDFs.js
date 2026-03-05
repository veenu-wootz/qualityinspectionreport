/**
 * mergePDFs.js
 * 1. Builds an index page (page 2 of final PDF)
 * 2. Stamps page numbers on all pages (QIR + certs)
 * 3. Stamps clean heading on first page of each cert (no red line)
 * 4. Merges everything into one PDF Buffer
 */

const fetch = require('node-fetch');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

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
async function buildIndexPage({ reportNo, partName, date, qirPageCount, certEntries }) {
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

  // Centred title
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
    page.drawLine({ start:{x:TBL_X,y:rowY-ROW_H}, end:{x:TBL_X+TBL_W,y:rowY-ROW_H}, thickness:0.3, color:LGRAY });

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

  // Borders top
  page.drawLine({ start:{x:TBL_X,y:tableTopY}, end:{x:TBL_X+TBL_W,y:tableTopY}, thickness:0.6, color:DGRAY });

  drawRow('Section', 'Page', false, true);
  drawRow('Report Header & Part Information', 1);
  drawRow('Index', 2);

  // QIR pages — figure out which sections exist
  // Page 3 = Part Drawing (if present), else Dimensional starts at 3
  let nextQirPage = 3;
  if (certEntries._hasDrawing) {
    drawRow('Part Drawing', nextQirPage++);
  }
  if (certEntries._hasDim) {
    drawRow('Inspection', nextQirPage);
    drawRow('Dimensional Inspection', nextQirPage, true);
    drawRow('Visual Inspection', certEntries._hasVis ? nextQirPage : '—', true);
    nextQirPage++;
  } else if (certEntries._hasVis) {
    drawRow('Visual Inspection', nextQirPage++);
  }

  // Cert section
  const certStart = qirPageCount + 2;
  drawRow('Tests & Certificates', certEntries.length > 0 ? certStart : '—');
  for (const c of certEntries) {
    drawRow(c.label, c.startPage, true);
  }

  // Borders bottom + sides
  page.drawLine({ start:{x:TBL_X,y:rowY}, end:{x:TBL_X+TBL_W,y:rowY}, thickness:0.6, color:DGRAY });
  page.drawLine({ start:{x:TBL_X,y:tableTopY}, end:{x:TBL_X,y:rowY}, thickness:0.6, color:DGRAY });
  page.drawLine({ start:{x:TBL_X+TBL_W,y:tableTopY}, end:{x:TBL_X+TBL_W,y:rowY}, thickness:0.6, color:DGRAY });

  // Page number
  const p2W = fontNormal.widthOfTextAtSize('2', 8);
  page.drawText('2', { x:W/2-p2W/2, y:20, size:8, font:fontNormal, color:MGRAY });

  return Buffer.from(await doc.save());
}

// ── Page number stamp ─────────────────────────────────────────
// Normalized font size so numbers look same on any page size
async function stampPageNumbers(pdfBytes, startPageNum) {
  const pdf  = await PDFDocument.load(pdfBytes, { ignoreEncryption:true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  pdf.getPages().forEach((page, i) => {
    const { width } = page.getSize();
    const fontSize = Math.round((width / 841) * 8 * 10) / 10;
    const barH = fontSize * 2.6;

    page.drawRectangle({ x:0, y:0, width, height:barH, color:rgb(0.96,0.96,0.96), opacity:0.9 });
    const pgStr = String(startPageNum + i);
    const pgW   = font.widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, { x:width/2-pgW/2, y:barH*0.25, size:fontSize, font, color:rgb(0.20,0.20,0.20) });
  });

  return Buffer.from(await pdf.save());
}

// ── Heading stamp — text only, no red line ────────────────────
async function stampHeading(pdfBytes, label) {
  if (!label?.trim()) return pdfBytes;
  try {
    const pdf  = await PDFDocument.load(pdfBytes, { ignoreEncryption:true });
    const page = pdf.getPages()[0];
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { width, height } = page.getSize();

    const fontSize = Math.round((width / 841) * 11 * 10) / 10;

    // White strip behind text only — no coloured line
    page.drawRectangle({
      x:0, y:height - fontSize*2.8,
      width, height: fontSize*2.8,
      color: rgb(1,1,1), opacity: 0.75,
    });

    const textW = font.widthOfTextAtSize(label, fontSize);
    page.drawText(label, {
      x: (width - textW) / 2,
      y: height - fontSize*2.0,
      size: fontSize, font,
      color: rgb(0.10, 0.10, 0.10),
    });

    return Buffer.from(await pdf.save());
  } catch(e) { return pdfBytes; }
}

// ── Main ──────────────────────────────────────────────────────
/**
 * @param {Buffer} qirBuffer   generated QIR PDF
 * @param {Array}  certs       [{ label, url }]
 * @param {object} meta        { hasDrawing, hasDim, hasVis } — for index page
 * @returns {Promise<Buffer>}  final merged PDF
 */
async function buildMergedPDF(qirBuffer, certs = [], meta = {}) {
  // Load QIR to know page count
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

  // Calculate page numbers
  // p.1 = QIR p.1, p.2 = Index, p.3..N+1 = rest of QIR, p.N+2 = first cert
  const certStartPage = qirPageCount + 2;
  let   runningPage   = certStartPage;
  const certEntries   = certData.map(c => {
    const entry = { ...c, startPage: runningPage };
    runningPage += c.pageCount;
    return entry;
  });

  // Attach section flags for index page
  certEntries._hasDrawing = meta.hasDrawing || false;
  certEntries._hasDim     = meta.hasDim     || false;
  certEntries._hasVis     = meta.hasVis     || false;

  // Build index page
  console.log('  Building index page...');
  const indexBytes = await buildIndexPage({
    reportNo:     meta.reportNo  || '',
    partName:     meta.partName  || '',
    date:         meta.date      || '',
    qirPageCount,
    certEntries,
  });

  // Stamp page numbers on QIR pages
  // QIR p.1 → final p.1,  QIR p.2..N → final p.3..N+1
  const qirForStamp = await PDFDocument.load(qirBuffer, { ignoreEncryption:true });
  const qirFont     = await qirForStamp.embedFont(StandardFonts.Helvetica);
  qirForStamp.getPages().forEach((page, i) => {
    const finalNum = i === 0 ? 1 : i + 2;
    const { width } = page.getSize();
    const fontSize = Math.round((width / 841) * 8 * 10) / 10;
    const barH = fontSize * 2.6;
    page.drawRectangle({ x:0, y:0, width, height:barH, color:rgb(0.96,0.96,0.96), opacity:0.9 });
    const pgStr = String(finalNum);
    const pgW   = qirFont.widthOfTextAtSize(pgStr, fontSize);
    page.drawText(pgStr, { x:width/2-pgW/2, y:barH*0.25, size:fontSize, font:qirFont, color:rgb(0.20,0.20,0.20) });
  });
  const qirNumbered = Buffer.from(await qirForStamp.save());

  // Merge everything
  console.log('  Merging...');
  const merged   = await PDFDocument.create();
  const qirFinal = await PDFDocument.load(qirNumbered, { ignoreEncryption:true });
  const qirPages = await merged.copyPages(qirFinal, qirFinal.getPageIndices());

  merged.addPage(qirPages[0]);   // p.1 header

  const idxPdf    = await PDFDocument.load(indexBytes);
  const [idxPage] = await merged.copyPages(idxPdf, [0]);
  merged.addPage(idxPage);       // p.2 index

  for (let i = 1; i < qirPages.length; i++) merged.addPage(qirPages[i]); // p.3+ QIR

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
