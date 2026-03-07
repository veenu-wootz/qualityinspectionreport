/**
 * generateQIR.js
 * Generates the QIR PDF using jsPDF + jspdf-autotable.
 * Updated for AppSheet data structure.
 * Images are fetched from AppSheet URLs before drawing.
 * Returns a Buffer.
 *
 * CHANGE: Part Drawing page removed from here.
 *         mergePDFs.js now fetches the drawing PDF and inserts
 *         its first page directly as page 3 of the final document.
 */

const { jsPDF }  = require('jspdf');
require('jspdf-autotable');
const fetch      = require('node-fetch');

// ── Constants ────────────────────────────────────────────────
const PW = 297, PH = 210, ML = 10, MR = 10, MT = 12, MB = 12;
const CW    = PW - ML - MR;
const GRAY  = [240, 240, 240];
const BORDER= [180, 180, 180];
const DARK  = [26,  26,  46 ];

// ── Helpers ──────────────────────────────────────────────────

function sectionHeading(doc, label, y) {
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.text(label, PW / 2, y, { align: 'center' });
  return y + 7;
}

/** Fetch an image URL → base64 data URL. Returns null on failure. */
async function fetchImageAsDataUrl(url) {
  if (!url || !url.trim()) return null;
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = await res.arrayBuffer();
    const b64 = Buffer.from(buffer).toString('base64');
    return `data:${contentType};base64,${b64}`;
  } catch (e) {
    console.warn(`  fetchImage failed for ${String(url).substring(0, 60)}: ${e.message}`);
    return null;
  }
}

/** Draw an image inside a cell, preserving aspect ratio, centred. */
function drawImgInCell(doc, src, cx, cy, cw, ch, pad = 1.5) {
  if (!src || !src.startsWith('data:')) return;
  try {
    const props = doc.getImageProperties(src);
    const maxW = cw - pad * 2, maxH = ch - pad * 2;
    let iw = props.width, ih = props.height;
    const scale = Math.min(maxW / iw, maxH / ih, 1);
    iw *= scale; ih *= scale;
    const ox = cx + pad + (maxW - iw) / 2;
    const oy = cy + pad + (maxH - ih) / 2;
    const fmt = src.includes('image/png') ? 'PNG' : 'JPEG';
    doc.addImage(src, fmt, ox, oy, iw, ih);
  } catch (e) { /* skip silently */ }
}

// ── Main export (async — fetches images) ─────────────────────
async function generateQIR(data) {
  // Pre-fetch all images in parallel before drawing
  // NOTE: part_drawing intentionally excluded — handled as PDF page in mergePDFs.js
  console.log('  Pre-fetching images...');
  const [inspImage, logoImg] = await Promise.all([
    fetchImageAsDataUrl(data.insp_image),
    fetchImageAsDataUrl('https://storage.googleapis.com/glide-prod.appspot.com/uploads-v2/rIdnwOvTnxdsQUtlXKUB/pub/9CXsJXGVWZXAld8aGYXQ.png'),
  ]);

  // Fetch dim row QC photos
  const dimPhotoMap = {};
  await Promise.all(
    (data.dimRows || []).map(async (r, i) => {
      if (r.qc_photo) {
        dimPhotoMap[i] = await fetchImageAsDataUrl(r.qc_photo);
      }
    })
  );

  // Fetch visual row photos
  const visPhotoMap = {};
  await Promise.all(
    (data.visRows || []).map(async (r, i) => {
      if (r.photo) {
        visPhotoMap[i] = await fetchImageAsDataUrl(r.photo);
      }
    })
  );

  console.log('  Images fetched. Building PDF...');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  let y = MT;

  // ── PAGE 1: HEADER ──────────────────────────────────────────
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.rect(ML, y, CW, 16);
  doc.line(ML + CW * 0.28, y, ML + CW * 0.28, y + 16);
  doc.line(ML + CW * 0.73, y, ML + CW * 0.73, y + 16);

  if (logoImg) {
    try {
      const logoProp = doc.getImageProperties(logoImg);
      const maxW = CW * 0.22, maxH = 14;
      const scale = Math.min(maxW / logoProp.width, maxH / logoProp.height);
      const lw = logoProp.width * scale, lh = logoProp.height * scale;
      doc.addImage(logoImg, 'JPEG', ML + (CW * 0.28 - lw) / 2, y + (16 - lh) / 2, lw, lh);
    } catch(e) {
      doc.setFontSize(7); doc.setTextColor(150, 150, 150);
      doc.text('[LOGO]', ML + CW * 0.14, y + 9, { align: 'center' });
    }
  } else {
    doc.setFontSize(7); doc.setTextColor(150, 150, 150);
    doc.text('[LOGO]', ML + CW * 0.14, y + 9, { align: 'center' });
  }

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.text('Quality Inspection Report', ML + CW * 0.505, y + 10, { align: 'center' });

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60, 60, 60);
  doc.text(`Doc No: ${data.report_no}`,        ML + CW * 0.76, y + 5);
  doc.text(`Date:   ${data.submission_date}`,   ML + CW * 0.76, y + 10);
  doc.text(`By:     ${data.created_by || '—'}`, ML + CW * 0.76, y + 15);

  y += 20;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);

  // Part info table
  doc.autoTable({
    startY: y,
    margin: { left: ML, right: MR },
    tableWidth: CW,
    head: [],
    body: [
      ['Part Name',   data.part_name    || '—',  'Part No.',  data.part_number  || '—', 'Customer', data.customer || '—'],
      ['Created By',  data.created_by   || '—',  'Title',     data.title        || '—', '',         ''],
      ...(data.remarks
        ? [['Note', { content: data.remarks, colSpan: 5, styles: { halign: 'left' } }]]
        : []),
    ],
    styles: { fontSize: 8, cellPadding: 2.5, lineColor: BORDER, lineWidth: 0.3 },
    columnStyles: {
      0: { fontStyle: 'bold', fillColor: GRAY, cellWidth: CW * 0.09 },
      2: { fontStyle: 'bold', fillColor: GRAY, cellWidth: CW * 0.09 },
      4: { fontStyle: 'bold', fillColor: GRAY, cellWidth: CW * 0.09 },
    },
  });
  y = doc.lastAutoTable.finalY + 4;

  // Conclusion on page 1 if present
  if (data.conclusion) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK);
    doc.text('Conclusion:', ML, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(data.conclusion, CW - 26);
    doc.text(lines, ML + 26, y);
  }

  // ── PAGE 2: DIMENSIONAL INSPECTION ───────────────────────────
  // NOTE: Part Drawing (page 3 in final PDF) is inserted by mergePDFs.js
  //       after the index page, before these QIR pages are added.
  if (data.dimRows && data.dimRows.length > 0) {
    doc.addPage('a4', 'landscape');
    y = MT;
    y = sectionHeading(doc, 'Dimensional Inspection', y);

    const n            = data.sampleCount || 5;
    const ROW_H        = 14;
    const PHOTO_COL_W  = CW * 0.08;
    const STATUS_COL_W = CW * 0.065;
    const FIXED_W      = CW * 0.04 + CW * 0.11 + CW * 0.115 + CW * 0.10 + STATUS_COL_W + PHOTO_COL_W;
    const sColW        = (CW - FIXED_W) / n;

    const head = [['No.', 'Parameter', 'Specification', 'Instrument',
      ...Array.from({ length: n }, (_, i) => `${i + 1}`),
      'Status', 'Photo']];

    const body = data.dimRows.map(r => [
      r.index, r.parameter, r.specificat, r.instrument,
      ...r.samples.slice(0, n).concat(Array(Math.max(0, n - r.samples.length)).fill('')),
      r.status_1, '',
    ]);

    doc.autoTable({
      startY: y,
      margin: { left: ML, right: MR },
      tableWidth: CW,
      head, body,
      styles: {
        fontSize: 7.5, cellPadding: 2, lineColor: BORDER, lineWidth: 0.3,
        halign: 'center', valign: 'middle', minCellHeight: ROW_H,
      },
      headStyles: { fillColor: GRAY, textColor: DARK, fontStyle: 'bold', fontSize: 7 },
      columnStyles: {
        0: { cellWidth: CW * 0.04 },
        1: { cellWidth: CW * 0.11, halign: 'left' },
        2: { cellWidth: CW * 0.115 },
        3: { cellWidth: CW * 0.10 },
        [4 + n]: { cellWidth: STATUS_COL_W },
        [5 + n]: { cellWidth: PHOTO_COL_W },
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [4 + i, { cellWidth: sColW }])),
      },
      didDrawCell: (d) => {
        if (d.section === 'body' && d.column.index === 5 + n) {
          const img = dimPhotoMap[d.row.index];
          if (img) drawImgInCell(doc, img, d.cell.x, d.cell.y, d.cell.width, d.cell.height);
        }
      },
    });
  }

  // ── PAGE 3: VISUAL INSPECTION ─────────────────────────────────
  if (data.visRows && data.visRows.length > 0) {
    doc.addPage('a4', 'landscape');
    y = MT;
    y = sectionHeading(doc, 'Visual Inspection', y);

    const ROW_H       = 14;
    const PHOTO_COL_W = CW * 0.09;

    const head = [['No.', 'Parameter', 'Status', 'Comments', 'Photo']];
    const body = data.visRows.map(r => [r.index, r.parameter, r.status, r.comments, '']);

    doc.autoTable({
      startY: y,
      margin: { left: ML, right: MR },
      tableWidth: CW,
      head, body,
      styles: {
        fontSize: 8, cellPadding: 2.5, lineColor: BORDER, lineWidth: 0.3,
        halign: 'center', valign: 'middle', minCellHeight: ROW_H,
      },
      headStyles: { fillColor: GRAY, textColor: DARK, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: CW * 0.06 },
        1: { cellWidth: CW * 0.22, halign: 'left' },
        2: { cellWidth: CW * 0.10 },
        3: { cellWidth: CW - CW * 0.06 - CW * 0.22 - CW * 0.10 - PHOTO_COL_W, halign: 'left' },
        4: { cellWidth: PHOTO_COL_W },
      },
      didDrawCell: (d) => {
        if (d.section === 'body' && d.column.index === 4) {
          const img = visPhotoMap[d.row.index];
          if (img) drawImgInCell(doc, img, d.cell.x, d.cell.y, d.cell.width, d.cell.height);
        }
      },
    });

    y = doc.lastAutoTable.finalY + 4;

    if (inspImage) {
      if (y > PH - MB - 30) { doc.addPage('a4', 'landscape'); y = MT; }
      try {
        const props = doc.getImageProperties(inspImage);
        const maxW = CW * 0.5, maxH = PH - y - MB - 4;
        let iw = props.width, ih = props.height;
        const s = Math.min(maxW / iw, maxH / ih, 1);
        iw *= s; ih *= s;
        const fmt = inspImage.includes('image/png') ? 'PNG' : 'JPEG';
        doc.addImage(inspImage, fmt, ML + (CW - iw) / 2, y, iw, ih);
      } catch (e) { }
    }
  }

  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { generateQIR };
