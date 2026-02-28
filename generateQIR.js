/**
 * generateQIR.js
 * Generates the QIR PDF in Node using jsPDF + jspdf-autotable.
 * Ported directly from the browser web tool — same layout, same logic.
 * Returns a Buffer of the PDF bytes.
 */

const { jsPDF } = require('jspdf');
require('jspdf-autotable');

// ── Constants ────────────────────────────────────────────────
const PW = 297, PH = 210, ML = 10, MR = 10, MT = 12, MB = 12;
const CW = PW - ML - MR;
const GRAY   = [240, 240, 240];
const BORDER = [127, 128, 128];
const DARK   = [26,  26,  46 ];

// ── Helpers ──────────────────────────────────────────────────

/**
 * Draw a section heading — consistent font/size across all pages.
 */
function sectionHeading(doc, label, y) {
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.text(label, PW / 2, y, { align: 'center' });
  return y + 6;
}

/**
 * Draw an image inside a table cell, preserving aspect ratio, centred.
 * src: base64 data URL  OR  null/empty → skip
 */
function drawImgInCell(doc, src, cx, cy, cw, ch, pad = 1.5) {
  if (!src || !src.startsWith('data:')) return;
  try {
    const props = doc.getImageProperties(src);
    const maxW = cw - pad * 2;
    const maxH = ch - pad * 2;
    let iw = props.width, ih = props.height;
    const scale = Math.min(maxW / iw, maxH / ih, 1);
    iw *= scale; ih *= scale;
    const ox = cx + pad + (maxW - iw) / 2;
    const oy = cy + pad + (maxH - ih) / 2;
    const fmt = src.includes('image/png') ? 'PNG' : 'JPEG';
    doc.addImage(src, fmt, ox, oy, iw, ih);
  } catch (e) {
    // image failed to load — skip silently
  }
}

// ── Main export ───────────────────────────────────────────────

/**
 * @param {object} data  — same shape as collectData() in the web tool
 *   {
 *     report_no, submission_date,
 *     part_name, rm_grade, customer, item_code, heat_no, order_qty, remarks,
 *     conclusion,
 *     part_drawing,   // base64 data URL or null
 *     insp_image,     // base64 data URL or null
 *     sampleCount,    // number
 *     dimRows: [{index, parameter, specificat, instrument, samples[], status_1, qc_photo}]
 *     visRows: [{index, parameter, status, comments, photo}]
 *   }
 * @returns {Buffer} PDF bytes
 */
function generateQIR(data) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  let y = MT;

  // ── PAGE 1: HEADER + PART INFO ─────────────────────────────

  // Header box
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);
  doc.rect(ML, y, CW, 16);
  doc.line(ML + CW * 0.28, y, ML + CW * 0.28, y + 16);
  doc.line(ML + CW * 0.73, y, ML + CW * 0.73, y + 16);

  // Logo placeholder
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text('[LOGO]', ML + CW * 0.14, y + 9, { align: 'center' });

  // Title
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK);
  doc.text('Quality Inspection Report', ML + CW * 0.505, y + 10, { align: 'center' });

  // Doc info
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60, 60, 60);
  doc.text(`Doc No: ${data.report_no}`,       ML + CW * 0.76, y + 6);
  doc.text(`Date:   ${data.submission_date}`,  ML + CW * 0.76, y + 12);

  y += 20;
  // Reset colors after header
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.3);

  // Part info table
  doc.autoTable({
    startY: y,
    margin: { left: ML, right: MR },
    tableWidth: CW,
    head: [],
    body: [
      ['Part Name', data.part_name,  'RM Grade', data.rm_grade,  'Customer', data.customer ],
      ['Item Code', data.item_code,  'Heat No.', data.heat_no,   'Order Qty',data.order_qty],
      ...(data.remarks
        ? [['Note', { content: data.remarks, colSpan: 5, styles: { halign: 'left' } }]]
        : [])
    ],
    styles: { fontSize: 8, cellPadding: 2.5, lineColor: BORDER, lineWidth: 0.3 },
    columnStyles: {
      0: { fontStyle: 'bold', fillColor: GRAY, cellWidth: CW * 0.09 },
      2: { fontStyle: 'bold', fillColor: GRAY, cellWidth: CW * 0.09 },
      4: { fontStyle: 'bold', fillColor: GRAY, cellWidth: CW * 0.09 },
    },
  });
  y = doc.lastAutoTable.finalY + 4;

  // ── PAGE 2: PART DRAWING (optional) ───────────────────────
  if (data.part_drawing) {
    doc.addPage('a4', 'landscape');
    y = MT;
    y = sectionHeading(doc, 'Part Drawing', y);
    try {
      const props = doc.getImageProperties(data.part_drawing);
      const maxW = CW * 0.9, maxH = PH - y - MB - 4;
      let iw = props.width, ih = props.height;
      const s = Math.min(maxW / iw, maxH / ih, 1);
      iw *= s; ih *= s;
      const fmt = data.part_drawing.includes('image/png') ? 'PNG' : 'JPEG';
      doc.addImage(data.part_drawing, fmt, ML + (CW - iw) / 2, y, iw, ih);
    } catch (e) {}
  }

  // ── PAGE 3: DIMENSIONAL INSPECTION ────────────────────────
  doc.addPage('a4', 'landscape');
  y = MT;
  y = sectionHeading(doc, 'Dimensional Inspection', y);

  if (data.dimRows && data.dimRows.length > 0) {
    const n = data.sampleCount || 5;
    const ROW_H       = 14;
    const PHOTO_COL_W = CW * 0.08;
    const STATUS_COL_W= CW * 0.065;
    const FIXED_W     = CW * 0.04 + CW * 0.11 + CW * 0.11 + CW * 0.10 + STATUS_COL_W + PHOTO_COL_W;
    const sColW       = (CW - FIXED_W) / n;

    const head = [['No.', 'Parameter', 'Specification', 'Instrument',
      ...Array.from({ length: n }, (_, i) => `Obs ${i + 1}`),
      'Status', 'Photo']];

    const body = data.dimRows.map(r => [
      r.index, r.parameter, r.specificat, r.instrument,
      ...r.samples,
      r.status_1, ''   // photo cell drawn manually
    ]);

    doc.autoTable({
      startY: y,
      margin: { left: ML, right: MR },
      tableWidth: CW,
      head, body,
      styles: {
        fontSize: 7.5, cellPadding: 2, lineColor: BORDER, lineWidth: 0.3,
        halign: 'center', valign: 'middle', minCellHeight: ROW_H
      },
      headStyles: { fillColor: GRAY, textColor: DARK, fontStyle: 'bold', fontSize: 7 },
      columnStyles: {
        0: { cellWidth: CW * 0.04 },
        1: { cellWidth: CW * 0.11, halign: 'left' },
        2: { cellWidth: CW * 0.11 },
        3: { cellWidth: CW * 0.10 },
        [4 + n]: { cellWidth: STATUS_COL_W },
        [5 + n]: { cellWidth: PHOTO_COL_W },
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [4 + i, { cellWidth: sColW }]))
      },
      didDrawCell: (d) => {
        if (d.section === 'body' && d.column.index === 5 + n) {
          const row = data.dimRows[d.row.index];
          if (row) drawImgInCell(doc, row.qc_photo, d.cell.x, d.cell.y, d.cell.width, d.cell.height);
        }
      }
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  // ── PAGE 4: VISUAL INSPECTION ──────────────────────────────
  doc.addPage('a4', 'landscape');
  y = MT;
  y = sectionHeading(doc, 'Visual Inspection', y);

  if (data.visRows && data.visRows.length > 0) {
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
        halign: 'center', valign: 'middle', minCellHeight: ROW_H
      },
      headStyles: { fillColor: GRAY, textColor: DARK, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: CW * 0.06 },
        1: { cellWidth: CW * 0.22, halign: 'left' },
        2: { cellWidth: CW * 0.10 },
        3: { cellWidth: CW - CW * 0.06 - CW * 0.22 - CW * 0.10 - PHOTO_COL_W, halign: 'left' },
        4: { cellWidth: PHOTO_COL_W }
      },
      didDrawCell: (d) => {
        if (d.section === 'body' && d.column.index === 4) {
          const row = data.visRows[d.row.index];
          if (row) drawImgInCell(doc, row.photo, d.cell.x, d.cell.y, d.cell.width, d.cell.height);
        }
      }
    });
    y = doc.lastAutoTable.finalY + 4;

    // Optional overview image
    if (data.insp_image) {
      if (y > PH - MB - 30) { doc.addPage('a4', 'landscape'); y = MT; }
      doc.setFontSize(8); doc.setFont('helvetica', 'italic'); doc.setTextColor(120, 120, 120);
      doc.text('Overview Inspection Image:', ML, y);
      y += 3;
      try {
        const props = doc.getImageProperties(data.insp_image);
        const maxW = CW * 0.5, maxH = PH - y - MB - 4;
        let iw = props.width, ih = props.height;
        const s = Math.min(maxW / iw, maxH / ih, 1);
        iw *= s; ih *= s;
        const fmt = data.insp_image.includes('image/png') ? 'PNG' : 'JPEG';
        doc.addImage(data.insp_image, fmt, ML + (CW - iw) / 2, y, iw, ih);
        y += ih + 4;
      } catch (e) {}
    }
  }

  // ── CONCLUSION ─────────────────────────────────────────────
  if (data.conclusion) {
    if (y > PH - MB - 20) { doc.addPage('a4', 'landscape'); y = MT; }
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(...DARK);
    doc.text('Conclusion:', ML, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(data.conclusion, CW - 24);
    doc.text(lines, ML + 24, y);
  }

  // Return as Node Buffer
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { generateQIR };
