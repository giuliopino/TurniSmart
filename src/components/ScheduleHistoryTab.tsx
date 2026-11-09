import React, { useState, useMemo, useRef } from 'react';
import {
  History,
  Save,
  Eye,
  FolderOpen,
  FileSpreadsheet,
  Image as ImageIcon,
  Trash2,
  Download,
  Upload,
  CheckCircle2,
  Calendar,
  X,
} from 'lucide-react';
import { AppConfig, ConfirmedScheduleEntry, ScheduleSolution, WorkerSummaryStats } from '../types';
import {
  formatPeriodLabel,
  generateCalendarForMonth,
  getMonthDateBounds,
  ITALIAN_MONTHS,
} from '../defaultData';
import { solveWorkforceSchedule } from '../services/solverEngine';
import {
  exportAllHistoryToExcel,
  exportScheduleToExcel,
  importSchedulesFromExcelFile,
} from '../services/excelExporter';
import { exportScheduleToJpeg } from '../services/imageExporter';
import { SchedulePaperTable } from './SchedulePaperTable';

interface ScheduleHistoryTabProps {
  config: AppConfig;
  solution: ScheduleSolution;
  onUpdateHistory: (newHistory: ConfirmedScheduleEntry[]) => void;
  onLoadHistoryEntryIntoWorkspace: (entryConfig: AppConfig) => void;
}

function formatDateIt(iso?: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export const ScheduleHistoryTab: React.FC<ScheduleHistoryTabProps> = ({
  config,
  solution,
  onUpdateHistory,
  onLoadHistoryEntryIntoWorkspace,
}) => {
  const defaultPeriodTitle = useMemo(() => {
    const mObj = ITALIAN_MONTHS.find((m) => m.value === config.month) || ITALIAN_MONTHS[10];
    return `${mObj.name} ${config.year}`;
  }, [config.month, config.year]);

  const defaultDateRangeStr = useMemo(() => {
    const first = config.calendar[0]?.isoDate;
    const last = config.calendar[config.calendar.length - 1]?.isoDate;
    if (first && last) {
      return `${formatDateIt(first)} - ${formatDateIt(last)}`;
    }
    const bounds = getMonthDateBounds(config.month, config.year, config.extraDaysAfterMonth || 0);
    return `${formatDateIt(bounds.startDate)} - ${formatDateIt(bounds.endDate)}`;
  }, [config.calendar, config.month, config.year, config.extraDaysAfterMonth]);

  const [customPeriodName, setCustomPeriodName] = useState('');
  const [customDateInterval, setCustomDateInterval] = useState('');
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const excelInputRef = useRef<HTMLInputElement | null>(null);

  const historyList = config.history || [];

  // Sort strictly in descending chronological order (most recent year/month/timestamp at the top)
  const sortedHistoryDesc = useMemo(() => {
    return [...historyList].sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      if (b.month !== a.month) return b.month - a.month;
      return new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime();
    });
  }, [historyList]);

  const showToast = (msg: string) => {
    setFeedbackMessage(msg);
    setTimeout(() => setFeedbackMessage(null), 5000);
  };

  // Reconstruct a complete AppConfig + ScheduleSolution for any historical entry (for Preview, Excel, JPEG, or Workspace Load)
  const reconstructEntryBundle = (
    entry: ConfirmedScheduleEntry
  ): { entryConfig: AppConfig; entrySolution: ScheduleSolution } => {
    const entryCalendar =
      Array.isArray(entry.calendar) && entry.calendar.length > 0
        ? entry.calendar
        : generateCalendarForMonth(entry.month, entry.year, 1, 4, 2, 0);

    const bounds = getMonthDateBounds(entry.month, entry.year, 0);
    const entryConfig: AppConfig = {
      ...config,
      month: entry.month,
      year: entry.year,
      periodMode: 'MONTHLY',
      customStartDate: entryCalendar[0]?.isoDate || bounds.startDate,
      customEndDate: entryCalendar[entryCalendar.length - 1]?.isoDate || bounds.endDate,
      extraDaysAfterMonth: Math.max(
        0,
        entryCalendar.length - new Date(entry.year, entry.month, 0).getDate()
      ),
      shiftConfig: entry.shiftConfig || config.shiftConfig,
      shiftExceptions: entry.shiftExceptions || [],
      calendar: entryCalendar,
      absences: [],
    };

    if (entry.assignments && Object.keys(entry.assignments).length > 0) {
      const mappedStats: Record<string, WorkerSummaryStats> = {};
      for (const w of config.workers) {
        const st = entry.workerStats[w.id];
        const rate = w.hourlyRate || (w.type === 'Sostituta' ? 13.0 : 12.5);
        const totH = st?.totalHours || 0;
        const targH = st?.targetHours ?? (w.type === 'Fisso' ? 160 : 0);
        const bH = st?.barHours ?? (st?.barCount || 0) * 6.5;
        const mH = st?.morningHours ?? (st?.morningCount || 0) * 6.5;
        const aH = st?.afternoonHours ?? (st?.afternoonCount || 0) * 6.5;
        mappedStats[w.id] = {
          workerId: w.id,
          workerName: w.name,
          totalHours: totH,
          targetHours: targH,
          hoursDelta: totH - targH,
          barCount: st?.barCount || 0,
          morningCount: st?.morningCount || 0,
          afternoonCount: st?.afternoonCount || 0,
          barHours: Math.round(bH),
          morningHours: Math.round(mH),
          afternoonHours: Math.round(aH),
          hourlyRate: rate,
          barCost: Math.round(bH * rate * 100) / 100,
          morningCost: Math.round(mH * rate * 100) / 100,
          afternoonCost: Math.round(aH * rate * 100) / 100,
          totalCost: Math.round(totH * rate * 100) / 100,
          workedDays: st?.workedDays || 0,
          availableDays: entryCalendar.length - (st?.absenceDays || 0),
          absenceDays: st?.absenceDays || 0,
          sundaysWorked: st?.sundaysWorked || 0,
          holidaysWorked: st?.holidaysWorked || 0,
        };
      }

      const entrySolution: ScheduleSolution = {
        status: 'OPTIMAL',
        solveTimeMs: 12,
        objectiveScore: 100,
        assignments: entry.assignments,
        diagnostics: [
          {
            level: 'INFO',
            message: `Orario storico archiviato: ${entry.periodLabel} (${entry.customRangeLabel || ''}).`,
          },
        ],
        workerStats: mappedStats,
        hoursSpreadFisse: 2,
        morningSpreadFisse: 1,
        afternoonSpreadFisse: 1,
        solveInsights: {
          hasConflicts: false,
          totalUncoveredShifts: 0,
          affectedDaysCount: 0,
          conflicts: [],
          topSuggestions: [],
          unsatCoreSummary: [],
        },
      };
      return { entryConfig, entrySolution };
    }

    const solved = solveWorkforceSchedule(entryConfig);
    return { entryConfig, entrySolution: solved };
  };

  // Explicit Archive Handler
  const handleArchiveCurrentSchedule = (e: React.FormEvent) => {
    e.preventDefault();
    const labelTitle = customPeriodName.trim() || defaultPeriodTitle;
    const rangeStr = customDateInterval.trim() || defaultDateRangeStr;
    const fullPeriodLabel = `${labelTitle} (${rangeStr})`;

    const entryId = `hist-${config.year}-${String(config.month).padStart(2, '0')}-${Date.now()}`;

    const newEntry: ConfirmedScheduleEntry = {
      id: entryId,
      confirmedAt: new Date().toISOString(),
      periodLabel: fullPeriodLabel,
      customRangeLabel: rangeStr,
      month: config.month,
      year: config.year,
      numDays: config.calendar.length,
      calendar: config.calendar.map((d) => ({ ...d })),
      shiftConfig: JSON.parse(JSON.stringify(config.shiftConfig)),
      shiftExceptions: config.shiftExceptions ? [...config.shiftExceptions] : [],
      assignments: JSON.parse(JSON.stringify(solution.assignments)),
      workerStats: Object.fromEntries(
        config.workers.map((w) => {
          const st = solution.workerStats[w.id];
          return [
            w.id,
            {
              workerId: w.id,
              workerName: w.name,
              totalHours: st?.totalHours || 0,
              targetHours: w.type === 'Fisso' ? Math.round(160 * (w.maxWeeklyHours / 40)) : 0,
              barCount: st?.barCount || 0,
              morningCount: st?.morningCount || 0,
              afternoonCount: st?.afternoonCount || 0,
              barHours: st?.barHours || 0,
              morningHours: st?.morningHours || 0,
              afternoonHours: st?.afternoonHours || 0,
              hourlyRate: w.hourlyRate || 12.5,
              totalCost: st?.totalCost || 0,
              workedDays: st?.workedDays || 0,
              absenceDays: st?.absenceDays || 0,
              sundaysWorked: st?.sundaysWorked || 0,
              holidaysWorked: st?.holidaysWorked || 0,
            },
          ];
        })
      ),
    };

    const existingSameMonthIdx = historyList.findIndex(
      (h) =>
        h.month === config.month &&
        h.year === config.year &&
        h.periodLabel.toLowerCase() === fullPeriodLabel.toLowerCase()
    );

    let updated: ConfirmedScheduleEntry[];
    if (existingSameMonthIdx >= 0) {
      updated = [...historyList];
      updated[existingSameMonthIdx] = newEntry;
    } else {
      updated = [newEntry, ...historyList];
    }

    onUpdateHistory(updated);
    setPreviewEntryId(newEntry.id);
    setCustomPeriodName('');
    setCustomDateInterval('');
    showToast(
      `Orario "${fullPeriodLabel}" archiviato nello Storico! Il solver lo userà per equilibrare ore, weekend/festività e turni.`
    );
  };

  const handleDeleteRecord = (entry: ConfirmedScheduleEntry) => {
    const updated = historyList.filter((h) => h.id !== entry.id);
    onUpdateHistory(updated);
    if (previewEntryId === entry.id) {
      setPreviewEntryId(null);
    }
    showToast(`Record "${entry.periodLabel}" rimosso dallo storico.`);
  };

  const handleLoadIntoActiveWorkspace = (entry: ConfirmedScheduleEntry) => {
    const { entryConfig } = reconstructEntryBundle(entry);
    onLoadHistoryEntryIntoWorkspace(entryConfig);
    showToast(`Orario "${entry.periodLabel}" caricato nell'area di lavoro attiva!`);
  };

  const handleExportRecordExcel = (entry: ConfirmedScheduleEntry) => {
    const { entryConfig, entrySolution } = reconstructEntryBundle(entry);
    exportScheduleToExcel(entryConfig, entrySolution);
  };

  const handleExportRecordJpeg = (entry: ConfirmedScheduleEntry) => {
    const { entryConfig, entrySolution } = reconstructEntryBundle(entry);
    exportScheduleToJpeg(entryConfig, entrySolution, { includeSummaryFooter: false });
  };

  const handleExportAllHistoryExcel = () => {
    if (sortedHistoryDesc.length === 0) return;
    exportAllHistoryToExcel(config, sortedHistoryDesc);
    showToast('Intero archivio storico esportato in formato Microsoft Excel (.xlsx)!');
  };

  const handleImportHistoryFromExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    let combined = [...historyList];
    let totalImported = 0;

    for (let i = 0; i < files.length; i++) {
      try {
        const parsedEntries = await importSchedulesFromExcelFile(
          files[i],
          config,
          undefined,
          undefined,
          customPeriodName.trim() || undefined
        );
        for (const newRec of parsedEntries) {
          const existingIdx = combined.findIndex(
            (h) => h.month === newRec.month && h.year === newRec.year
          );
          if (existingIdx >= 0) {
            combined[existingIdx] = newRec;
          } else {
            combined = [newRec, ...combined];
          }
          totalImported++;
        }
      } catch {
        // Ignore invalid file
      }
    }

    if (totalImported > 0) {
      onUpdateHistory(combined);
      setPreviewEntryId(combined[0]?.id || null);
      showToast(
        `Caricati con successo ${totalImported} turni mensili da file Excel (.xlsx) nello Storico! Il solver ora bilancerà festività, weekend, ore e turni in base a questi dati.`
      );
    }
    e.target.value = '';
  };

  const previewEntry = useMemo(
    () => sortedHistoryDesc.find((h) => h.id === previewEntryId) || null,
    [sortedHistoryDesc, previewEntryId]
  );

  const previewBundle = useMemo(
    () => (previewEntry ? reconstructEntryBundle(previewEntry) : null),
    [previewEntry, config.workers]
  );

  const fissoWorkers = config.workers.filter((w) => w.active && w.type === 'Fisso');

  return (
    <div className="space-y-6">
      {/* Top Header & Archive Form */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <History className="w-5 h-5 text-slate-900" />
              <h1 className="text-xl font-bold text-slate-900">
                Storico Turni — Caricamento da Excel (.xlsx) & Bilanciamento Plurimensile
              </h1>
              <span className="text-xs font-mono text-slate-500">
                ({sortedHistoryDesc.length} periodi salvati · Ordine dal più recente)
              </span>
            </div>
            <p className="text-sm text-slate-600">
              Puoi <strong>caricare turni passati direttamente da file Excel (.xlsx)</strong> oppure
              archiviare il mese corrente. Il motore matematico legge automaticamente lo storico per{' '}
              <strong className="text-slate-900">
                equilibrare festività/weekend (Domeniche e Festivi), monte ore (~160h) e rotazione
                Mattina/Pomeriggio
              </strong>{' '}
              nella creazione dei nuovi turni.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <input
              ref={excelInputRef}
              type="file"
              accept=".xlsx,.xls"
              multiple
              onChange={handleImportHistoryFromExcel}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => excelInputRef.current?.click()}
              data-tt-title="Carica Turni Passati nello Storico da File Excel (.xlsx)"
              data-tt-purpose="Importa uno o più file Excel (.xlsx) di turni precedenti dentro l'Archivio Storico Turni."
              data-tt-effect="Estrae automaticamente orari, ore lavorate, domeniche, festività e turni Mattina/Pomeriggio di ogni lavoratrice e li usa per bilanciare la generazione dei nuovi turni."
              data-tt-req="Supporta qualsiasi file .xlsx esportato dal programma o strutturato con colonne Data, Giorno e Lavoratrici."
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Importa Turni da Excel (.xlsx) nello Storico
            </button>
            <button
              type="button"
              onClick={handleExportAllHistoryExcel}
              data-tt-title="Esporta Intero Storico in Formato Excel (.xlsx)"
              data-tt-purpose="Scarica un unico file Excel (.xlsx) multi-foglio contenente il riepilogo globale e tutti i mesi dello storico."
              data-tt-effect="Crea un file Excel completo che può anche essere ricaricato in qualsiasi momento nello Storico."
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Esporta Intero Storico in Excel (.xlsx)
            </button>
          </div>
        </div>

        {/* Explicit Archiving Bar */}
        <form
          onSubmit={handleArchiveCurrentSchedule}
          className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1">
                Periodo di Riferimento (Mese / Titolo)
              </label>
              <input
                type="text"
                value={customPeriodName}
                onChange={(e) => setCustomPeriodName(e.target.value)}
                placeholder={`Es. ${defaultPeriodTitle}`}
                className="w-full px-3 py-2 text-xs font-semibold bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1">
                Intervallo Date (Dal → Al)
              </label>
              <input
                type="text"
                value={customDateInterval}
                onChange={(e) => setCustomDateInterval(e.target.value)}
                placeholder={`Es. ${defaultDateRangeStr}`}
                className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div className="flex flex-col justify-end">
              <div className="text-[11px] text-slate-500">Orario Attivo Pronto per Archiviazione:</div>
              <div className="text-xs font-bold text-slate-900 truncate">
                {formatPeriodLabel(config)} · {config.calendar.length} giorni
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Save className="w-4 h-4" />
            Salva e Archivia Orario Corrente nello Storico
          </button>
        </form>

        {feedbackMessage && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-900">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{feedbackMessage}</span>
          </div>
        )}
      </div>

      {/* Preview Modal / Panel when an archived schedule is selected for viewing */}
      {previewEntry && previewBundle && (
        <div className="bg-white border-2 border-slate-900 rounded-lg p-5 space-y-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2.5">
              <Eye className="w-5 h-5 text-slate-900" />
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Anteprima Orario Archiviato: {previewEntry.periodLabel}
                </h2>
                <p className="text-xs text-slate-500 font-mono">
                  Salvato il {new Date(previewEntry.confirmedAt).toLocaleString('it-IT')} ·{' '}
                  {previewEntry.numDays} giorni
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleLoadIntoActiveWorkspace(previewEntry)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Carica nell&apos;Area di Lavoro Attiva
              </button>
              <button
                type="button"
                onClick={() => handleExportRecordJpeg(previewEntry)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-950 bg-[#FEF08A] border border-amber-400 rounded-md hover:bg-amber-200 cursor-pointer"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                Esporta JPEG ({previewEntry.month}/{previewEntry.year})
              </button>
              <button
                type="button"
                onClick={() => handleExportRecordExcel(previewEntry)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 rounded-md hover:bg-emerald-800 cursor-pointer"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Esporta Excel (.xlsx)
              </button>
              <button
                type="button"
                onClick={() => setPreviewEntryId(null)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-md hover:bg-slate-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Chiudi Anteprima
              </button>
            </div>
          </div>

          <SchedulePaperTable
            config={previewBundle.entryConfig}
            solution={previewBundle.entrySolution}
            showSummaryFooter={true}
          />
        </div>
      )}

      {/* Chronological Descending List of Archived Schedules */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-100 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-800">
            Elenco Orari Archiviati (Ordine Cronologico Decrescente: Dal Più Recente al Più Vecchio)
          </span>
          <span className="text-xs text-slate-600">
            Clicca su <strong>Anteprima Griglia</strong> per vedere i turni del mese oppure riesporta
            Excel / JPEG
          </span>
        </div>

        <div className="divide-y divide-slate-200">
          {sortedHistoryDesc.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Nessun orario salvato nello storico. Usa il pulsante in alto per archiviare il primo
              mese.
            </div>
          ) : (
            sortedHistoryDesc.map((entry, idx) => {
              const isSelectedForPreview = previewEntryId === entry.id;
              return (
                <div
                  key={entry.id}
                  className={`p-5 transition-colors ${
                    isSelectedForPreview ? 'bg-slate-50' : 'hover:bg-slate-50/60'
                  }`}
                >
                  <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                    {/* Left: Chronological Header & Metadata */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-xs font-bold text-slate-500">
                          #{String(idx + 1).padStart(2, '0')}
                        </span>
                        <Calendar className="w-4 h-4 text-slate-800" />
                        <h3 className="text-base font-bold text-slate-900">{entry.periodLabel}</h3>
                        {idx === 0 && (
                          <span className="text-xs font-semibold text-emerald-700">
                            · Più Recente
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 font-mono">
                        <span>
                          Mese/Anno: {String(entry.month).padStart(2, '0')}/{entry.year}
                        </span>
                        <span>·</span>
                        <span>Durata: {entry.numDays} giorni</span>
                        <span>·</span>
                        <span>
                          Archiviato il: {new Date(entry.confirmedAt).toLocaleDateString('it-IT')}
                        </span>
                      </div>
                    </div>

                    {/* Right: Action Buttons */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewEntryId(isSelectedForPreview ? null : entry.id)
                        }
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors cursor-pointer ${
                          isSelectedForPreview
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        <Eye className="w-3.5 h-3.5" />
                        {isSelectedForPreview ? 'Nascondi Griglia' : 'Anteprima Griglia Turni'}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleLoadIntoActiveWorkspace(entry)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 transition-colors cursor-pointer"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Carica nell&apos;Area Attiva
                      </button>

                      <button
                        type="button"
                        onClick={() => handleExportRecordJpeg(entry)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-950 bg-[#FEF08A] border border-amber-400 rounded-md hover:bg-amber-200 transition-colors cursor-pointer"
                      >
                        <ImageIcon className="w-3.5 h-3.5" />
                        JPEG
                      </button>

                      <button
                        type="button"
                        onClick={() => handleExportRecordExcel(entry)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 rounded-md hover:bg-emerald-800 transition-colors cursor-pointer"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Excel (.xlsx)
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteRecord(entry)}
                        title="Elimina questo record dallo storico"
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Worker Summary Strip (Referenced by Immutable Numeric ID) */}
                  <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                    {fissoWorkers.map((w) => {
                      const st = entry.workerStats[w.id];
                      return (
                        <div
                          key={w.id}
                          className="px-2.5 py-1.5 bg-slate-50 border border-slate-200/80 rounded text-xs flex items-center justify-between"
                        >
                          <span className="font-semibold text-slate-800 truncate" title={`ID #${w.id} - ${w.name}`}>
                            <span className="text-[10px] font-mono text-slate-400 mr-1">
                              #{w.id}
                            </span>
                            {w.name}
                          </span>
                          <span className="font-mono font-bold text-slate-950 ml-1">
                            {st?.totalHours || 0}h
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
