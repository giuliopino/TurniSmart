import React, { useState, useRef } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  LineChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  Cell,
} from 'recharts';
import {
  History,
  Save,
  Download,
  Upload,
  Trash2,
  RotateCcw,
  CheckCircle2,
  TrendingUp,
  BarChart3,
  CalendarCheck,
} from 'lucide-react';
import { AppConfig, ConfirmedScheduleEntry, ScheduleSolution } from '../types';
import { DEFAULT_HISTORY, formatPeriodLabel, ITALIAN_MONTHS } from '../defaultData';

interface HistoricalAnalyticsSectionProps {
  config: AppConfig;
  solution: ScheduleSolution;
  onUpdateHistory: (newHistory: ConfirmedScheduleEntry[]) => void;
  onToggleHistoricalEquity: (enabled: boolean) => void;
}

const WORKER_COLORS = [
  '#0f172a', // Ioana
  '#dc2626', // Sabrina
  '#2563eb', // Ilaria
  '#059669', // Elena
  '#d97706', // Maria
  '#7c3aed', // Giulia
  '#db2777', // Anna
  '#0891b2', // Francesca
];

export const HistoricalAnalyticsSection: React.FC<HistoricalAnalyticsSectionProps> = ({
  config,
  solution,
  onUpdateHistory,
  onToggleHistoricalEquity,
}) => {
  const [chartTab, setChartTab] = useState<
    'CURRENT_VS_TARGET' | 'MONTHLY_TREND' | 'ROTATION_FERIE'
  >('CURRENT_VS_TARGET');
  const [includeSubstitutes, setIncludeSubstitutes] = useState(false);
  const [selectedWorkerFilter, setSelectedWorkerFilter] = useState<string>('ALL_FISSE');
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const historyFileInputRef = useRef<HTMLInputElement | null>(null);

  const historyList = config.history || [];
  const pastHistory = historyList.filter(
    (entry) => !(entry.month === config.month && entry.year === config.year)
  );
  const isCurrentPeriodSaved = historyList.some(
    (entry) => entry.month === config.month && entry.year === config.year
  );

  const activeWorkers = config.workers.filter(
    (w) => w.active && (includeSubstitutes || w.type === 'Fisso')
  );
  const fissoWorkers = config.workers.filter((w) => w.active && w.type === 'Fisso');

  // 1. Data for Chart 1: Current Month vs Past Historical Average vs 160h Target
  const comparisonData = activeWorkers.map((w) => {
    const st = solution.workerStats[w.id];
    const currentHours = st?.totalHours || 0;
    const target160 = w.type === 'Fisso' ? Math.round(160 * (w.maxWeeklyHours / 40)) : 0;

    let sumPastHours = 0;
    let countPast = 0;
    for (const h of pastHistory) {
      const wStat = h.workerStats[w.id];
      if (wStat) {
        sumPastHours += wStat.totalHours;
        countPast++;
      }
    }

    const avgPastHours =
      countPast > 0 ? Math.round((sumPastHours / countPast) * 10) / 10 : currentHours;
    const cumulativeAvg =
      countPast > 0
        ? Math.round(((sumPastHours + currentHours) / (countPast + 1)) * 10) / 10
        : currentHours;

    return {
      workerId: w.id,
      name: w.name,
      type: w.type,
      oreAttuali: currentHours,
      mediaStorica: avgPastHours,
      mediaCumulativa: cumulativeAvg,
      target160,
      scartoTargetAttuale: currentHours - target160,
      ferieStoriche: st?.historicalAbsenceDays || 0,
      domenicheStoriche: st?.historicalSundaysWorked || 0,
    };
  });

  // 2. Data for Chart 2: Chronological Month-by-Month Trend (Past Months + Current Month)
  const sortedPast = [...pastHistory].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month
  );

  const currentMonthAbbr =
    ITALIAN_MONTHS.find((m) => m.value === config.month)?.abbr || String(config.month);

  const trendTimelineData = [
    ...sortedPast.map((entry) => {
      const mAbbr =
        ITALIAN_MONTHS.find((m) => m.value === entry.month)?.name.slice(0, 3) ||
        String(entry.month);
      const row: Record<string, string | number> = {
        period: `${mAbbr} ${entry.year}`,
        target160: 160,
      };
      let sumFisse = 0;
      let countFisse = 0;
      for (const w of fissoWorkers) {
        const st = entry.workerStats[w.id];
        const hrs = st?.totalHours || 0;
        row[w.name] = hrs;
        sumFisse += hrs;
        countFisse++;
      }
      row['Media Fisse'] = countFisse > 0 ? Math.round((sumFisse / countFisse) * 10) / 10 : 160;
      return row;
    }),
    (() => {
      const row: Record<string, string | number> = {
        period: `${currentMonthAbbr.toUpperCase()} ${config.year} (Attuale)`,
        target160: 160,
      };
      let sumFisse = 0;
      let countFisse = 0;
      for (const w of fissoWorkers) {
        const hrs = solution.workerStats[w.id]?.totalHours || 0;
        row[w.name] = hrs;
        sumFisse += hrs;
        countFisse++;
      }
      row['Media Fisse'] = countFisse > 0 ? Math.round((sumFisse / countFisse) * 10) / 10 : 160;
      return row;
    })(),
  ];

  // 3. Data for Chart 3: Historical Rotation of Mornings, Afternoons, Sundays & Ferie
  const rotationData = fissoWorkers.map((w) => {
    const st = solution.workerStats[w.id];
    const histMat = (st?.historicalMorningCount || 0) + (st?.historicalBarCount || 0);
    const currMat = (st?.morningCount || 0) + (st?.barCount || 0);
    const histPom = st?.historicalAfternoonCount || 0;
    const currPom = st?.afternoonCount || 0;
    const histSun = st?.historicalSundaysWorked || 0;
    const currSun = st?.sundaysWorked || 0;
    const histAbs = st?.historicalAbsenceDays || 0;
    const currAbs = st?.absenceDays || 0;

    return {
      name: w.name,
      mattineTotali: histMat + currMat,
      pomeriggiTotali: histPom + currPom,
      domenicheTotali: histSun + currSun,
      giorniFerieAssenze: histAbs + currAbs,
      mattineAttuali: currMat,
      pomeriggiAttuali: currPom,
    };
  });

  // Save/Update current month schedule into history (localStorage)
  const handleSaveCurrentToHistory = () => {
    const entryId = `hist-${config.year}-${String(config.month).padStart(2, '0')}`;
    const newEntry: ConfirmedScheduleEntry = {
      id: entryId,
      confirmedAt: new Date().toISOString(),
      periodLabel: formatPeriodLabel(config),
      month: config.month,
      year: config.year,
      numDays: config.calendar.length,
      calendar: config.calendar,
      assignments: solution.assignments,
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
              workedDays: st?.workedDays || 0,
              absenceDays: st?.absenceDays || 0,
              sundaysWorked: st?.sundaysWorked || 0,
              holidaysWorked: st?.holidaysWorked || 0,
            },
          ];
        })
      ),
    };

    const existingIdx = historyList.findIndex(
      (h) => h.month === config.month && h.year === config.year
    );
    let updated: ConfirmedScheduleEntry[];
    if (existingIdx >= 0) {
      updated = [...historyList];
      updated[existingIdx] = newEntry;
    } else {
      updated = [...historyList, newEntry].sort((a, b) =>
        a.year !== b.year ? a.year - b.year : a.month - b.month
      );
    }

    onUpdateHistory(updated);
    setSaveFeedback(
      `Pianificazione "${newEntry.periodLabel}" salvata nello storico (localStorage)!`
    );
    setTimeout(() => setSaveFeedback(null), 4000);
  };

  // Export History JSON to File System
  const handleExportHistoryFile = () => {
    const payload = {
      app: 'Turni di Lavoro RT - Archivio Storico Pianificazioni',
      exportedAt: new Date().toISOString(),
      monthlyTargetHours: 160,
      history: historyList,
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `storico_turni_rt_${config.year}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Import History JSON from File System
  const handleImportHistoryFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.target?.result));
        const importedEntries: ConfirmedScheduleEntry[] | null = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.history)
          ? parsed.history
          : null;
        if (importedEntries && importedEntries.length > 0) {
          onUpdateHistory(importedEntries);
          setSaveFeedback(
            `Importati ${importedEntries.length} mesi di storico da file JSON e sincronizzati in localStorage!`
          );
          setTimeout(() => setSaveFeedback(null), 4000);
        }
      } catch {
        // Ignore invalid file
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleDeleteHistoryEntry = (id: string) => {
    onUpdateHistory(historyList.filter((h) => h.id !== id));
  };

  const handleResetDefaultHistory = () => {
    onUpdateHistory(DEFAULT_HISTORY);
    setSaveFeedback('Ripristinato storico predefinito (Agosto – Ottobre 2026).');
    setTimeout(() => setSaveFeedback(null), 3500);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
      {/* Header & Persistence Action Bar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <History className="w-5 h-5 text-slate-900" />
            <h2 className="text-base font-bold text-slate-900">
              Analisi Grafica Storico Ore (Recharts) &amp; Confronto Target Mensile 160h
            </h2>
            <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded">
              {pastHistory.length} mesi passati in archivio + Mese Attuale
            </span>
          </div>
          <p className="text-xs text-slate-600">
            Lo storico delle pianificazioni è salvato automaticamente in{' '}
            <code className="font-mono font-semibold text-slate-800">localStorage</code> ed è
            esportabile/importabile su <strong className="text-slate-800">File System (.json)</strong>.
            Il solver accede ai mesi precedenti per compensare ferie pregresse, rotazione domeniche
            e bilanciamento Mattine/Pomeriggi rispetto al target di <strong className="text-slate-900">160 ore/mese</strong>.
          </p>
        </div>

        {/* Persistence Buttons (localStorage + File System) */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <input
            ref={historyFileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportHistoryFile}
            className="hidden"
          />

          <button
            type="button"
            onClick={handleSaveCurrentToHistory}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            {isCurrentPeriodSaved
              ? 'Aggiorna Mese nello Storico'
              : 'Salva Mese Corrente nello Storico'}
          </button>

          <button
            type="button"
            onClick={handleExportHistoryFile}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Esporta Storico (.json)
          </button>

          <button
            type="button"
            onClick={() => historyFileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            Importa Storico (.json)
          </button>

          <button
            type="button"
            onClick={handleResetDefaultHistory}
            title="Ripristina i 3 mesi storici predefiniti (Ago-Ott 2026)"
            className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Storico Demo
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {saveFeedback && (
        <div className="flex items-center gap-2 px-3.5 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{saveFeedback}</span>
        </div>
      )}

      {/* Controls Bar: Chart Mode Switcher + Historical Solver Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setChartTab('CURRENT_VS_TARGET')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              chartTab === 'CURRENT_VS_TARGET'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            1. Confronto Mese Attuale vs Storico &amp; Target 160h
          </button>

          <button
            type="button"
            onClick={() => setChartTab('MONTHLY_TREND')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              chartTab === 'MONTHLY_TREND'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            2. Trend Storico Mensile (Mesi Passati → Oggi)
          </button>

          <button
            type="button"
            onClick={() => setChartTab('ROTATION_FERIE')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              chartTab === 'ROTATION_FERIE'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CalendarCheck className="w-3.5 h-3.5" />
            3. Bilanciamento Storico Mattine / Pomeriggi / Domeniche / Ferie
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {chartTab === 'CURRENT_VS_TARGET' && (
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSubstitutes}
                onChange={(e) => setIncludeSubstitutes(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900 cursor-pointer"
              />
              Mostra anche Sostitute (Caterina / Patrizia)
            </label>
          )}

          {chartTab === 'MONTHLY_TREND' && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600">Filtra lavoratrice:</span>
              <select
                value={selectedWorkerFilter}
                onChange={(e) => setSelectedWorkerFilter(e.target.value)}
                className="px-2.5 py-1 text-xs font-semibold bg-white border border-slate-300 rounded-md"
              >
                <option value="ALL_FISSE">Tutte le 8 Lavoratrici Fisse (inclusa Ioana)</option>
                {fissoWorkers.map((w) => (
                  <option key={w.id} value={w.name}>
                    Solo {w.name} vs Target 160h
                  </option>
                ))}
              </select>
            </div>
          )}

          <label className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md cursor-pointer">
            <input
              type="checkbox"
              checked={config.constraints.useHistoricalEquity !== false}
              onChange={(e) => onToggleHistoricalEquity(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-slate-900 cursor-pointer"
            />
            <span className="text-xs font-semibold text-slate-800">
              Bilanciamento Storico Solver Attivo
            </span>
          </label>
        </div>
      </div>

      {/* Recharts Visualization Area */}
      <div className="bg-slate-50/70 border border-slate-200 rounded-lg p-4">
        {chartTab === 'CURRENT_VS_TARGET' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-bold text-slate-800">
                Distribuzione Ore Mese Corrente ({formatPeriodLabel(config)}) vs Media Mesi Passati
                e Target Contrattuale 160h
              </div>
              <div className="flex items-center gap-4 text-[11px] font-mono text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-xs bg-slate-900 inline-block" />
                  Ore Mese Attuale
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-xs bg-sky-500 inline-block" />
                  Media Storica Mesi Passati
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-amber-600 inline-block" />
                  Media Cumulativa Multi-Mese
                </span>
                <span className="inline-flex items-center gap-1.5 text-red-600 font-bold">
                  --- Target 160h/mese
                </span>
              </div>
            </div>

            <div className="h-[340px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={comparisonData}
                  margin={{ top: 18, right: 28, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12, fontWeight: 700, fill: '#0f172a' }}
                  />
                  <YAxis
                    domain={[0, 185]}
                    ticks={[0, 40, 80, 120, 160, 180]}
                    tick={{ fontSize: 11, fill: '#475569' }}
                    unit="h"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#ffffff',
                      borderColor: '#cbd5e1',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                    formatter={(value: unknown, name: unknown) => [`${value}h`, String(name)]}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '6px' }} />
                  <ReferenceLine
                    y={160}
                    stroke="#dc2626"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    label={{
                      value: 'Target Mensile Fisse: 160h',
                      position: 'top',
                      fill: '#dc2626',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  />
                  <Bar
                    dataKey="mediaStorica"
                    name="Media Ore Mesi Passati"
                    fill="#38bdf8"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                  <Bar
                    dataKey="oreAttuali"
                    name="Ore Pianificate Mese Attuale"
                    fill="#0f172a"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  >
                    {comparisonData.map((entry, idx) => (
                      <Cell
                        key={`cell-${idx}`}
                        fill={entry.type === 'Sostituta' ? '#64748b' : '#0f172a'}
                      />
                    ))}
                  </Bar>
                  <Line
                    type="monotone"
                    dataKey="mediaCumulativa"
                    name="Media Cumulativa (Storico + Attuale)"
                    stroke="#d97706"
                    strokeWidth={2.5}
                    dot={{ r: 4, fill: '#d97706', strokeWidth: 1.5, stroke: '#fff' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {chartTab === 'MONTHLY_TREND' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-bold text-slate-800">
                Evoluzione Storica Mensile Ore Lavorate ({sortedPast.length} mesi passati + periodo
                corrente) rispetto al Target 160h
              </div>
              <div className="text-[11px] text-slate-500">
                Le flessioni nei mesi estivi (es. Agosto/Settembre) riflettono i giorni di ferie
                registrati nello storico e compensati nei mesi successivi.
              </div>
            </div>

            <div className="h-[340px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={trendTimelineData}
                  margin={{ top: 18, right: 28, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="period"
                    tick={{ fontSize: 12, fontWeight: 700, fill: '#0f172a' }}
                  />
                  <YAxis
                    domain={[135, 175]}
                    ticks={[140, 150, 160, 165, 170]}
                    tick={{ fontSize: 11, fill: '#475569' }}
                    unit="h"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#ffffff',
                      borderColor: '#cbd5e1',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                    formatter={(value: unknown, name: unknown) => [`${value}h`, String(name)]}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '6px' }} />
                  <ReferenceLine
                    y={160}
                    stroke="#dc2626"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    label={{
                      value: 'Target 160h',
                      position: 'right',
                      fill: '#dc2626',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  />
                  {fissoWorkers
                    .filter(
                      (w) => selectedWorkerFilter === 'ALL_FISSE' || w.name === selectedWorkerFilter
                    )
                    .map((w, idx) => (
                      <Line
                        key={w.id}
                        type="monotone"
                        dataKey={w.name}
                        name={w.name}
                        stroke={WORKER_COLORS[idx % WORKER_COLORS.length]}
                        strokeWidth={selectedWorkerFilter === 'ALL_FISSE' ? 2 : 3}
                        dot={{ r: 4 }}
                        activeDot={{ r: 6 }}
                      />
                    ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {chartTab === 'ROTATION_FERIE' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-bold text-slate-800">
                Bilanciamento Cumulativo Multi-Mese: Turni Mattina/Bar, Pomeriggi, Domeniche
                Lavorate e Giorni di Ferie Goduti
              </div>
              <div className="text-[11px] text-slate-500">
                Somma storica ({pastHistory.length} mesi archiviati + mese corrente) per verificare
                l&apos;equità delle rotazioni nel lungo periodo.
              </div>
            </div>

            <div className="h-[340px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={rotationData}
                  margin={{ top: 18, right: 28, left: 4, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12, fontWeight: 700, fill: '#0f172a' }}
                  />
                  <YAxis tick={{ fontSize: 11, fill: '#475569' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#ffffff',
                      borderColor: '#cbd5e1',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '6px' }} />
                  <Bar
                    dataKey="mattineTotali"
                    name="Turni Mattina/Bar Cumulativi"
                    fill="#dc2626"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="pomeriggiTotali"
                    name="Turni Pomeriggio Cumulativi"
                    fill="#0f172a"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="domenicheTotali"
                    name="Domeniche Lavorate Cumulative"
                    fill="#059669"
                    radius={[3, 3, 0, 0]}
                  />
                  <Bar
                    dataKey="giorniFerieAssenze"
                    name="Giorni Ferie/Assenze Goduti"
                    fill="#f59e0b"
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* Stored Historical Months Table & Summary */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Archivio Storico Mensile Persistente (localStorage / File System)
          </span>
          <span className="text-[11px] font-mono text-slate-500">
            Target di riferimento: 160h / mese per lavoratrice Fissa
          </span>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 font-semibold text-slate-700">
                <th className="py-2.5 px-3">Periodo Archiviato</th>
                {fissoWorkers.map((w) => (
                  <th key={w.id} className="py-2.5 px-2.5 text-center">
                    {w.name}
                  </th>
                ))}
                <th className="py-2.5 px-3 text-center">Media Fisse</th>
                <th className="py-2.5 px-3 text-right">Azioni</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 font-mono">
              {historyList.length === 0 ? (
                <tr>
                  <td
                    colSpan={fissoWorkers.length + 3}
                    className="py-4 text-center font-sans text-slate-500"
                  >
                    Nessun mese in archivio. Clicca su &quot;Salva Mese Corrente nello Storico&quot;
                    o &quot;Storico Demo&quot;.
                  </td>
                </tr>
              ) : (
                [...historyList]
                  .sort((a, b) =>
                    b.year !== a.year
                      ? b.year - a.year
                      : b.month !== a.month
                      ? b.month - a.month
                      : new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime()
                  )
                  .map((entry) => {
                  const isCurrent =
                    entry.month === config.month && entry.year === config.year;
                  const fisseHours = fissoWorkers.map((w) => {
                    const st = entry.workerStats[w.id];
                    return {
                      hrs: st?.totalHours || 0,
                      abs: st?.absenceDays || 0,
                    };
                  });
                  const avgH =
                    fisseHours.length > 0
                      ? Math.round(
                          (fisseHours.reduce((acc, x) => acc + x.hrs, 0) / fisseHours.length) * 10
                        ) / 10
                      : 0;

                  return (
                    <tr
                      key={entry.id}
                      className={isCurrent ? 'bg-amber-50/50' : 'hover:bg-slate-50'}
                    >
                      <td className="py-2 px-3 font-sans font-bold text-slate-900 whitespace-nowrap">
                        {entry.periodLabel}
                        {isCurrent && (
                          <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-amber-200 text-amber-950 rounded">
                            Mese Attivo
                          </span>
                        )}
                      </td>
                      {fisseHours.map((cell, idx) => (
                        <td key={idx} className="py-2 px-2.5 text-center">
                          <span
                            className={`font-bold ${
                              cell.hrs < 156
                                ? 'text-amber-700'
                                : cell.hrs <= 165
                                ? 'text-emerald-700'
                                : 'text-slate-900'
                            }`}
                          >
                            {cell.hrs}h
                          </span>
                          {cell.abs > 0 && (
                            <span
                              className="block text-[10px] text-amber-600"
                              title="Giorni di ferie/assenza nel mese"
                            >
                              ({cell.abs}g ferie)
                            </span>
                          )}
                        </td>
                      ))}
                      <td className="py-2 px-3 text-center font-bold text-slate-900">{avgH}h</td>
                      <td className="py-2 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleDeleteHistoryEntry(entry.id)}
                          title="Rimuovi mese dallo storico"
                          className="p-1 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
