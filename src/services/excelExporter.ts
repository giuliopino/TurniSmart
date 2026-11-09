import ExcelJS from 'exceljs';
import {
  AppConfig,
  CellAssignment,
  ConfirmedScheduleEntry,
  DailyRequirement,
  HistoricalWorkerStats,
  ScheduleSolution,
} from '../types';
import { formatPeriodLabel, generateCalendarForMonth, ITALIAN_MONTHS } from '../defaultData';

function colIndexToLetter(colIdx: number): string {
  let temp = colIdx;
  let letter = '';
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

/**
 * Generates an exact paper-clone .xlsx file with native Excel formulas (SUM, COUNTIF),
 * yellow pastel Bar cells, red Morning cells, bold black Afternoon cells, thick forest-green Sunday borders,
 * AND a second sheet "Analisi Costi Personale" with full economic estimation by worker, shift category, and role.
 */
export async function exportScheduleToExcel(
  config: AppConfig,
  solution: ScheduleSolution
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Turni di Lavoro RT';
  workbook.created = new Date();

  const monthObj = ITALIAN_MONTHS.find((m) => m.value === config.month) || ITALIAN_MONTHS[10];
  const sheetName = `Turni ${monthObj.name} ${config.year}`;
  const ws = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }],
  });

  const activeWorkers = config.workers
    .filter((w) => w.active)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'Fisso' ? -1 : 1;
      return a.priority - b.priority;
    });

  // Set Column Widths
  ws.getColumn(1).width = 11; // Data (01-nov)
  ws.getColumn(2).width = 8;  // Giorno (Dom, Lun...)

  activeWorkers.forEach((_, idx) => {
    const shiftCol = 3 + idx * 2;
    const hoursCol = 4 + idx * 2;
    ws.getColumn(shiftCol).width = 10;
    ws.getColumn(hoursCol).width = 5.5;
  });

  const thinBorder: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF475569' } };
  const greenDoubleBottom: Partial<ExcelJS.Border> = { style: 'medium', color: { argb: 'FF14532D' } };

  // Row 1 & Row 2: Headers
  const headerRow1 = ws.getRow(1);
  const headerRow2 = ws.getRow(2);
  headerRow1.height = 24;
  headerRow2.height = 19;

  ws.mergeCells(1, 1, 2, 1);
  const dataHeader = ws.getCell(1, 1);
  dataHeader.value = 'Data';
  dataHeader.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
  dataHeader.alignment = { vertical: 'middle', horizontal: 'center' };
  dataHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

  ws.mergeCells(1, 2, 2, 2);
  const dayHeader = ws.getCell(1, 2);
  dayHeader.value = 'Giorno';
  dayHeader.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
  dayHeader.alignment = { vertical: 'middle', horizontal: 'center' };
  dayHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

  activeWorkers.forEach((w, idx) => {
    const shiftCol = 3 + idx * 2;
    const hoursCol = 4 + idx * 2;
    ws.mergeCells(1, shiftCol, 1, hoursCol);

    const nameCell = ws.getCell(1, shiftCol);
    nameCell.value = w.name;
    nameCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
    nameCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    nameCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: w.type === 'Sostituta' ? 'FFF1F5F9' : 'FFE2E8F0' },
    };

    const subShift = ws.getCell(2, shiftCol);
    subShift.value = 'Turno';
    subShift.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FF334155' } };
    subShift.alignment = { vertical: 'middle', horizontal: 'center' };
    subShift.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

    const subHours = ws.getCell(2, hoursCol);
    subHours.value = 'Ore';
    subHours.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FF334155' } };
    subHours.alignment = { vertical: 'middle', horizontal: 'center' };
    subHours.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  });

  // Apply borders to header cells
  const totalCols = 2 + activeWorkers.length * 2;
  for (let r = 1; r <= 2; r++) {
    for (let c = 1; c <= totalCols; c++) {
      ws.getCell(r, c).border = {
        top: thinBorder,
        left: thinBorder,
        right: thinBorder,
        bottom: r === 2 ? { style: 'medium', color: { argb: 'FF0F172A' } } : thinBorder,
      };
    }
  }

  // Rows 3 .. 3 + daysInMonth - 1: Daily schedule
  const startDataRow = 3;
  config.calendar.forEach((dayReq, idx) => {
    const rowIdx = startDataRow + idx;
    const row = ws.getRow(rowIdx);
    row.height = 19;

    const isSunday = dayReq.dayOfWeek === 0;
    const bottomBorderStyle = isSunday ? greenDoubleBottom : thinBorder;

    const cDate = ws.getCell(rowIdx, 1);
    cDate.value = dayReq.dateStr;
    cDate.font = {
      name: 'Calibri',
      size: 10,
      bold: isSunday || dayReq.isHoliday,
      color: { argb: isSunday || dayReq.isHoliday ? 'FF14532D' : 'FF0F172A' },
    };
    cDate.alignment = { vertical: 'middle', horizontal: 'center' };
    cDate.border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: bottomBorderStyle };

    const cDay = ws.getCell(rowIdx, 2);
    cDay.value = dayReq.dayAbbr;
    cDay.font = {
      name: 'Calibri',
      size: 10,
      bold: isSunday || dayReq.isHoliday,
      color: { argb: isSunday || dayReq.isHoliday ? 'FF14532D' : 'FF334155' },
    };
    cDay.alignment = { vertical: 'middle', horizontal: 'center' };
    cDay.border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: bottomBorderStyle };

    activeWorkers.forEach((w, wIdx) => {
      const shiftCol = 3 + wIdx * 2;
      const hoursCol = 4 + wIdx * 2;
      const shiftColLet = colIndexToLetter(shiftCol);
      const shiftCellRef = `${shiftColLet}${rowIdx}`;
      const cellAssign = solution.assignments[dayReq.day]?.[w.id];

      const cShift = ws.getCell(rowIdx, shiftCol);
      const cHours = ws.getCell(rowIdx, hoursCol);

      const dynamicHoursFormula = `IF(TRIM(${shiftCellRef})="","",IFERROR(VALUE(MID(${shiftCellRef},FIND("-",${shiftCellRef})+1,10))-VALUE(LEFT(${shiftCellRef},FIND("-",${shiftCellRef})-1)),0))`;

      if (cellAssign && cellAssign.shiftType !== 'OFF') {
        cShift.value = cellAssign.label;
        cHours.value = {
          formula: dynamicHoursFormula,
          result: cellAssign.hours,
        };

        if (cellAssign.shiftType === 'BAR') {
          cShift.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFEF08A' },
          };
          cShift.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
        } else if (cellAssign.shiftType === 'MORNING') {
          cShift.font = { name: 'Calibri', size: 10, bold: false, color: { argb: 'FFDC2626' } };
        } else if (cellAssign.shiftType === 'AFTERNOON') {
          cShift.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } };
        }

        cHours.font = { name: 'Calibri', size: 10, bold: false, color: { argb: 'FF334155' } };
      } else {
        cShift.value = null;
        cHours.value = {
          formula: dynamicHoursFormula,
          result: '',
        };
        cHours.font = { name: 'Calibri', size: 10, bold: false, color: { argb: 'FF334155' } };
      }

      cShift.alignment = { vertical: 'middle', horizontal: 'center' };
      cHours.alignment = { vertical: 'middle', horizontal: 'center' };

      cShift.border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: bottomBorderStyle };
      cHours.border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: bottomBorderStyle };
    });
  });

  // Summary Rows with Native Excel Formulas (SUM / SOMMA, COUNTIF, COUNTA)
  const endDataRow = startDataRow + config.calendar.length - 1;
  const totalHoursRowIdx = endDataRow + 2;
  const totalDaysRowIdx = endDataRow + 3;
  const countMorningRowIdx = endDataRow + 4;
  const countAfternoonRowIdx = endDataRow + 5;
  const countBarRowIdx = endDataRow + 6;

  const summaryRows = [
    { rowIdx: totalHoursRowIdx, label: 'Totale Ore Mensili' },
    { rowIdx: totalDaysRowIdx, label: 'GIORNI LAVORATI' },
    { rowIdx: countMorningRowIdx, label: 'TURNI MATTINA (7-*)' },
    { rowIdx: countAfternoonRowIdx, label: 'TURNI POMERIGGIO (14-*)' },
    { rowIdx: countBarRowIdx, label: 'TURNI BAR (6-*)' },
  ];

  summaryRows.forEach(({ rowIdx, label }) => {
    ws.mergeCells(rowIdx, 1, rowIdx, 2);
    const lblCell = ws.getCell(rowIdx, 1);
    lblCell.value = label;
    lblCell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FF0F172A' } };
    lblCell.alignment = { vertical: 'middle', horizontal: 'left' };
    lblCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    ws.getCell(rowIdx, 1).border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: thinBorder };
    ws.getCell(rowIdx, 2).border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: thinBorder };
  });

  activeWorkers.forEach((w, wIdx) => {
    const shiftCol = 3 + wIdx * 2;
    const hoursCol = 4 + wIdx * 2;
    const shiftColLet = colIndexToLetter(shiftCol);
    const hoursColLet = colIndexToLetter(hoursCol);
    const shiftRange = `${shiftColLet}${startDataRow}:${shiftColLet}${endDataRow}`;
    const hoursRange = `${hoursColLet}${startDataRow}:${hoursColLet}${endDataRow}`;

    const stats = solution.workerStats[w.id];

    // 1. Total Hours Formula
    ws.mergeCells(totalHoursRowIdx, shiftCol, totalHoursRowIdx, hoursCol);
    const cTotHours = ws.getCell(totalHoursRowIdx, shiftCol);
    cTotHours.value = { formula: `SUM(${hoursRange})`, result: stats?.totalHours || 0 };
    cTotHours.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cTotHours.alignment = { vertical: 'middle', horizontal: 'center' };
    cTotHours.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

    // 2. Worked Days Formula
    ws.mergeCells(totalDaysRowIdx, shiftCol, totalDaysRowIdx, hoursCol);
    const cTotDays = ws.getCell(totalDaysRowIdx, shiftCol);
    cTotDays.value = { formula: `COUNT(${hoursRange})`, result: stats?.workedDays || 0 };
    cTotDays.font = { name: 'Calibri', size: 10, bold: false, color: { argb: 'FF334155' } };
    cTotDays.alignment = { vertical: 'middle', horizontal: 'center' };

    // 3. Morning Shifts COUNTIF
    ws.mergeCells(countMorningRowIdx, shiftCol, countMorningRowIdx, hoursCol);
    const cMorn = ws.getCell(countMorningRowIdx, shiftCol);
    cMorn.value = { formula: `COUNTIF(${shiftRange},"7-*")`, result: stats?.morningCount || 0 };
    cMorn.font = { name: 'Calibri', size: 10, bold: false, color: { argb: 'FFDC2626' } };
    cMorn.alignment = { vertical: 'middle', horizontal: 'center' };

    // 4. Afternoon Shifts COUNTIF
    ws.mergeCells(countAfternoonRowIdx, shiftCol, countAfternoonRowIdx, hoursCol);
    const cAft = ws.getCell(countAfternoonRowIdx, shiftCol);
    cAft.value = { formula: `COUNTIF(${shiftRange},"14-*")`, result: stats?.afternoonCount || 0 };
    cAft.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF000000' } };
    cAft.alignment = { vertical: 'middle', horizontal: 'center' };

    // 5. Bar Shifts COUNTIF
    ws.mergeCells(countBarRowIdx, shiftCol, countBarRowIdx, hoursCol);
    const cBar = ws.getCell(countBarRowIdx, shiftCol);
    cBar.value = { formula: `COUNTIF(${shiftRange},"6-*")`, result: stats?.barCount || 0 };
    cBar.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF854D0E' } };
    cBar.alignment = { vertical: 'middle', horizontal: 'center' };

    [
      totalHoursRowIdx,
      totalDaysRowIdx,
      countMorningRowIdx,
      countAfternoonRowIdx,
      countBarRowIdx,
    ].forEach((rIdx) => {
      ws.getCell(rIdx, shiftCol).border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: thinBorder };
      ws.getCell(rIdx, hoursCol).border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: thinBorder };
    });
  });

  // ============================================================================
  // SHEET 2: ANALISI ECONOMICA & STIMA COSTO PERSONALE PER MESE E CATEGORIA
  // ============================================================================
  const wsCost = workbook.addWorksheet('Analisi Costi Personale', {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 3 }],
  });

  const costCols = [
    { col: 1, width: 10, header: 'ID #' },
    { col: 2, width: 22, header: 'Dipendente' },
    { col: 3, width: 18, header: 'Ruolo / Contratto' },
    { col: 4, width: 12, header: 'Giorni Lav.' },
    { col: 5, width: 12, header: 'Ore BAR' },
    { col: 6, width: 14, header: 'Ore MATTINA' },
    { col: 7, width: 15, header: 'Ore POMERIGGIO' },
    { col: 8, width: 13, header: 'Ore Totali' },
    { col: 9, width: 13, header: 'Ore Festivi' },
    { col: 10, width: 16, header: 'Tariffa Oraria (€/h)' },
    { col: 11, width: 15, header: 'Magg. Festivi (%)' },
    { col: 12, width: 16, header: 'Costo Turno BAR (€)' },
    { col: 13, width: 17, header: 'Costo MATTINA (€)' },
    { col: 14, width: 18, header: 'Costo POMERIGGIO (€)' },
    { col: 15, width: 17, header: 'Extra Festivi (€)' },
    { col: 16, width: 22, header: 'Costo Totale Stimato (€)' },
  ];

  costCols.forEach((c) => {
    wsCost.getColumn(c.col).width = c.width;
  });

  wsCost.mergeCells(1, 1, 1, 16);
  const titleCell = wsCost.getCell(1, 1);
  titleCell.value = `ANALISI ECONOMICA COSTO PERSONALE — ${formatPeriodLabel(config).toUpperCase()}`;
  titleCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  wsCost.getRow(1).height = 28;

  const costHeaderRow = wsCost.getRow(3);
  costHeaderRow.height = 22;
  costCols.forEach((c) => {
    const cell = wsCost.getCell(3, c.col);
    cell.value = c.header;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    cell.border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: { style: 'medium', color: { argb: 'FF0F172A' } } };
  });

  const firstWorkerCostRow = 4;
  let sumBarHours = 0;
  let sumMorningHours = 0;
  let sumAfternoonHours = 0;
  let sumTotalHours = 0;
  let sumHolidayHours = 0;
  let sumBarCost = 0;
  let sumMorningCost = 0;
  let sumAfternoonCost = 0;
  let sumHolidaySurchargeCost = 0;
  let sumTotalCost = 0;
  let sumFisseCost = 0;
  let sumSostituteCost = 0;
  let sumFisseHours = 0;
  let sumSostituteHours = 0;

  activeWorkers.forEach((w, idx) => {
    const rIdx = firstWorkerCostRow + idx;
    const row = wsCost.getRow(rIdx);
    row.height = 20;
    const st = solution.workerStats[w.id];

    const bH = st?.barHours || 0;
    const mH = st?.morningHours || 0;
    const aH = st?.afternoonHours || 0;
    const totH = st?.totalHours || 0;
    const holH = st?.holidayHours || 0;
    const rate = st?.hourlyRate || w.hourlyRate || (w.type === 'Sostituta' ? 13.0 : 12.5);
    const holPct =
      w.type === 'Fisso'
        ? typeof w.holidaySurchargePct === 'number' && !Number.isNaN(w.holidaySurchargePct)
          ? w.holidaySurchargePct
          : 20
        : 0;
    const bCost = st?.barCost || Math.round(bH * rate * 100) / 100;
    const mCost = st?.morningCost || Math.round(mH * rate * 100) / 100;
    const aCost = st?.afternoonCost || Math.round(aH * rate * 100) / 100;
    const holCost =
      w.type === 'Fisso'
        ? st?.holidaySurchargeCost ?? Math.round(holH * rate * (holPct / 100) * 100) / 100
        : 0;
    const totCost = st?.totalCost || Math.round((totH * rate + holCost) * 100) / 100;

    sumBarHours += bH;
    sumMorningHours += mH;
    sumAfternoonHours += aH;
    sumTotalHours += totH;
    sumHolidayHours += holH;
    sumBarCost += bCost;
    sumMorningCost += mCost;
    sumAfternoonCost += aCost;
    sumHolidaySurchargeCost += holCost;
    sumTotalCost += totCost;

    if (w.type === 'Fisso') {
      sumFisseCost += totCost;
      sumFisseHours += totH;
    } else {
      sumSostituteCost += totCost;
      sumSostituteHours += totH;
    }

    wsCost.getCell(rIdx, 1).value = Number(w.id) || idx + 1;
    wsCost.getCell(rIdx, 1).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 2).value = w.name;
    wsCost.getCell(rIdx, 2).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };

    wsCost.getCell(rIdx, 3).value =
      w.type === 'Fisso'
        ? 'Fisso (Organico)'
        : w.priority === 5
        ? 'Sostituta (P5 Esclusa)'
        : `Sostituta (P${w.priority})`;
    wsCost.getCell(rIdx, 3).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 4).value = st?.workedDays || 0;
    wsCost.getCell(rIdx, 4).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 5).value = bH;
    wsCost.getCell(rIdx, 5).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 6).value = mH;
    wsCost.getCell(rIdx, 6).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 7).value = aH;
    wsCost.getCell(rIdx, 7).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 8).value = { formula: `SUM(E${rIdx}:G${rIdx})`, result: totH };
    wsCost.getCell(rIdx, 8).font = { name: 'Calibri', size: 10, bold: true };
    wsCost.getCell(rIdx, 8).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 9).value = holH;
    wsCost.getCell(rIdx, 9).alignment = { vertical: 'middle', horizontal: 'center' };

    wsCost.getCell(rIdx, 10).value = rate;
    wsCost.getCell(rIdx, 10).numFmt = '€ #,##0.00';
    wsCost.getCell(rIdx, 10).alignment = { vertical: 'middle', horizontal: 'right' };

    wsCost.getCell(rIdx, 11).value = holPct / 100;
    wsCost.getCell(rIdx, 11).numFmt = '0%';
    wsCost.getCell(rIdx, 11).alignment = { vertical: 'middle', horizontal: 'right' };

    wsCost.getCell(rIdx, 12).value = { formula: `E${rIdx}*J${rIdx}`, result: bCost };
    wsCost.getCell(rIdx, 12).numFmt = '€ #,##0.00';
    wsCost.getCell(rIdx, 12).alignment = { vertical: 'middle', horizontal: 'right' };

    wsCost.getCell(rIdx, 13).value = { formula: `F${rIdx}*J${rIdx}`, result: mCost };
    wsCost.getCell(rIdx, 13).numFmt = '€ #,##0.00';
    wsCost.getCell(rIdx, 13).alignment = { vertical: 'middle', horizontal: 'right' };

    wsCost.getCell(rIdx, 14).value = { formula: `G${rIdx}*J${rIdx}`, result: aCost };
    wsCost.getCell(rIdx, 14).numFmt = '€ #,##0.00';
    wsCost.getCell(rIdx, 14).alignment = { vertical: 'middle', horizontal: 'right' };

    wsCost.getCell(rIdx, 15).value = { formula: `I${rIdx}*J${rIdx}*K${rIdx}`, result: holCost };
    wsCost.getCell(rIdx, 15).numFmt = '€ #,##0.00';
    wsCost.getCell(rIdx, 15).alignment = { vertical: 'middle', horizontal: 'right' };

    wsCost.getCell(rIdx, 16).value = { formula: `H${rIdx}*J${rIdx}+O${rIdx}`, result: totCost };
    wsCost.getCell(rIdx, 16).numFmt = '€ #,##0.00';
    wsCost.getCell(rIdx, 16).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    wsCost.getCell(rIdx, 16).alignment = { vertical: 'middle', horizontal: 'right' };
    wsCost.getCell(rIdx, 16).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

    for (let c = 1; c <= 16; c++) {
      wsCost.getCell(rIdx, c).border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: thinBorder };
    }
  });

  // Grand Total Row
  const lastWorkerCostRow = firstWorkerCostRow + activeWorkers.length - 1;
  const grandTotalRowIdx = lastWorkerCostRow + 1;
  wsCost.getRow(grandTotalRowIdx).height = 24;
  wsCost.mergeCells(grandTotalRowIdx, 1, grandTotalRowIdx, 3);
  wsCost.getCell(grandTotalRowIdx, 1).value = 'TOTALE GENERALE DEL MESE';
  wsCost.getCell(grandTotalRowIdx, 1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };

  wsCost.getCell(grandTotalRowIdx, 5).value = {
    formula: `SUM(E${firstWorkerCostRow}:E${lastWorkerCostRow})`,
    result: sumBarHours,
  };
  wsCost.getCell(grandTotalRowIdx, 6).value = {
    formula: `SUM(F${firstWorkerCostRow}:F${lastWorkerCostRow})`,
    result: sumMorningHours,
  };
  wsCost.getCell(grandTotalRowIdx, 7).value = {
    formula: `SUM(G${firstWorkerCostRow}:G${lastWorkerCostRow})`,
    result: sumAfternoonHours,
  };
  wsCost.getCell(grandTotalRowIdx, 8).value = {
    formula: `SUM(H${firstWorkerCostRow}:H${lastWorkerCostRow})`,
    result: sumTotalHours,
  };
  wsCost.getCell(grandTotalRowIdx, 9).value = {
    formula: `SUM(I${firstWorkerCostRow}:I${lastWorkerCostRow})`,
    result: sumHolidayHours,
  };

  wsCost.getCell(grandTotalRowIdx, 12).value = {
    formula: `SUM(L${firstWorkerCostRow}:L${lastWorkerCostRow})`,
    result: Math.round(sumBarCost * 100) / 100,
  };
  wsCost.getCell(grandTotalRowIdx, 12).numFmt = '€ #,##0.00';

  wsCost.getCell(grandTotalRowIdx, 13).value = {
    formula: `SUM(M${firstWorkerCostRow}:M${lastWorkerCostRow})`,
    result: Math.round(sumMorningCost * 100) / 100,
  };
  wsCost.getCell(grandTotalRowIdx, 13).numFmt = '€ #,##0.00';

  wsCost.getCell(grandTotalRowIdx, 14).value = {
    formula: `SUM(N${firstWorkerCostRow}:N${lastWorkerCostRow})`,
    result: Math.round(sumAfternoonCost * 100) / 100,
  };
  wsCost.getCell(grandTotalRowIdx, 14).numFmt = '€ #,##0.00';

  wsCost.getCell(grandTotalRowIdx, 15).value = {
    formula: `SUM(O${firstWorkerCostRow}:O${lastWorkerCostRow})`,
    result: Math.round(sumHolidaySurchargeCost * 100) / 100,
  };
  wsCost.getCell(grandTotalRowIdx, 15).numFmt = '€ #,##0.00';

  wsCost.getCell(grandTotalRowIdx, 16).value = {
    formula: `SUM(P${firstWorkerCostRow}:P${lastWorkerCostRow})`,
    result: Math.round(sumTotalCost * 100) / 100,
  };
  wsCost.getCell(grandTotalRowIdx, 16).numFmt = '€ #,##0.00';

  for (let c = 1; c <= 16; c++) {
    const cell = wsCost.getCell(grandTotalRowIdx, c);
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0F172A' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    cell.border = {
      top: { style: 'medium', color: { argb: 'FF0F172A' } },
      bottom: { style: 'double', color: { argb: 'FF0F172A' } },
      left: thinBorder,
      right: thinBorder,
    };
  }

  // Category & Role Summary Breakdown Table below
  const catStartRow = grandTotalRowIdx + 3;
  wsCost.mergeCells(catStartRow, 1, catStartRow, 5);
  wsCost.getCell(catStartRow, 1).value = 'RIPARTIZIONE COSTI PER REPARTO / CATEGORIA E TIPOLOGIA CONTRATTO';
  wsCost.getCell(catStartRow, 1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };

  const breakdownRows = [
    { label: 'Quota Costo Turno BAR (6-12 / 6-13)', hours: sumBarHours, cost: sumBarCost },
    { label: 'Quota Costo Turno PULIZIE MATTINA (7-13 / 7-14)', hours: sumMorningHours, cost: sumMorningCost },
    { label: 'Quota Costo Turno PULIZIE POMERIGGIO (14-20 / 14-21)', hours: sumAfternoonHours, cost: sumAfternoonCost },
    { label: 'Quota Maggiorazione Festivi (Solo Lavoratrici Fisse)', hours: sumHolidayHours, cost: sumHolidaySurchargeCost },
    { label: 'Subtotale Organico FISSO (Inclusa Maggiorazione Festivi)', hours: sumFisseHours, cost: sumFisseCost },
    { label: 'Subtotale SOSTITUTE A CHIAMATA (Caterina / SIG.RA PATRIZIA)', hours: sumSostituteHours, cost: sumSostituteCost },
  ];

  breakdownRows.forEach((b, idx) => {
    const r = catStartRow + 1 + idx;
    wsCost.mergeCells(r, 1, r, 3);
    wsCost.getCell(r, 1).value = b.label;
    wsCost.getCell(r, 1).font = { name: 'Calibri', size: 10, bold: idx >= 4 };
    wsCost.getCell(r, 4).value = `${b.hours} ore`;
    wsCost.getCell(r, 5).value = Math.round(b.cost * 100) / 100;
    wsCost.getCell(r, 5).numFmt = '€ #,##0.00';
    wsCost.getCell(r, 5).font = { name: 'Calibri', size: 10, bold: true };
    for (let c = 1; c <= 5; c++) {
      wsCost.getCell(r, c).border = { top: thinBorder, left: thinBorder, right: thinBorder, bottom: thinBorder };
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Prospetto_Turni_e_Costi_${monthObj.name}_${config.year}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const MONTH_ABBR_TO_NUM: Record<string, number> = {
  gen: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  mag: 5,
  giu: 6,
  lug: 7,
  ago: 8,
  set: 9,
  ott: 10,
  nov: 11,
  dic: 12,
};

const DAY_ABBR_TO_DOW: Record<string, number> = {
  dom: 0,
  lun: 1,
  mar: 2,
  mer: 3,
  gio: 4,
  ven: 5,
  sab: 6,
};

function extractCellText(cell: ExcelJS.Cell): string {
  const val = cell.value;
  if (val === null || val === undefined) return '';
  if (typeof val === 'string' || typeof val === 'number') return String(val).trim();
  if (typeof val === 'object') {
    if ('result' in val && val.result !== undefined && val.result !== null) {
      return String(val.result).trim();
    }
    if ('text' in val && typeof val.text === 'string') {
      return val.text.trim();
    }
    if ('richText' in val && Array.isArray(val.richText)) {
      return val.richText.map((rt) => rt.text).join('').trim();
    }
  }
  return '';
}

function parseHoursFromShiftLabel(label: string, explicitHoursText: string): number {
  const numExplicit = Number(explicitHoursText.replace(',', '.'));
  if (!Number.isNaN(numExplicit) && numExplicit > 0 && numExplicit <= 16) {
    return numExplicit;
  }
  const match = label.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (match) {
    const startH = Number(match[1]);
    const endH = Number(match[2]);
    if (endH > startH) return endH - startH;
  }
  return 6;
}

function classifyShiftLabel(label: string): 'BAR' | 'MORNING' | 'AFTERNOON' | 'OFF' {
  const clean = label.trim();
  if (!clean || clean === '-' || clean.toLowerCase() === 'riposo' || clean.toLowerCase() === 'off') {
    return 'OFF';
  }
  if (clean.startsWith('6-') || clean.startsWith('06-') || clean.toLowerCase().includes('bar')) {
    return 'BAR';
  }
  if (clean.startsWith('7-') || clean.startsWith('07-') || clean.startsWith('8-') || clean.startsWith('08-')) {
    return 'MORNING';
  }
  if (
    clean.startsWith('13-') ||
    clean.startsWith('14-') ||
    clean.startsWith('15-') ||
    clean.startsWith('16-')
  ) {
    return 'AFTERNOON';
  }
  const match = clean.match(/^(\d{1,2})\s*-/);
  if (match) {
    const startHour = Number(match[1]);
    if (startHour <= 6) return 'BAR';
    if (startHour <= 11) return 'MORNING';
    return 'AFTERNOON';
  }
  return 'MORNING';
}

/**
 * Parses an uploaded Excel (.xlsx) file (either a single monthly schedule or a multi-sheet historical workbook)
 * into ConfirmedScheduleEntry records ready to be stored in Storico Turni and used by the CP-SAT solver.
 */
export async function importSchedulesFromExcelFile(
  file: File,
  config: AppConfig,
  fallbackMonth?: number,
  fallbackYear?: number,
  customPeriodTitle?: string
): Promise<ConfirmedScheduleEntry[]> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);

  const importedEntries: ConfirmedScheduleEntry[] = [];

  for (const ws of workbook.worksheets) {
    const sheetTitleLower = ws.name.toLowerCase();
    if (
      sheetTitleLower.includes('costi') ||
      sheetTitleLower.includes('riepilogo_storico') ||
      ws.rowCount < 5
    ) {
      continue;
    }

    // Detect Month & Year from sheet name, file name, or first date cell
    let detectedMonth = fallbackMonth || config.month;
    let detectedYear = fallbackYear || config.year;

    const yearMatch = (ws.name + ' ' + file.name).match(/20\d{2}/);
    if (yearMatch) {
      detectedYear = Number(yearMatch[0]);
    }

    for (const mObj of ITALIAN_MONTHS) {
      if (
        sheetTitleLower.includes(mObj.name.toLowerCase()) ||
        file.name.toLowerCase().includes(mObj.name.toLowerCase())
      ) {
        detectedMonth = mObj.value;
        break;
      }
    }
    const numMonthMatch = ws.name.match(/Turni_(\d{1,2})_(20\d{2})/i);
    if (numMonthMatch) {
      detectedMonth = Number(numMonthMatch[1]);
      detectedYear = Number(numMonthMatch[2]);
    }

    // Map worker columns in Row 1
    // In our format: Col 1 = Data, Col 2 = Giorno, Col 3+4 = Worker 1 (Turno, Ore), Col 5+6 = Worker 2...
    const colToWorkerId: Array<{ shiftCol: number; hoursCol: number; workerId: string }> = [];
    const maxCol = Math.min(ws.columnCount || 30, 50);

    // Check if Row 2 has "Turno" / "Ore" subheaders
    const row2Col3 = extractCellText(ws.getCell(2, 3)).toLowerCase();
    const isPairedColumns = row2Col3.includes('turno') || extractCellText(ws.getCell(2, 4)).toLowerCase().includes('ore');

    const step = isPairedColumns ? 2 : 1;
    for (let c = 3; c <= maxCol; c += step) {
      const headerName = extractCellText(ws.getCell(1, c));
      if (!headerName) continue;
      const cleanHeader = headerName.replace(/^#\d+\s*/, '').trim().toLowerCase();

      // Match to existing worker by name or numeric ID
      const matchedWorker =
        config.workers.find((w) => w.name.trim().toLowerCase() === cleanHeader) ||
        config.workers.find((w) => cleanHeader.includes(w.name.trim().toLowerCase())) ||
        config.workers.find((w) => headerName.includes(`#${w.id}`));

      if (matchedWorker) {
        colToWorkerId.push({
          shiftCol: c,
          hoursCol: isPairedColumns ? c + 1 : c,
          workerId: matchedWorker.id,
        });
      }
    }

    // Fallback if headers were not matched: map sequentially to active workers
    if (colToWorkerId.length === 0) {
      const activeSorted = config.workers
        .filter((w) => w.active)
        .sort((a, b) => (a.type !== b.type ? (a.type === 'Fisso' ? -1 : 1) : a.priority - b.priority));
      activeSorted.forEach((w, idx) => {
        const sc = 3 + idx * 2;
        if (sc <= maxCol) {
          colToWorkerId.push({ shiftCol: sc, hoursCol: sc + 1, workerId: w.id });
        }
      });
    }

    const startRow = isPairedColumns ? 3 : 2;
    const calendarDays: DailyRequirement[] = [];
    const assignments: Record<number, Record<string, CellAssignment>> = {};

    for (let r = startRow; r <= ws.rowCount; r++) {
      const rawDate = extractCellText(ws.getCell(r, 1));
      const rawDay = extractCellText(ws.getCell(r, 2));
      if (!rawDate) break;
      const lowerDate = rawDate.toLowerCase();
      if (
        lowerDate.includes('giorni') ||
        lowerDate.includes('turni') ||
        lowerDate.includes('totale')
      ) {
        break;
      }

      // Check if dateStr has format like "01-nov"
      const dateParts = rawDate.split('-');
      if (dateParts.length === 2) {
        const mAbbr = dateParts[1].toLowerCase().slice(0, 3);
        if (MONTH_ABBR_TO_NUM[mAbbr] && calendarDays.length === 0 && !fallbackMonth) {
          detectedMonth = MONTH_ABBR_TO_NUM[mAbbr];
        }
      }

      const daySeq = calendarDays.length + 1;
      const dowKey = rawDay.toLowerCase().slice(0, 3);
      const dayOfWeek =
        DAY_ABBR_TO_DOW[dowKey] !== undefined
          ? DAY_ABBR_TO_DOW[dowKey]
          : new Date(detectedYear, detectedMonth - 1, daySeq).getDay();

      const dayNumInMonth = Number(rawDate.split('-')[0]) || daySeq;
      const isoDate = `${detectedYear}-${String(detectedMonth).padStart(2, '0')}-${String(
        dayNumInMonth
      ).padStart(2, '0')}`;
      const isHoliday =
        (detectedMonth === 11 && dayNumInMonth === 1) ||
        (detectedMonth === 12 && (dayNumInMonth === 8 || dayNumInMonth === 25 || dayNumInMonth === 26)) ||
        (detectedMonth === 1 && (dayNumInMonth === 1 || dayNumInMonth === 6)) ||
        (detectedMonth === 4 && dayNumInMonth === 25) ||
        (detectedMonth === 5 && dayNumInMonth === 1) ||
        (detectedMonth === 6 && dayNumInMonth === 2) ||
        (detectedMonth === 8 && dayNumInMonth === 15);

      let reqBar = 0;
      let reqMorning = 0;
      let reqAfternoon = 0;

      assignments[daySeq] = {};
      for (const w of config.workers) {
        assignments[daySeq][w.id] = { shiftType: 'OFF', label: '', hours: 0 };
      }

      for (const colMap of colToWorkerId) {
        const shiftText = extractCellText(ws.getCell(r, colMap.shiftCol));
        const hoursText =
          colMap.hoursCol !== colMap.shiftCol
            ? extractCellText(ws.getCell(r, colMap.hoursCol))
            : '';
        const sType = classifyShiftLabel(shiftText);
        if (sType !== 'OFF') {
          const hrs = parseHoursFromShiftLabel(shiftText, hoursText);
          assignments[daySeq][colMap.workerId] = {
            shiftType: sType,
            label: shiftText,
            hours: hrs,
          };
          if (sType === 'BAR') reqBar++;
          if (sType === 'MORNING') reqMorning++;
          if (sType === 'AFTERNOON') reqAfternoon++;
        }
      }

      calendarDays.push({
        day: daySeq,
        isoDate,
        dateStr: rawDate,
        dayOfWeek,
        dayAbbr: rawDay || ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'][dayOfWeek],
        reqBar: reqBar || 1,
        reqMorning: reqMorning || 4,
        reqAfternoon: reqAfternoon || 2,
        isHoliday,
      });
    }

    if (calendarDays.length === 0) continue;

    // Build workerStats for every worker using their immutable numeric ID
    const workerStats: Record<string, HistoricalWorkerStats> = {};
    for (const w of config.workers) {
      let totalHours = 0;
      let barCount = 0;
      let morningCount = 0;
      let afternoonCount = 0;
      let barHours = 0;
      let morningHours = 0;
      let afternoonHours = 0;
      let workedDays = 0;
      let sundaysWorked = 0;
      let holidaysWorked = 0;

      for (const dReq of calendarDays) {
        const cell = assignments[dReq.day]?.[w.id];
        if (cell && cell.shiftType !== 'OFF') {
          totalHours += cell.hours;
          workedDays += 1;
          if (cell.shiftType === 'BAR') {
            barCount++;
            barHours += cell.hours;
          } else if (cell.shiftType === 'MORNING') {
            morningCount++;
            morningHours += cell.hours;
          } else if (cell.shiftType === 'AFTERNOON') {
            afternoonCount++;
            afternoonHours += cell.hours;
          }
          if (dReq.dayOfWeek === 0) sundaysWorked++;
          if (dReq.isHoliday) holidaysWorked++;
        }
      }

      const rate = w.hourlyRate || (w.type === 'Sostituta' ? 13.0 : 12.5);
      const maxTheoreticalDays = Math.round(calendarDays.length * (6 / 7));
      const absenceDays = Math.max(0, maxTheoreticalDays - workedDays);

      workerStats[w.id] = {
        workerId: w.id,
        workerName: w.name,
        totalHours,
        targetHours: w.type === 'Fisso' ? Math.round(160 * (w.maxWeeklyHours / 40)) : 0,
        barCount,
        morningCount,
        afternoonCount,
        barHours,
        morningHours,
        afternoonHours,
        hourlyRate: rate,
        totalCost: Math.round(totalHours * rate * 100) / 100,
        workedDays,
        absenceDays,
        sundaysWorked,
        holidaysWorked,
      };
    }

    const mObj = ITALIAN_MONTHS.find((m) => m.value === detectedMonth) || ITALIAN_MONTHS[10];
    const firstDate = calendarDays[0]?.dateStr || `01-${mObj.abbr}`;
    const lastDate = calendarDays[calendarDays.length - 1]?.dateStr || `30-${mObj.abbr}`;
    const rangeStr = `${firstDate} → ${lastDate}`;
    const periodTitle =
      customPeriodTitle && workbook.worksheets.length === 1
        ? `${customPeriodTitle} (${rangeStr})`
        : `${mObj.name} ${detectedYear} (${rangeStr})`;

    importedEntries.push({
      id: `hist-xlsx-${detectedYear}-${String(detectedMonth).padStart(2, '0')}-${Date.now()}-${Math.floor(
        Math.random() * 1000
      )}`,
      confirmedAt: new Date().toISOString(),
      periodLabel: periodTitle,
      customRangeLabel: rangeStr,
      month: detectedMonth,
      year: detectedYear,
      numDays: calendarDays.length,
      calendar: calendarDays,
      shiftConfig: JSON.parse(JSON.stringify(config.shiftConfig)),
      shiftExceptions: [],
      assignments,
      workerStats,
    });
  }

  return importedEntries;
}

/**
 * Exports all archived historical schedules into a single multi-sheet Excel (.xlsx) workbook
 * so the user can backup or re-import the entire Storico Turni in Excel format.
 */
export async function exportAllHistoryToExcel(
  config: AppConfig,
  historyList: ConfirmedScheduleEntry[]
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Turni di Lavoro RT';
  workbook.created = new Date();

  const sorted = [...historyList].sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return b.month - a.month;
  });

  const activeWorkers = config.workers
    .filter((w) => w.active)
    .sort((a, b) => (a.type !== b.type ? (a.type === 'Fisso' ? -1 : 1) : a.priority - b.priority));

  // Sheet 1: Global Multi-Month Summary
  const wsSum = workbook.addWorksheet('Riepilogo_Storico_Globale');
  wsSum.mergeCells(1, 1, 1, 9);
  wsSum.getCell(1, 1).value =
    'ARCHIVIO STORICO PLURIMENSILE TURNI, ORE, WEEKEND/FESTIVITÀ E COSTI';
  wsSum.getCell(1, 1).font = { name: 'Calibri', size: 12, bold: true };

  const headers = [
    'Periodo',
    'ID #',
    'Dipendente',
    'Contratto',
    'Ore Totali',
    'Turni Mattina+Bar',
    'Turni Pomeriggio',
    'Domeniche / Festivi',
    'Costo Mese (€)',
  ];
  headers.forEach((h, idx) => {
    const c = wsSum.getCell(2, idx + 1);
    c.value = h;
    c.font = { name: 'Calibri', size: 10, bold: true };
    wsSum.getColumn(idx + 1).width = idx === 0 || idx === 2 ? 24 : 16;
  });

  let sumRowIdx = 3;
  for (const entry of sorted) {
    for (const w of activeWorkers) {
      const st = entry.workerStats[w.id];
      const rate = w.hourlyRate || 12.5;
      const totH = st?.totalHours || 0;
      wsSum.getCell(sumRowIdx, 1).value = entry.periodLabel;
      wsSum.getCell(sumRowIdx, 2).value = `#${w.id}`;
      wsSum.getCell(sumRowIdx, 3).value = w.name;
      wsSum.getCell(sumRowIdx, 4).value = w.type;
      wsSum.getCell(sumRowIdx, 5).value = totH;
      wsSum.getCell(sumRowIdx, 6).value = (st?.morningCount || 0) + (st?.barCount || 0);
      wsSum.getCell(sumRowIdx, 7).value = st?.afternoonCount || 0;
      wsSum.getCell(sumRowIdx, 8).value = (st?.sundaysWorked || 0) + (st?.holidaysWorked || 0);
      const costCell = wsSum.getCell(sumRowIdx, 9);
      costCell.value = Math.round(totH * rate * 100) / 100;
      costCell.numFmt = '€ #,##0.00';
      sumRowIdx++;
    }
  }

  // Individual Monthly Sheets (can be re-imported directly by importSchedulesFromExcelFile!)
  for (const entry of sorted) {
    const safeSheetName = `Turni_${String(entry.month).padStart(2, '0')}_${entry.year}`.slice(0, 31);
    if (workbook.getWorksheet(safeSheetName)) continue;
    const ws = workbook.addWorksheet(safeSheetName);
    ws.getCell(1, 1).value = 'Data';
    ws.getCell(1, 2).value = 'Giorno';
    ws.mergeCells(1, 1, 2, 1);
    ws.mergeCells(1, 2, 2, 2);

    activeWorkers.forEach((w, idx) => {
      const sc = 3 + idx * 2;
      const hc = 4 + idx * 2;
      ws.mergeCells(1, sc, 1, hc);
      ws.getCell(1, sc).value = w.name;
      ws.getCell(2, sc).value = 'Turno';
      ws.getCell(2, hc).value = 'Ore';
    });

    const cal =
      entry.calendar && entry.calendar.length > 0
        ? entry.calendar
        : generateCalendarForMonth(entry.month, entry.year, 1, 4, 2, 0);

    cal.forEach((dReq, rIdx) => {
      const rowNum = 3 + rIdx;
      ws.getCell(rowNum, 1).value = dReq.dateStr;
      ws.getCell(rowNum, 2).value = dReq.dayAbbr;
      activeWorkers.forEach((w, wIdx) => {
        const sc = 3 + wIdx * 2;
        const hc = 4 + wIdx * 2;
        const cell = entry.assignments?.[dReq.day]?.[w.id];
        ws.getCell(rowNum, sc).value = cell && cell.shiftType !== 'OFF' ? cell.label : '';
        ws.getCell(rowNum, hc).value = cell && cell.shiftType !== 'OFF' ? cell.hours : '';
      });
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Archivio_Storico_Turni_RT_${config.year}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

