import { AppConfig, ScheduleSolution } from '../types';
import { ITALIAN_MONTHS } from '../defaultData';

export interface JpegExportOptions {
  includeSummaryFooter?: boolean; // false = Clean Workers Version without bottom hour calculation table
  hideHoursColumn?: boolean;
}

/**
 * Renders a crisp, print-ready 300 DPI equivalent high-resolution JPEG of the monthly schedule
 * cloning the exact paper layout:
 * - Pastel yellow fill (#FEF08A) for Bar (6-12, 6-13)
 * - Vivid red text (#DC2626) for Morning (7-13, 7-14)
 * - Bold black text (#000000) for Afternoon (14-20, 14-21)
 * - Empty cells for Rest / Absence
 * - Thick forest-green separator (#14532D) below every Sunday
 *
 * When `options.includeSummaryFooter === false`, the bottom hour-calculation table is completely omitted
 * so the image can be sent directly to workers via WhatsApp or printed for the noticeboard.
 */
export function exportScheduleToJpeg(
  config: AppConfig,
  solution: ScheduleSolution,
  options: JpegExportOptions = { includeSummaryFooter: false }
): void {
  const includeSummaryFooter = options.includeSummaryFooter ?? false;

  const activeWorkers = config.workers
    .filter((w) => w.active)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'Fisso' ? -1 : 1;
      return a.priority - b.priority;
    });

  const monthObj = ITALIAN_MONTHS.find((m) => m.value === config.month) || ITALIAN_MONTHS[10];

  // High-DPI multiplier (3x scale for 300 DPI print crispness)
  const scale = 3;
  const margin = 28;
  const titleHeight = 44;
  const headerRow1H = 34;
  const headerRow2H = 24;
  const rowH = 26;
  const summaryRowH = 26;

  const colDateW = 78;
  const colDayW = 56;
  const colShiftW = 74;
  const colHoursW = 42;
  const workerPairW = colShiftW + colHoursW;

  const tableW = colDateW + colDayW + activeWorkers.length * workerPairW;
  const numDays = config.calendar.length;
  const numSummaryRows = includeSummaryFooter ? 4 : 0;
  const footerGap = includeSummaryFooter ? 14 : 0;
  const tableH =
    headerRow1H + headerRow2H + numDays * rowH + footerGap + numSummaryRows * summaryRowH;

  const canvasW = tableW + margin * 2;
  const canvasH = titleHeight + tableH + margin * 2;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW * scale;
  canvas.height = canvasH * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(scale, scale);

  // White paper background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Title banner
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 18px "Plus Jakarta Sans", Calibri, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `TURNI DONNE PULIZIE RT — ${monthObj.name.toUpperCase()} ${config.year}`,
    margin,
    margin + 16
  );

  ctx.fillStyle = '#475569';
  ctx.font = '500 11px "Plus Jakarta Sans", Calibri, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(
    `Legenda: Giallo = Bar (6-12/6-13)  |  Rosso = Mattina (7-13/7-14)  |  Nero Grassetto = Pomeriggio (14-20/14-21)`,
    canvasW - margin,
    margin + 16
  );

  const startX = margin;
  const startY = margin + titleHeight;

  // Draw Header Row 1 & Row 2 backgrounds
  ctx.fillStyle = '#E2E8F0';
  ctx.fillRect(startX, startY, colDateW + colDayW, headerRow1H + headerRow2H);

  activeWorkers.forEach((w, idx) => {
    const wx = startX + colDateW + colDayW + idx * workerPairW;
    ctx.fillStyle = w.type === 'Sostituta' ? '#F1F5F9' : '#E2E8F0';
    ctx.fillRect(wx, startY, workerPairW, headerRow1H);

    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(wx, startY + headerRow1H, workerPairW, headerRow2H);
  });

  // Header Texts
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 12px "Plus Jakarta Sans", Calibri, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Data', startX + colDateW / 2, startY + (headerRow1H + headerRow2H) / 2);
  ctx.fillText(
    'Giorno',
    startX + colDateW + colDayW / 2,
    startY + (headerRow1H + headerRow2H) / 2
  );

  activeWorkers.forEach((w, idx) => {
    const wx = startX + colDateW + colDayW + idx * workerPairW;
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 11.5px "Plus Jakarta Sans", Calibri, sans-serif';
    ctx.fillText(w.name, wx + workerPairW / 2, startY + headerRow1H / 2);

    ctx.fillStyle = '#475569';
    ctx.font = 'bold 10px "Plus Jakarta Sans", Calibri, sans-serif';
    ctx.fillText('Turno', wx + colShiftW / 2, startY + headerRow1H + headerRow2H / 2);
    ctx.fillText('Ore', wx + colShiftW + colHoursW / 2, startY + headerRow1H + headerRow2H / 2);
  });

  // Header grid borders
  ctx.strokeStyle = '#64748B';
  ctx.lineWidth = 1;
  ctx.strokeRect(startX, startY, colDateW, headerRow1H + headerRow2H);
  ctx.strokeRect(startX + colDateW, startY, colDayW, headerRow1H + headerRow2H);

  activeWorkers.forEach((_, idx) => {
    const wx = startX + colDateW + colDayW + idx * workerPairW;
    ctx.strokeRect(wx, startY, workerPairW, headerRow1H);
    ctx.strokeRect(wx, startY + headerRow1H, colShiftW, headerRow2H);
    ctx.strokeRect(wx + colShiftW, startY + headerRow1H, colHoursW, headerRow2H);
  });

  // Daily Rows
  const bodyStartY = startY + headerRow1H + headerRow2H;

  config.calendar.forEach((dayReq, rIdx) => {
    const ry = bodyStartY + rIdx * rowH;
    const isSunday = dayReq.dayOfWeek === 0;

    if (isSunday) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(startX, ry, tableW, rowH);
    }

    // Date & Day cells
    ctx.fillStyle = isSunday || dayReq.isHoliday ? '#14532D' : '#0F172A';
    ctx.font = `${
      isSunday || dayReq.isHoliday ? 'bold' : '500'
    } 11.5px "IBM Plex Mono", Calibri, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(dayReq.dateStr, startX + colDateW / 2, ry + rowH / 2);

    ctx.font = `${
      isSunday || dayReq.isHoliday ? 'bold' : '500'
    } 11.5px "Plus Jakarta Sans", Calibri, sans-serif`;
    ctx.fillText(dayReq.dayAbbr, startX + colDateW + colDayW / 2, ry + rowH / 2);

    // Worker shift & hours cells
    activeWorkers.forEach((w, wIdx) => {
      const wx = startX + colDateW + colDayW + wIdx * workerPairW;
      const cell = solution.assignments[dayReq.day]?.[w.id];

      if (cell && cell.shiftType !== 'OFF') {
        if (cell.shiftType === 'BAR') {
          ctx.fillStyle = '#FEF08A';
          ctx.fillRect(wx + 0.5, ry + 0.5, colShiftW - 1, rowH - 1);
          ctx.fillStyle = '#0F172A';
          ctx.font = 'bold 12px "IBM Plex Mono", Calibri, sans-serif';
        } else if (cell.shiftType === 'MORNING') {
          ctx.fillStyle = '#DC2626';
          ctx.font = '500 12px "IBM Plex Mono", Calibri, sans-serif';
        } else if (cell.shiftType === 'AFTERNOON') {
          ctx.fillStyle = '#000000';
          ctx.font = 'bold 12px "IBM Plex Mono", Calibri, sans-serif';
        }

        ctx.fillText(cell.label, wx + colShiftW / 2, ry + rowH / 2);

        // Hours column
        ctx.fillStyle = '#334155';
        ctx.font = '500 11.5px "IBM Plex Mono", Calibri, sans-serif';
        ctx.fillText(String(cell.hours), wx + colShiftW + colHoursW / 2, ry + rowH / 2);
      }

      // Standard thin cell borders
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 0.75;
      ctx.strokeRect(wx, ry, colShiftW, rowH);
      ctx.strokeRect(wx + colShiftW, ry, colHoursW, rowH);
    });

    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 0.75;
    ctx.strokeRect(startX, ry, colDateW, rowH);
    ctx.strokeRect(startX + colDateW, ry, colDayW, rowH);

    // Thick Forest Green horizontal separator under every Sunday
    if (isSunday) {
      ctx.strokeStyle = '#14532D';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(startX, ry + rowH);
      ctx.lineTo(startX + tableW, ry + rowH);
      ctx.stroke();
    }
  });

  // Optional Footer Summary Section (Only if includeSummaryFooter === true)
  if (includeSummaryFooter) {
    const summaryStartY = bodyStartY + numDays * rowH + footerGap;
    const summaryLabels = [
      {
        title: 'TOTALE ORE',
        key: 'totalHours' as const,
        bg: '#E2E8F0',
        color: '#0F172A',
        bold: true,
      },
      {
        title: 'GIORNI LAV.',
        key: 'workedDays' as const,
        bg: '#F8FAFC',
        color: '#334155',
        bold: false,
      },
      {
        title: 'MATTINE',
        key: 'morningCount' as const,
        bg: '#FFFFFF',
        color: '#DC2626',
        bold: false,
      },
      {
        title: 'POMERIGGI',
        key: 'afternoonCount' as const,
        bg: '#FFFFFF',
        color: '#000000',
        bold: true,
      },
    ];

    summaryLabels.forEach((sRow, sIdx) => {
      const sy = summaryStartY + sIdx * summaryRowH;
      ctx.fillStyle = sRow.bg;
      ctx.fillRect(startX, sy, tableW, summaryRowH);

      ctx.strokeStyle = '#64748B';
      ctx.lineWidth = 0.85;
      ctx.strokeRect(startX, sy, colDateW + colDayW, summaryRowH);

      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 10.5px "Plus Jakarta Sans", Calibri, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(sRow.title, startX + 8, sy + summaryRowH / 2);

      ctx.textAlign = 'center';
      activeWorkers.forEach((w, wIdx) => {
        const wx = startX + colDateW + colDayW + wIdx * workerPairW;
        ctx.strokeRect(wx, sy, workerPairW, summaryRowH);
        const val = solution.workerStats[w.id]?.[sRow.key] ?? 0;
        ctx.fillStyle = sRow.color;
        ctx.font = `${sRow.bold ? 'bold' : '500'} 11.5px "IBM Plex Mono", Calibri, sans-serif`;
        ctx.fillText(String(val), wx + workerPairW / 2, sy + summaryRowH / 2);
      });
    });
  }

  // Outer thick border around main schedule
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(startX, startY, tableW, headerRow1H + headerRow2H + numDays * rowH);

  // Download high-resolution JPEG (98% quality)
  const suffix = includeSummaryFooter ? 'Completo_Con_Totali' : 'Prospetto_Lavoratrici';
  const dataUrl = canvas.toDataURL('image/jpeg', 0.98);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `Turni_Donne_Pulizie_RT_${monthObj.name}_${config.year}_${suffix}.jpeg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
