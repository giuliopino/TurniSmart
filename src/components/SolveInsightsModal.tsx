import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  X,
  Wrench,
  Clock,
  UserX,
  ShieldAlert,
  CalendarX,
  Sparkles,
  ArrowRight,
  Sliders,
  FlaskConical,
} from 'lucide-react';
import {
  ConflictConstraintCategory,
  SolveConflictItem,
  SolveInsightsReport,
  SolveRemediationSuggestion,
} from '../types';

interface SolveInsightsModalProps {
  isOpen: boolean;
  onClose: () => void;
  insights: SolveInsightsReport;
  onApplySuggestion: (suggestion: SolveRemediationSuggestion) => void;
  onApplyAllHighPriority: (suggestions: SolveRemediationSuggestion[]) => void;
  onSimulateConflictDemo?: () => void;
}

const CATEGORY_META: Record<
  ConflictConstraintCategory,
  { label: string; colorClass: string }
> = {
  STAFF_UNAVAILABILITY: {
    label: 'Assenza / Indisponibilità',
    colorClass: 'bg-red-50 text-red-800 border-red-200',
  },
  MAX_WEEKLY_HOURS: {
    label: 'Limite Ore Max Sett.',
    colorClass: 'bg-amber-50 text-amber-900 border-amber-300',
  },
  WEEKLY_REST_DAYS: {
    label: 'Riposo Settimanale CCNL',
    colorClass: 'bg-purple-50 text-purple-800 border-purple-200',
  },
  MAX_CONSECUTIVE_DAYS: {
    label: 'Max Giorni Consecutivi',
    colorClass: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  },
  CCNL_11H_REST: {
    label: 'Blocco 11h (Pom → Mat)',
    colorClass: 'bg-orange-50 text-orange-800 border-orange-200',
  },
  SKILL_MISMATCH: {
    label: 'Mansione Non Abilitata',
    colorClass: 'bg-slate-100 text-slate-700 border-slate-300',
  },
  INACTIVE_WORKER: {
    label: 'Lavoratrice Disattivata',
    colorClass: 'bg-slate-100 text-slate-500 border-slate-200',
  },
  EXCESS_DEMAND: {
    label: 'Fabbisogno Eccessivo',
    colorClass: 'bg-rose-50 text-rose-800 border-rose-200',
  },
};

export const SolveInsightsModal: React.FC<SolveInsightsModalProps> = ({
  isOpen,
  onClose,
  insights,
  onApplySuggestion,
  onApplyAllHighPriority,
  onSimulateConflictDemo,
}) => {
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('ALL');

  if (!isOpen) return null;

  const activeConflict: SolveConflictItem | undefined =
    insights.conflicts.find((c) => c.id === selectedConflictId) || insights.conflicts[0];

  const filteredSuggestions = insights.topSuggestions.filter((s) => {
    if (filterCategory === 'ALL') return true;
    if (filterCategory === 'HOURS') return s.actionType === 'INCREASE_MAX_WEEKLY_HOURS';
    if (filterCategory === 'DEMAND') return s.actionType === 'REDUCE_SHIFT_DEMAND';
    if (filterCategory === 'ABSENCE') return s.actionType === 'REMOVE_ABSENCE_ON_DAY';
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div
          className={`px-6 py-4 border-b flex items-center justify-between gap-4 ${
            insights.hasConflicts
              ? 'bg-red-50/80 border-red-200'
              : 'bg-emerald-50/80 border-emerald-200'
          }`}
        >
          <div className="flex items-center gap-3">
            {insights.hasConflicts ? (
              <div className="w-10 h-10 rounded-lg bg-red-600 text-white flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-5 h-5" />
              </div>
            )}
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-bold text-slate-900">
                  Solve Insights — Diagnostica Conflitti CP-SAT &amp; Sblocco Vincoli
                </h2>
                {insights.hasConflicts ? (
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold bg-red-600 text-white rounded">
                    {insights.totalUncoveredShifts} turni scoperti su {insights.affectedDaysCount}{' '}
                    giorni
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold bg-emerald-700 text-white rounded">
                    100% Fattibile · 0 Conflitti
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600 mt-0.5">
                {insights.hasConflicts
                  ? 'Il rilevatore di conflitti CP-SAT ha isolato i vincoli esatti (indisponibilità, tetti ore settimanali, riposi CCNL) che impediscono la copertura e propone le modifiche minime per sbloccare una soluzione valida.'
                  : 'Tutti i vincoli attuali sono compatibili. Puoi simulare uno scenario di conflitto per testare il motore di risoluzione automatica.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-white/80 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {!insights.hasConflicts ? (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center space-y-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
              <div className="space-y-1 max-w-xl mx-auto">
                <h3 className="text-base font-bold text-slate-900">
                  Nessun Conflitto di Vincoli Rilevato
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  L&apos;ottimizzatore matematico ha soddisfatto il 100% del fabbisogno giornaliero
                  (Bar, Mattina e Pomeriggio) rispettando i limiti di ore settimanali, le ferie e
                  i riposi CCNL. Vuoi vedere come funziona il rilevamento conflitti CP-SAT quando
                  la soluzione è impossibile?
                </p>
              </div>
              {onSimulateConflictDemo && (
                <button
                  type="button"
                  onClick={onSimulateConflictDemo}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <FlaskConical className="w-4 h-4" />
                  Simula Scenario di Conflitto (Ferie + Limite Ore + Fabbisogno Alto)
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Unsat-Core Summary Banner */}
              <div className="bg-slate-900 text-white rounded-lg p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4" />
                    Nucleo di Incompatibilità Rilevato (CP-SAT Conflict Core)
                  </div>
                  <ul className="space-y-1 text-xs text-slate-200">
                    {insights.unsatCoreSummary.map((line, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="shrink-0 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const demandFixes = insights.topSuggestions.filter(
                        (s) => s.actionType === 'REDUCE_SHIFT_DEMAND'
                      );
                      if (demandFixes.length > 0) {
                        onApplyAllHighPriority(demandFixes);
                      } else {
                        onApplyAllHighPriority(insights.topSuggestions.slice(0, 3));
                      }
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-slate-950 bg-[#FEF08A] hover:bg-amber-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Sparkles className="w-4 h-4" />
                    Sblocca Tutto Automaticamente ({insights.conflicts.length} conflitti)
                  </button>
                </div>
              </div>

              {/* Section 1: Actionable Suggestions ("Suggested Changes to Unlock a Feasible Schedule") */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-slate-900" />
                    <h3 className="text-sm font-bold text-slate-900">
                      Modifiche Consigliate ai Vincoli per Sbloccare la Soluzione (1-Click Auto-Fix)
                    </h3>
                  </div>

                  {/* Filter tabs */}
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs">
                    {[
                      { id: 'ALL', label: `Tutte (${insights.topSuggestions.length})` },
                      {
                        id: 'HOURS',
                        label: `Aumenta Ore Max (${
                          insights.topSuggestions.filter(
                            (s) => s.actionType === 'INCREASE_MAX_WEEKLY_HOURS'
                          ).length
                        })`,
                      },
                      {
                        id: 'DEMAND',
                        label: `Riduci Fabbisogno (${
                          insights.topSuggestions.filter(
                            (s) => s.actionType === 'REDUCE_SHIFT_DEMAND'
                          ).length
                        })`,
                      },
                      {
                        id: 'ABSENCE',
                        label: `Ferie / Assenze (${
                          insights.topSuggestions.filter(
                            (s) => s.actionType === 'REMOVE_ABSENCE_ON_DAY'
                          ).length
                        })`,
                      },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setFilterCategory(tab.id)}
                        className={`px-2.5 py-1 rounded font-medium transition-colors cursor-pointer ${
                          filterCategory === tab.id
                            ? 'bg-white text-slate-900 shadow-2xs font-bold'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[270px] overflow-y-auto pr-1">
                  {filteredSuggestions.map((sug) => (
                    <div
                      key={sug.id}
                      className="p-3.5 bg-white border border-slate-200 hover:border-slate-400 rounded-lg flex flex-col justify-between gap-3 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${
                              sug.actionType === 'INCREASE_MAX_WEEKLY_HOURS'
                                ? 'bg-amber-50 text-amber-900 border-amber-300'
                                : sug.actionType === 'REDUCE_SHIFT_DEMAND'
                                ? 'bg-rose-50 text-rose-800 border-rose-200'
                                : sug.actionType === 'REMOVE_ABSENCE_ON_DAY'
                                ? 'bg-red-50 text-red-800 border-red-200'
                                : 'bg-slate-100 text-slate-800 border-slate-300'
                            }`}
                          >
                            {sug.actionType === 'INCREASE_MAX_WEEKLY_HOURS'
                              ? 'AUMENTA ORE MAX SETTIMANALI'
                              : sug.actionType === 'REDUCE_SHIFT_DEMAND'
                              ? 'RIDUCI / RIMUOVI FABBISOGNO TURNO'
                              : sug.actionType === 'REMOVE_ABSENCE_ON_DAY'
                              ? 'RIMUOVI INDISPONIBILITÀ'
                              : sug.actionType === 'ENABLE_WORKER_SKILL'
                              ? 'ABILITA MANSIONE'
                              : 'RILASSA VINCOLO CCNL'}
                          </span>
                          {sug.dateStr && (
                            <span className="text-[11px] font-mono font-semibold text-slate-500">
                              Giorno {sug.dateStr}
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-bold text-slate-900">{sug.title}</div>
                        <p className="text-[11px] text-slate-600 leading-snug">{sug.description}</p>
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
                        <span className="text-[11px] font-medium text-emerald-700 truncate">
                          ✓ {sug.impactSummary}
                        </span>
                        <button
                          type="button"
                          onClick={() => onApplySuggestion(sug)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors cursor-pointer shrink-0"
                        >
                          Applica Modifica
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section 2: Detailed Day-by-Day & Per-Worker Constraint Conflict Inspector */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-slate-900" />
                  <h3 className="text-sm font-bold text-slate-900">
                    Dettaglio Conflitti per Giorno/Turno e Stato Vincoli per Singola Lavoratrice
                  </h3>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                  {/* Left column: List of uncovered shifts */}
                  <div className="lg:col-span-5 space-y-2 max-h-[320px] overflow-y-auto pr-1">
                    {insights.conflicts.map((conf) => {
                      const isSelected = activeConflict?.id === conf.id;
                      const shiftBadge =
                        conf.shiftType === 'BAR'
                          ? 'bg-[#FEF08A] text-slate-950 border-amber-300'
                          : conf.shiftType === 'MORNING'
                          ? 'bg-red-50 text-[#DC2626] border-red-200'
                          : 'bg-slate-900 text-white border-slate-900';
                      return (
                        <button
                          key={conf.id}
                          type="button"
                          onClick={() => setSelectedConflictId(conf.id)}
                          className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${
                            isSelected
                              ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                              : 'bg-white text-slate-900 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs font-bold">
                              {conf.dateStr} ({conf.dayAbbr}) · Sett. {conf.weekIndex}
                            </span>
                            <span
                              className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${shiftBadge}`}
                            >
                              {conf.shiftType === 'BAR'
                                ? 'BAR'
                                : conf.shiftType === 'MORNING'
                                ? 'MATTINA'
                                : 'POMERIGGIO'}{' '}
                              ({conf.shiftLabel})
                            </span>
                          </div>
                          <div
                            className={`text-xs mt-1.5 font-medium ${
                              isSelected ? 'text-slate-200' : 'text-slate-600'
                            }`}
                          >
                            Copertura: <strong>{conf.assignedSlots}</strong> su{' '}
                            <strong>{conf.requiredSlots}</strong> richieste (mancano{' '}
                            <strong className={isSelected ? 'text-amber-300' : 'text-red-600'}>
                              {conf.missingSlots}
                            </strong>
                            )
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Right column: Exact Worker Blockers for the selected conflict */}
                  <div className="lg:col-span-7 bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
                    {activeConflict ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                          <div>
                            <div className="text-xs font-bold text-slate-900">
                              Perché nessuna operatrice libera può coprire{' '}
                              {activeConflict.shiftType === 'BAR'
                                ? 'il Bar'
                                : activeConflict.shiftType === 'MORNING'
                                ? 'la Mattina'
                                : 'il Pomeriggio'}{' '}
                              il {activeConflict.dateStr} ({activeConflict.dayAbbr})?
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Analisi vincolo bloccante per ciascuna lavoratrice non ancora in turno
                              il {activeConflict.dateStr}:
                            </div>
                          </div>
                        </div>

                        <div className="max-h-[240px] overflow-y-auto divide-y divide-slate-200 bg-white border border-slate-200 rounded-md">
                          {activeConflict.workerBlockers.map((b) => {
                            const meta = CATEGORY_META[b.category];
                            const matchingWorkerSug = activeConflict.suggestions.find(
                              (s) => s.workerId === b.workerId
                            );
                            return (
                              <div
                                key={b.workerId}
                                className="p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                              >
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-slate-900">
                                      {b.workerName}
                                    </span>
                                    <span className="text-[10px] font-mono text-slate-500">
                                      ({b.workerType})
                                    </span>
                                    <span
                                      className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${meta.colorClass}`}
                                    >
                                      {meta.label}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-600 flex items-center gap-1">
                                    {b.category === 'MAX_WEEKLY_HOURS' && (
                                      <Clock className="w-3 h-3 text-amber-600 shrink-0" />
                                    )}
                                    {b.category === 'STAFF_UNAVAILABILITY' && (
                                      <UserX className="w-3 h-3 text-red-600 shrink-0" />
                                    )}
                                    {b.category === 'WEEKLY_REST_DAYS' && (
                                      <CalendarX className="w-3 h-3 text-purple-600 shrink-0" />
                                    )}
                                    <span>{b.constraintLabel}</span>
                                  </div>
                                </div>

                                {matchingWorkerSug && (
                                  <button
                                    type="button"
                                    onClick={() => onApplySuggestion(matchingWorkerSug)}
                                    className="px-2.5 py-1 text-[11px] font-bold text-slate-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                                  >
                                    {matchingWorkerSug.actionType === 'INCREASE_MAX_WEEKLY_HOURS'
                                      ? `Sblocca (+${matchingWorkerSug.deltaHours}h max/sett)`
                                      : matchingWorkerSug.actionType === 'REMOVE_ABSENCE_ON_DAY'
                                      ? 'Rimuovi Assenza'
                                      : matchingWorkerSug.actionType === 'ENABLE_WORKER_SKILL'
                                      ? 'Abilita Mansione'
                                      : 'Sblocca'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-4">
          <div className="text-xs text-slate-500">
            Tutte le modifiche applicate ricalcolano istantaneamente la turnazione ottimizzata.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            Chiudi Finestra
          </button>
        </div>
      </div>
    </div>
  );
};
