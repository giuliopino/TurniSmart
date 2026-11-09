import React, { useEffect, useRef, useState } from 'react';
import { Target, X, Edit3 } from 'lucide-react';
import { AppConfig, ScheduleSolution } from '../types';
import { formatPeriodLabel } from '../defaultData';
import { HighlightedScheduleTarget } from './ScheduleConflictInspector';

interface SchedulePaperTableProps {
  config: AppConfig;
  solution: ScheduleSolution;
  showSummaryFooter?: boolean;
  highlightedTarget?: HighlightedScheduleTarget | null;
  onClearHighlight?: () => void;
  onManualCellChange?: (
    day: number,
    workerId: string,
    newShiftType: 'OFF' | 'BAR' | 'MORNING' | 'AFTERNOON'
  ) => void;
}

/**
 * Renders the exact visual and chromatic clone of the paper reference table:
 * - Column A: Data (01-nov, 02-nov... and cross-month dates e.g. 01-dic)
 * - Column B: Giorno abbreviato (Dom, Lun, Mar...)
 * - Paired columns per worker: Turno + Ore with merged top header cell
 * - Turno BAR (6-12, 6-13): Pastel yellow background (#FEF08A)
 * - Turno MATTINA (7-13, 7-14): Vivid Red/Orange text (#DC2626) on white background
 * - Turno POMERIGGIO (14-20, 14-21): Bold Black text (#000000)
 * - Rest / Absence: Completely empty cells
 * - Thick dark forest-green horizontal border (#14532D) below every Sunday
 */
export const SchedulePaperTable: React.FC<SchedulePaperTableProps> = ({
  config,
  solution,
  showSummaryFooter = false,
  highlightedTarget = null,
  onClearHighlight,
  onManualCellChange,
}) => {
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const [editingCell, setEditingCell] = useState<{
    day: number;
    workerId: string;
    workerName: string;
    dateStr: string;
  } | null>(null);

  useEffect(() => {
    if (highlightedTarget && rowRefs.current[highlightedTarget.day]) {
      rowRefs.current[highlightedTarget.day]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [highlightedTarget]);

  const activeWorkers = config.workers
    .filter((w) => w.active)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'Fisso' ? -1 : 1;
      return a.priority - b.priority;
    });

  const periodTitle = formatPeriodLabel(config);

  return (
    <div className="bg-white border border-slate-300 rounded-lg shadow-xs overflow-hidden">
      {/* Highlighted Target Diagnostic Strip (visible when user clicks "Vai al Problema") */}
      {highlightedTarget && (
        <div className="px-4 py-2.5 bg-red-600 text-white flex flex-wrap items-center justify-between gap-3 border-b border-red-700">
          <div className="flex items-center gap-2.5 text-xs">
            <Target className="w-4 h-4 text-[#FEF08A] shrink-0" />
            <div>
              <span className="font-bold mr-2">
                🔍 GIORNO / TURNO EVIDENZIATO: {highlightedTarget.title}
              </span>
              <span className="text-red-100">{highlightedTarget.detail}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onManualCellChange && (
              <span className="text-[11px] bg-red-700 px-2 py-0.5 rounded text-red-100">
                Suggerimento: clicca su una cella della riga evidenziata per correggere il turno con 1 clic
              </span>
            )}
            {onClearHighlight && (
              <button
                type="button"
                onClick={onClearHighlight}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold bg-white text-red-700 hover:bg-red-50 rounded transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Chiudi Evidenziazione
              </button>
            )}
          </div>
        </div>
      )}

      {/* Quick 1-Click Manual Shift Editor Bar when a cell is clicked */}
      {editingCell && onManualCellChange && (
        <div className="px-4 py-2.5 bg-slate-800 text-white flex flex-wrap items-center justify-between gap-3 border-b border-slate-700">
          <div className="flex items-center gap-2 text-xs">
            <Edit3 className="w-4 h-4 text-[#FEF08A] shrink-0" />
            <span>
              Modifica rapida turno di <strong>{editingCell.workerName}</strong> del giorno{' '}
              <strong className="font-mono">{editingCell.dateStr}</strong>:
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onManualCellChange(editingCell.day, editingCell.workerId, 'OFF');
                setEditingCell(null);
              }}
              className="px-2.5 py-1 text-xs font-bold bg-white text-slate-900 hover:bg-slate-100 rounded cursor-pointer"
            >
              Riposo (Cella Vuota)
            </button>
            <button
              type="button"
              onClick={() => {
                onManualCellChange(editingCell.day, editingCell.workerId, 'BAR');
                setEditingCell(null);
              }}
              className="px-2.5 py-1 text-xs font-bold bg-[#FEF08A] text-slate-950 hover:bg-amber-200 rounded cursor-pointer"
            >
              Turno BAR (Giallo)
            </button>
            <button
              type="button"
              onClick={() => {
                onManualCellChange(editingCell.day, editingCell.workerId, 'MORNING');
                setEditingCell(null);
              }}
              className="px-2.5 py-1 text-xs font-bold bg-white text-[#DC2626] border border-red-300 hover:bg-red-50 rounded cursor-pointer"
            >
              Turno MATTINA (Rosso)
            </button>
            <button
              type="button"
              onClick={() => {
                onManualCellChange(editingCell.day, editingCell.workerId, 'AFTERNOON');
                setEditingCell(null);
              }}
              className="px-2.5 py-1 text-xs font-bold bg-white text-black border border-slate-400 hover:bg-slate-100 rounded cursor-pointer"
            >
              Turno POMERIGGIO (Nero Grassetto)
            </button>
            <button
              type="button"
              onClick={() => setEditingCell(null)}
              className="p-1 text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Header Legend Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 bg-slate-900 text-white border-b border-slate-800">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold tracking-tight uppercase">
            Turni di Lavoro RT — {periodTitle}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-xs text-slate-300">
            {showSummaryFooter
              ? 'Vista Gestione (con riepilogo ore in fondo)'
              : 'Vista Pulita per Lavoratrici (senza tabella calcolo ore in fondo)'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-5 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-3.5 bg-[#FEF08A] border border-slate-400 rounded-xs" />
            <span className="text-slate-200 font-medium">Bar (6-12 / 6-13)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block px-1 font-mono font-semibold text-[#DC2626] bg-white rounded-xs">
              7-13
            </span>
            <span className="text-slate-200 font-medium">Mattina (Rosso)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block px-1 font-mono font-bold text-black bg-white rounded-xs">
              14-20
            </span>
            <span className="text-slate-200 font-medium">Pomeriggio (Nero Grassetto)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-1 bg-[#14532D]" />
            <span className="text-slate-200 font-medium">Fine Settimana (Domenica)</span>
          </div>
        </div>
      </div>

      {/* Scrollable Table Container */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-center select-text">
          <thead>
            {/* Row 1: Merged Worker Names */}
            <tr className="bg-slate-200 text-slate-900">
              <th
                rowSpan={2}
                className="border border-slate-500 px-2.5 py-2 text-xs font-bold uppercase tracking-wider sticky left-0 bg-slate-200 z-10 min-w-[74px]"
              >
                Data
              </th>
              <th
                rowSpan={2}
                className="border border-slate-500 px-2 py-2 text-xs font-bold uppercase tracking-wider sticky left-[74px] bg-slate-200 z-10 min-w-[56px]"
              >
                Giorno
              </th>
              {activeWorkers.map((w) => (
                <th
                  key={w.id}
                  colSpan={2}
                  className={`border border-slate-500 px-2 py-1.5 text-xs font-bold tracking-tight ${
                    w.type === 'Sostituta'
                      ? 'bg-slate-100 text-slate-700'
                      : 'bg-slate-200 text-slate-950'
                  }`}
                >
                  <div className="whitespace-nowrap">{w.name}</div>
                  {w.type === 'Sostituta' && (
                    <div className="text-[10px] font-normal text-slate-500">
                      Sostituta (P{w.priority})
                    </div>
                  )}
                </th>
              ))}
            </tr>

            {/* Row 2: Turno / Ore Sub-columns */}
            <tr className="bg-slate-100 text-slate-700 border-b-2 border-slate-800">
              {activeWorkers.map((w) => (
                <React.Fragment key={`${w.id}-sub`}>
                  <th className="border border-slate-400 px-1.5 py-1 text-[10px] font-semibold uppercase min-w-[62px]">
                    Turno
                  </th>
                  <th className="border border-slate-400 px-1 py-1 text-[10px] font-semibold uppercase min-w-[36px]">
                    Ore
                  </th>
                </React.Fragment>
              ))}
            </tr>
          </thead>

          <tbody className="font-mono tabular-nums text-xs">
            {config.calendar.map((dayReq) => {
              const isSunday = dayReq.dayOfWeek === 0;
              const isHighlightedRow = highlightedTarget?.day === dayReq.day;
              const sundayBorderClass = isSunday
                ? 'border-b-[3px] border-b-[#14532D]'
                : 'border-b border-b-slate-300';

              return (
                <tr
                  key={dayReq.day}
                  ref={(el) => {
                    rowRefs.current[dayReq.day] = el;
                  }}
                  className={`hover:bg-slate-50/80 transition-colors ${
                    isHighlightedRow
                      ? 'ring-2 ring-red-600 bg-red-50/40'
                      : isSunday
                      ? 'bg-emerald-50/15'
                      : 'bg-white'
                  }`}
                >
                  {/* Column A: Data (01-nov) */}
                  <td
                    className={`border-x border-t border-slate-400 ${sundayBorderClass} px-2 py-1 text-center whitespace-nowrap sticky left-0 z-10 ${
                      isHighlightedRow
                        ? 'bg-red-600 text-white font-bold'
                        : isSunday || dayReq.isHoliday
                        ? 'font-bold text-[#14532D] bg-slate-50'
                        : 'font-medium text-slate-900 bg-white'
                    }`}
                  >
                    {dayReq.dateStr}
                  </td>

                  {/* Column B: Giorno abbreviato (Dom, Lun...) */}
                  <td
                    className={`border-x border-t border-slate-400 ${sundayBorderClass} px-1.5 py-1 text-center font-sans whitespace-nowrap sticky left-[74px] z-10 ${
                      isHighlightedRow
                        ? 'bg-red-100 text-red-950 font-bold'
                        : isSunday || dayReq.isHoliday
                        ? 'font-bold text-[#14532D] bg-slate-50'
                        : 'font-medium text-slate-700 bg-white'
                    }`}
                  >
                    {dayReq.dayAbbr}
                  </td>

                  {/* Worker Paired Columns */}
                  {activeWorkers.map((w) => {
                    const cell = solution.assignments[dayReq.day]?.[w.id];
                    const isAssigned = cell && cell.shiftType !== 'OFF';
                    const isHighlightedCell =
                      isHighlightedRow &&
                      (highlightedTarget?.workerId === w.id ||
                        (!highlightedTarget?.workerId &&
                          highlightedTarget?.shiftType &&
                          cell?.shiftType === highlightedTarget.shiftType));

                    let shiftCellClasses = 'bg-white text-slate-900';
                    if (isAssigned) {
                      if (cell.shiftType === 'BAR') {
                        shiftCellClasses = 'bg-[#FEF08A] text-slate-950 font-bold';
                      } else if (cell.shiftType === 'MORNING') {
                        shiftCellClasses = 'bg-white text-[#DC2626] font-medium';
                      } else if (cell.shiftType === 'AFTERNOON') {
                        shiftCellClasses = 'bg-white text-black font-bold';
                      }
                    }

                    const highlightRingClass = isHighlightedCell
                      ? 'ring-2 ring-inset ring-red-600 animate-pulse'
                      : '';

                    return (
                      <React.Fragment key={`${dayReq.day}-${w.id}`}>
                        {/* Colonna Turno */}
                        <td
                          onClick={() => {
                            if (onManualCellChange) {
                              setEditingCell({
                                day: dayReq.day,
                                workerId: w.id,
                                workerName: w.name,
                                dateStr: dayReq.dateStr,
                              });
                            }
                          }}
                          title={
                            onManualCellChange
                              ? `Giorno ${dayReq.dateStr} — ${w.name}: clicca per modificare manualmente il turno (${
                                  isAssigned ? `${cell.label} [${cell.hours}h]` : 'Riposo'
                                })`
                              : undefined
                          }
                          className={`border-x border-t border-slate-300 ${sundayBorderClass} px-1.5 py-1 text-center whitespace-nowrap ${shiftCellClasses} ${highlightRingClass} ${
                            onManualCellChange ? 'cursor-pointer hover:brightness-95' : ''
                          }`}
                        >
                          {isAssigned ? cell.label : ''}
                        </td>
                        {/* Colonna Ore */}
                        <td
                          onClick={() => {
                            if (onManualCellChange) {
                              setEditingCell({
                                day: dayReq.day,
                                workerId: w.id,
                                workerName: w.name,
                                dateStr: dayReq.dateStr,
                              });
                            }
                          }}
                          className={`border-x border-t border-slate-300 ${sundayBorderClass} px-1 py-1 text-center text-slate-700 bg-white ${highlightRingClass} ${
                            onManualCellChange ? 'cursor-pointer hover:bg-slate-50' : ''
                          }`}
                        >
                          {isAssigned ? cell.hours : ''}
                        </td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>

          {/* Optional Summary Footer Totals (Hidden when showSummaryFooter is false for clean worker export) */}
          {showSummaryFooter && (
            <tfoot className="font-mono tabular-nums text-xs border-t-2 border-slate-800">
              <tr className="bg-slate-200 font-bold text-slate-950">
                <td
                  colSpan={2}
                  className="border border-slate-500 px-2.5 py-1.5 text-left font-sans text-[11px] uppercase sticky left-0 bg-slate-200 z-10"
                >
                  Totale Ore Periodo
                </td>
                {activeWorkers.map((w) => {
                  const st = solution.workerStats[w.id];
                  return (
                    <td
                      key={`tot-h-${w.id}`}
                      colSpan={2}
                      className="border border-slate-500 px-2 py-1.5 text-center font-bold text-sm"
                    >
                      {st?.totalHours || 0}h
                    </td>
                  );
                })}
              </tr>

              <tr className="bg-slate-50 text-slate-700">
                <td
                  colSpan={2}
                  className="border border-slate-400 px-2.5 py-1 text-left font-sans text-[11px] font-semibold sticky left-0 bg-slate-50 z-10"
                >
                  Giorni Lavorati / Disp.
                </td>
                {activeWorkers.map((w) => {
                  const st = solution.workerStats[w.id];
                  return (
                    <td
                      key={`tot-d-${w.id}`}
                      colSpan={2}
                      className="border border-slate-400 px-2 py-1 text-center"
                    >
                      <span className="font-bold text-slate-900">{st?.workedDays || 0}</span>
                      <span className="text-[10px] text-slate-500">/{st?.availableDays || 0}</span>
                    </td>
                  );
                })}
              </tr>

              <tr className="bg-white text-[#DC2626]">
                <td
                  colSpan={2}
                  className="border border-slate-400 px-2.5 py-1 text-left font-sans text-[11px] font-semibold text-slate-700 sticky left-0 bg-white z-10"
                >
                  Turni Mattina (7-*)
                </td>
                {activeWorkers.map((w) => {
                  const st = solution.workerStats[w.id];
                  return (
                    <td
                      key={`tot-m-${w.id}`}
                      colSpan={2}
                      className="border border-slate-400 px-2 py-1 text-center font-medium"
                    >
                      {st?.morningCount || 0}
                    </td>
                  );
                })}
              </tr>

              <tr className="bg-white text-black font-bold">
                <td
                  colSpan={2}
                  className="border border-slate-400 px-2.5 py-1 text-left font-sans text-[11px] font-semibold text-slate-700 sticky left-0 bg-white z-10"
                >
                  Turni Pomeriggio (14-*)
                </td>
                {activeWorkers.map((w) => {
                  const st = solution.workerStats[w.id];
                  return (
                    <td
                      key={`tot-a-${w.id}`}
                      colSpan={2}
                      className="border border-slate-400 px-2 py-1 text-center font-bold"
                    >
                      {st?.afternoonCount || 0}
                    </td>
                  );
                })}
              </tr>

              <tr className="bg-[#FEF08A]/45 text-slate-900 font-semibold">
                <td
                  colSpan={2}
                  className="border border-slate-400 px-2.5 py-1 text-left font-sans text-[11px] font-semibold text-slate-800 sticky left-0 bg-[#FEF08A]/45 z-10"
                >
                  Turni Bar (6-*)
                </td>
                {activeWorkers.map((w) => {
                  const st = solution.workerStats[w.id];
                  return (
                    <td
                      key={`tot-b-${w.id}`}
                      colSpan={2}
                      className="border border-slate-400 px-2 py-1 text-center"
                    >
                      {st?.barCount || 0}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
};
