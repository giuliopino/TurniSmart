import React, { useState } from 'react';
import {
  AlertTriangle,
  Search,
  Eye,
  CheckCircle2,
  X,
  Calendar,
  Clock,
  ShieldAlert,
  Wrench,
  FlaskConical,
  Target,
} from 'lucide-react';
import {
  AppConfig,
  ScheduleSolution,
  SolveRemediationSuggestion,
} from '../types';
import { ITALIAN_MONTHS } from '../defaultData';
import { getShiftSpec } from '../services/solverEngine';

export interface HighlightedScheduleTarget {
  day: number;
  workerId?: string;
  shiftType?: 'BAR' | 'MORNING' | 'AFTERNOON';
  title: string;
  detail: string;
  ruleViolated: string;
}

export interface DetectedScheduleProblem {
  id: string;
  day: number;
  fullDayLabel: string; // es. "Martedì 10 Novembre 2026"
  dateStr: string;
  workerId?: string;
  workerName?: string;
  shiftType?: 'BAR' | 'MORNING' | 'AFTERNOON';
  shiftTitle: string; // es. "Turno Mattina 7-13: richieste 4 persone, disponibili solo 3 lavoratrici"
  ruleViolated: string; // es. "Violazione riposo 11 ore CCNL" | "Troppe ferie contemporanee"
  explanation: string;
  severity: 'ERROR' | 'WARNING';
  autoFixSuggestion?: SolveRemediationSuggestion;
  quickCellFix?: {
    day: number;
    workerId: string;
    newShiftType: 'OFF' | 'BAR' | 'MORNING' | 'AFTERNOON';
    buttonLabel: string;
  };
}

const FULL_DAY_NAMES_IT: Record<number, string> = {
  0: 'Domenica',
  1: 'Lunedì',
  2: 'Martedì',
  3: 'Mercoledì',
  4: 'Giovedì',
  5: 'Venerdì',
  6: 'Sabato',
};

export function formatFullItalianDay(
  dayNum: number,
  config: AppConfig
): string {
  const dayObj = config.calendar.find((c) => c.day === dayNum);
  if (!dayObj) return `Giorno ${dayNum}`;
  const fullDow = FULL_DAY_NAMES_IT[dayObj.dayOfWeek] || dayObj.dayAbbr;
  if (dayObj.isoDate) {
    const [y, m, d] = dayObj.isoDate.split('-').map(Number);
    const mName = ITALIAN_MONTHS.find((item) => item.value === m)?.name || '';
    return `${fullDow} ${String(d).padStart(2, '0')} ${mName} ${y}`;
  }
  const mName = ITALIAN_MONTHS.find((item) => item.value === config.month)?.name || '';
  return `${fullDow} ${dayObj.dateStr} ${mName} ${config.year}`;
}

export function detectAllScheduleProblems(
  config: AppConfig,
  solution: ScheduleSolution
): DetectedScheduleProblem[] {
  const problems: DetectedScheduleProblem[] = [];
  const activeWorkers = config.workers.filter((w) => w.active);

  // 1. Check uncovered shifts / solver conflicts per day & shift
  for (const conf of solution.solveInsights.conflicts) {
    const fullDay = formatFullItalianDay(conf.day, config);
    const shiftIt =
      conf.shiftType === 'BAR'
        ? 'Turno Bar'
        : conf.shiftType === 'MORNING'
        ? 'Turno Mattina'
        : 'Turno Pomeriggio';

    const absentList = conf.workerBlockers.filter(
      (b) => b.category === 'STAFF_UNAVAILABILITY'
    );
    const hourCapList = conf.workerBlockers.filter(
      (b) => b.category === 'MAX_WEEKLY_HOURS'
    );
    const ccnl11hList = conf.workerBlockers.filter(
      (b) => b.category === 'CCNL_11H_REST'
    );

    let ruleLabel = 'Scopertura Fabbisogno Giornaliero';
    if (absentList.length >= 2) {
      ruleLabel = `Troppe ferie/indisponibilità contemporanee (${absentList.length} assenti)`;
    } else if (hourCapList.length > 0) {
      ruleLabel = `Superamento tetto max ore settimanali (${hourCapList.length} operatrici a tetto ore)`;
    } else if (ccnl11hList.length > 0) {
      ruleLabel = 'Blocco riposo 11 ore CCNL (Pomeriggio giorno precedente)';
    }

    const blockerSummary = conf.workerBlockers
      .slice(0, 4)
      .map((b) => `${b.workerName}: ${b.constraintLabel}`)
      .join(' · ');

    problems.push({
      id: `uncov-${conf.day}-${conf.shiftType}`,
      day: conf.day,
      fullDayLabel: fullDay,
      dateStr: conf.dateStr,
      shiftType: conf.shiftType,
      shiftTitle: `${shiftIt} ${conf.shiftLabel}: richieste ${conf.requiredSlots} persone, disponibili solo ${conf.assignedSlots} lavoratrici (mancano ${conf.missingSlots})`,
      ruleViolated: ruleLabel,
      explanation:
        blockerSummary ||
        `Non ci sono abbastanza operatrici abilitate libere per coprire il ${shiftIt} del ${fullDay}.`,
      severity: 'ERROR',
      autoFixSuggestion: conf.suggestions[0],
    });
  }

  // 2. Check direct coverage mismatch in current assignments (e.g. after manual edits)
  for (const dayReq of config.calendar) {
    const d = dayReq.day;
    const dayMap = solution.assignments[d] || {};
    const counts = { BAR: 0, MORNING: 0, AFTERNOON: 0 };
    for (const w of activeWorkers) {
      const st = dayMap[w.id]?.shiftType;
      if (st === 'BAR' || st === 'MORNING' || st === 'AFTERNOON') {
        counts[st]++;
      }
    }

    const checks: Array<{
      type: 'BAR' | 'MORNING' | 'AFTERNOON';
      req: number;
      actual: number;
      nameIt: string;
    }> = [
      { type: 'BAR', req: dayReq.reqBar, actual: counts.BAR, nameIt: 'Turno Bar' },
      { type: 'MORNING', req: dayReq.reqMorning, actual: counts.MORNING, nameIt: 'Turno Mattina' },
      {
        type: 'AFTERNOON',
        req: dayReq.reqAfternoon,
        actual: counts.AFTERNOON,
        nameIt: 'Turno Pomeriggio',
      },
    ];

    for (const chk of checks) {
      const alreadyLogged = problems.some(
        (p) => p.day === d && p.shiftType === chk.type
      );
      if (!alreadyLogged && chk.actual < chk.req) {
        const spec = getShiftSpec(config, dayReq, chk.type);
        const fullDay = formatFullItalianDay(d, config);
        problems.push({
          id: `manual-shortage-${d}-${chk.type}`,
          day: d,
          fullDayLabel: fullDay,
          dateStr: dayReq.dateStr,
          shiftType: chk.type,
          shiftTitle: `${chk.nameIt} ${spec.label}: richieste ${chk.req} persone, assegnate solo ${chk.actual} lavoratrici`,
          ruleViolated: 'Scopertura Fabbisogno Turno',
          explanation: `Nel giorno ${fullDay} il ${chk.nameIt} (${spec.label}) ha ${
            chk.req - chk.actual
          } posizioni scoperte rispetto al fabbisogno impostato.`,
          severity: 'ERROR',
        });
      }
    }
  }

  // 3. Check 11-hour CCNL rest violations (Afternoon on day d-1 -> Morning/Bar on day d)
  if (config.constraints.forbidAfternoonToMorning) {
    for (let i = 1; i < config.calendar.length; i++) {
      const prevDayReq = config.calendar[i - 1];
      const currDayReq = config.calendar[i];
      for (const w of activeWorkers) {
        const prevCell = solution.assignments[prevDayReq.day]?.[w.id];
        const currCell = solution.assignments[currDayReq.day]?.[w.id];
        if (
          prevCell?.shiftType === 'AFTERNOON' &&
          (currCell?.shiftType === 'MORNING' || currCell?.shiftType === 'BAR')
        ) {
          const fullCurrDay = formatFullItalianDay(currDayReq.day, config);
          const fullPrevDay = formatFullItalianDay(prevDayReq.day, config);
          const currShiftName =
            currCell.shiftType === 'BAR' ? 'Bar' : 'Mattina';
          problems.push({
            id: `ccnl-11h-${currDayReq.day}-${w.id}`,
            day: currDayReq.day,
            fullDayLabel: fullCurrDay,
            dateStr: currDayReq.dateStr,
            workerId: w.id,
            workerName: w.name,
            shiftType: currCell.shiftType,
            shiftTitle: `Dipendente ${w.name}: programmata ${currShiftName} ${currCell.label} subito dopo un turno Pomeriggio ${prevCell.label} di ${fullPrevDay}`,
            ruleViolated: 'Violazione riposo 11 ore CCNL (Pomeriggio → Mattina/Bar)',
            explanation: `La lavoratrice ${w.name} (#${w.id}) termina il turno Pomeriggio (${prevCell.label}) il giorno ${prevDayReq.dateStr} e inizia il turno ${currShiftName} (${currCell.label}) la mattina del ${currDayReq.dateStr}, violando le 11 ore minime di riposo continuativo previste dal CCNL.`,
            severity: 'ERROR',
            quickCellFix: {
              day: currDayReq.day,
              workerId: w.id,
              newShiftType: 'OFF',
              buttonLabel: `Metti ${w.name} a Riposo il ${currDayReq.dateStr}`,
            },
          });
        }
      }
    }
  }

  // 4. Check max consecutive worked days & max consecutive afternoons per worker
  const maxConsecDays = config.constraints.maxConsecutiveDays || 6;
  const maxConsecAft = config.constraints.maxConsecutiveAfternoons || 3;

  for (const w of activeWorkers) {
    let consecDays = 0;
    let consecAft = 0;
    for (const dayReq of config.calendar) {
      const cell = solution.assignments[dayReq.day]?.[w.id];
      const worked = cell && cell.shiftType !== 'OFF';
      if (worked) {
        consecDays++;
        if (cell.shiftType === 'AFTERNOON') {
          consecAft++;
        } else {
          consecAft = 0;
        }

        if (consecDays === maxConsecDays + 1) {
          const fullDay = formatFullItalianDay(dayReq.day, config);
          problems.push({
            id: `consec-days-${dayReq.day}-${w.id}`,
            day: dayReq.day,
            fullDayLabel: fullDay,
            dateStr: dayReq.dateStr,
            workerId: w.id,
            workerName: w.name,
            shiftType: cell.shiftType as 'BAR' | 'MORNING' | 'AFTERNOON',
            shiftTitle: `Dipendente ${w.name}: ${consecDays}° giorno lavorativo consecutivo in turno ${cell.label}`,
            ruleViolated: `Superamento max ${maxConsecDays} giorni consecutivi`,
            explanation: `La lavoratrice ${w.name} (#${w.id}) lavora per ${consecDays} giorni consecutivi senza riposo settimanale, superando il tetto massimo di ${maxConsecDays} giorni consecutivi.`,
            severity: 'WARNING',
            quickCellFix: {
              day: dayReq.day,
              workerId: w.id,
              newShiftType: 'OFF',
              buttonLabel: `Assegna Riposo a ${w.name} il ${dayReq.dateStr}`,
            },
          });
        }

        if (consecAft === maxConsecAft + 1) {
          const fullDay = formatFullItalianDay(dayReq.day, config);
          problems.push({
            id: `consec-aft-${dayReq.day}-${w.id}`,
            day: dayReq.day,
            fullDayLabel: fullDay,
            dateStr: dayReq.dateStr,
            workerId: w.id,
            workerName: w.name,
            shiftType: 'AFTERNOON',
            shiftTitle: `Dipendente ${w.name}: ${consecAft}° turno Pomeriggio (${cell.label}) consecutivo`,
            ruleViolated: `Superamento max ${maxConsecAft} Pomeriggi consecutivi`,
            explanation: `La lavoratrice ${w.name} (#${w.id}) svolge ${consecAft} turni di pomeriggio di fila, oltre il limite massimo consentito di ${maxConsecAft} pomeriggi consecutivi.`,
            severity: 'WARNING',
            quickCellFix: {
              day: dayReq.day,
              workerId: w.id,
              newShiftType: 'OFF',
              buttonLabel: `Interrompi serie Pomeriggi di ${w.name} il ${dayReq.dateStr}`,
            },
          });
        }
      } else {
        consecDays = 0;
        consecAft = 0;
      }
    }
  }

  return problems;
}

interface ScheduleConflictInspectorProps {
  config: AppConfig;
  solution: ScheduleSolution;
  onInspectTargetInTable: (target: HighlightedScheduleTarget) => void;
  onApplySuggestion: (suggestion: SolveRemediationSuggestion) => void;
  onManualCellChange?: (
    day: number,
    workerId: string,
    newShiftType: 'OFF' | 'BAR' | 'MORNING' | 'AFTERNOON'
  ) => void;
  onSimulateConflictDemo?: () => void;
}

export const ScheduleConflictInspector: React.FC<ScheduleConflictInspectorProps> = ({
  config,
  solution,
  onInspectTargetInTable,
  onApplySuggestion,
  onManualCellChange,
  onSimulateConflictDemo,
}) => {
  const problems = React.useMemo(
    () => detectAllScheduleProblems(config, solution),
    [config, solution]
  );

  const [detailModalProblemId, setDetailModalProblemId] = useState<string | null>(null);
  const activeModalProblem =
    problems.find((p) => p.id === detailModalProblemId) || null;

  const handleJumpToProblem = (prob: DetectedScheduleProblem) => {
    onInspectTargetInTable({
      day: prob.day,
      workerId: prob.workerId,
      shiftType: prob.shiftType,
      title: `${prob.fullDayLabel} — ${prob.ruleViolated}`,
      detail: prob.shiftTitle,
      ruleViolated: prob.ruleViolated,
    });
  };

  if (problems.length === 0) {
    return (
      <div className="bg-emerald-50/70 border border-emerald-200 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-xs text-emerald-950">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-bold">
            ✅ Nessun conflitto o violazione rilevata nella turnazione corrente (100% turni coperti e conformi al CCNL).
          </span>
          <span className="text-emerald-800 hidden sm:inline">
            Puoi cliccare su qualsiasi cella della tabella sottostante per modificare manualmente un turno e testare il controllo conflitti in tempo reale.
          </span>
        </div>
        {onSimulateConflictDemo && (
          <button
            type="button"
            onClick={onSimulateConflictDemo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-white hover:bg-slate-100 border border-slate-300 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <FlaskConical className="w-3.5 h-3.5 text-amber-600" />
            Simula Conflitto per Testare &quot;Vai al Problema&quot;
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Prominent Alert Banner with Count & Per-Alert Inspection Buttons */}
      <div className="bg-red-50 border-2 border-red-300 rounded-lg p-4 space-y-3 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-red-600 text-white flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </span>
            <div>
              <div className="text-sm font-bold text-red-950">
                ⚠️ Rilevati {problems.length}{' '}
                {problems.length === 1
                  ? 'problema di turnazione'
                  : 'problemi di turnazione'}
              </div>
              <div className="text-xs text-red-800">
                Clicca su <strong>&quot;🔍 Vai al Problema&quot;</strong> per evidenziare subito il
                giorno e la cella nella tabella turni, oppure su{' '}
                <strong>&quot;👁️ Mostra Dettaglio&quot;</strong> per l&apos;analisi diagnostica.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleJumpToProblem(problems[0])}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap shadow-2xs"
          >
            <Search className="w-3.5 h-3.5" />
            🔍 Ispeziona Primo Problema ({problems[0].dateStr})
          </button>
        </div>

        {/* List of Individual Alerts with [ 🔍 Vai al Problema ] and [ 👁️ Mostra Dettaglio ] */}
        <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
          {problems.map((prob) => (
            <div
              key={prob.id}
              className="bg-white border border-red-200 rounded-lg p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 hover:border-red-400 transition-colors"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 text-[11px] font-mono font-bold bg-red-600 text-white rounded">
                    {prob.fullDayLabel}
                  </span>
                  <span className="px-2 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-950 border border-amber-300 rounded">
                    {prob.ruleViolated}
                  </span>
                </div>
                <div className="text-xs font-bold text-slate-900">{prob.shiftTitle}</div>
                <div className="text-[11px] text-slate-600">{prob.explanation}</div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleJumpToProblem(prob)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-950 bg-[#FEF08A] hover:bg-amber-200 border border-amber-400 rounded-md transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Search className="w-3.5 h-3.5" />
                  🔍 Vai al Problema
                </button>
                <button
                  type="button"
                  onClick={() => setDetailModalProblemId(prob.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Eye className="w-3.5 h-3.5" />
                  👁️ Mostra Dettaglio
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Diagnostic Detail Modal for the Selected Alert */}
      {activeModalProblem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden">
            <div className="px-6 py-4 bg-red-600 text-white flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <ShieldAlert className="w-6 h-6 text-[#FEF08A] shrink-0" />
                <div>
                  <h3 className="text-base font-bold">
                    Ispezione Giorno / Turno Problematico
                  </h3>
                  <p className="text-xs text-red-100">
                    Dettaglio anomalia rilevata e localizzazione rapida nella tabella turni
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailModalProblemId(null)}
                className="p-1.5 text-red-100 hover:text-white hover:bg-red-700 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              {/* 1. Giorno specifico esatto */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3">
                <Calendar className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    1. Giorno Specifico Esatto
                  </div>
                  <div className="text-sm font-bold text-slate-950 mt-0.5">
                    {activeModalProblem.fullDayLabel} (Riga #{activeModalProblem.day} —{' '}
                    {activeModalProblem.dateStr})
                  </div>
                </div>
              </div>

              {/* 2. Turnazione prevista specifica */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-3">
                <Clock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    2. Turnazione Prevista che Genera l&apos;Incompatibilità
                  </div>
                  <div className="text-sm font-bold text-slate-950 mt-0.5">
                    {activeModalProblem.shiftTitle}
                  </div>
                </div>
              </div>

              {/* 3. Regola violata */}
              <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-red-700">
                    3. Regola Violata &amp; Causa Tecnica
                  </div>
                  <div className="text-sm font-bold text-red-950">
                    {activeModalProblem.ruleViolated}
                  </div>
                  <p className="text-xs text-red-900 leading-relaxed">
                    {activeModalProblem.explanation}
                  </p>
                </div>
              </div>

              {/* Action Buttons: Highlight Row/Cell in Table or 1-Click Fix */}
              <div className="pt-2 flex flex-wrap items-center justify-end gap-2.5">
                {activeModalProblem.autoFixSuggestion && (
                  <button
                    type="button"
                    onClick={() => {
                      onApplySuggestion(activeModalProblem.autoFixSuggestion!);
                      setDetailModalProblemId(null);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <Wrench className="w-4 h-4" />
                    Risolvi Automaticamente ({activeModalProblem.autoFixSuggestion.title})
                  </button>
                )}

                {activeModalProblem.quickCellFix && onManualCellChange && (
                  <button
                    type="button"
                    onClick={() => {
                      const fix = activeModalProblem.quickCellFix!;
                      onManualCellChange(fix.day, fix.workerId, fix.newShiftType);
                      setDetailModalProblemId(null);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <Wrench className="w-4 h-4" />
                    {activeModalProblem.quickCellFix.buttonLabel}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    handleJumpToProblem(activeModalProblem);
                    setDetailModalProblemId(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-slate-950 bg-[#FEF08A] hover:bg-amber-200 border border-amber-400 rounded-lg transition-colors cursor-pointer"
                >
                  <Target className="w-4 h-4" />
                  🎯 Evidenzia Riga e Cella nella Tabella Turni
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
