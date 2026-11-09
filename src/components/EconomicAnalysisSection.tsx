import React, { useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  Euro,
  FileSpreadsheet,
  Calculator,
  PieChart as PieChartIcon,
  BarChart3,
  Percent,
} from 'lucide-react';
import { AppConfig, ScheduleSolution } from '../types';
import { formatPeriodLabel } from '../defaultData';
import { exportScheduleToExcel } from '../services/excelExporter';

interface EconomicAnalysisSectionProps {
  config: AppConfig;
  solution: ScheduleSolution;
  onUpdateWorkerHourlyRate: (workerId: string, newRate: number) => void;
  onApplyBulkHourlyRate?: (roleType: 'ALL' | 'Fisso' | 'Sostituta', rate: number) => void;
  onUpdateWorkerHolidaySurcharge?: (workerId: string, pct: number) => void;
  onApplyBulkHolidaySurcharge?: (pct: number) => void;
}

function formatEuro(val: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

const CATEGORY_COLORS = {
  BAR: '#EAB308',       // Giallo ambra (Bar)
  MORNING: '#DC2626',   // Rosso (Mattina)
  AFTERNOON: '#0F172A', // Nero/Ardesia (Pomeriggio)
  HOLIDAY: '#059669',   // Verde Smeraldo (Maggiorazione Festivi Fisse)
};

const ROLE_COLORS = ['#0F172A', '#64748B'];

export const EconomicAnalysisSection: React.FC<EconomicAnalysisSectionProps> = ({
  config,
  solution,
  onUpdateWorkerHourlyRate,
  onApplyBulkHourlyRate,
  onUpdateWorkerHolidaySurcharge,
  onApplyBulkHolidaySurcharge,
}) => {
  const [bulkRateFisse, setBulkRateFisse] = useState<number>(12.5);
  const [bulkRateSostitute, setBulkRateSostitute] = useState<number>(13.0);
  const [bulkHolidayPctFisse, setBulkHolidayPctFisse] = useState<number>(20);

  const activeWorkers = config.workers
    .filter((w) => w.active)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'Fisso' ? -1 : 1;
      return a.priority - b.priority;
    });

  // Compute detailed cost rows linked strictly to worker numeric ID
  const workerCostRows = activeWorkers.map((w) => {
    const st = solution.workerStats[w.id];
    const rate =
      typeof w.hourlyRate === 'number' && !Number.isNaN(w.hourlyRate) && w.hourlyRate > 0
        ? w.hourlyRate
        : w.type === 'Sostituta'
        ? 13.0
        : 12.5;

    const holidaySurchargePct =
      w.type === 'Fisso'
        ? typeof w.holidaySurchargePct === 'number' && !Number.isNaN(w.holidaySurchargePct)
          ? Math.max(0, Math.min(200, w.holidaySurchargePct))
          : 20
        : 0;

    const barHours = st?.barHours || 0;
    const morningHours = st?.morningHours || 0;
    const afternoonHours = st?.afternoonHours || 0;
    const totalHours = st?.totalHours || 0;
    const holidayHours = st?.holidayHours || 0;

    const barCost = Math.round(barHours * rate * 100) / 100;
    const morningCost = Math.round(morningHours * rate * 100) / 100;
    const afternoonCost = Math.round(afternoonHours * rate * 100) / 100;
    const baseCost = Math.round(totalHours * rate * 100) / 100;
    const holidaySurchargeCost =
      w.type === 'Fisso'
        ? Math.round(holidayHours * rate * (holidaySurchargePct / 100) * 100) / 100
        : 0;
    const totalCost = Math.round((baseCost + holidaySurchargeCost) * 100) / 100;

    return {
      workerId: w.id,
      numericId: w.numericId || Number(w.id),
      name: w.name,
      role: w.type,
      priority: w.priority,
      workedDays: st?.workedDays || 0,
      barCount: st?.barCount || 0,
      morningCount: st?.morningCount || 0,
      afternoonCount: st?.afternoonCount || 0,
      barHours,
      morningHours,
      afternoonHours,
      totalHours,
      holidayHours,
      hourlyRate: rate,
      holidaySurchargePct,
      barCost,
      morningCost,
      afternoonCost,
      holidaySurchargeCost,
      totalCost,
    };
  });

  // Totals by Category & Role
  const totalBarHours = workerCostRows.reduce((acc, r) => acc + r.barHours, 0);
  const totalMorningHours = workerCostRows.reduce((acc, r) => acc + r.morningHours, 0);
  const totalAfternoonHours = workerCostRows.reduce((acc, r) => acc + r.afternoonHours, 0);
  const totalHolidayHours = workerCostRows.reduce((acc, r) => acc + r.holidayHours, 0);
  const grandTotalHours = workerCostRows.reduce((acc, r) => acc + r.totalHours, 0);

  const totalBarCost =
    Math.round(workerCostRows.reduce((acc, r) => acc + r.barCost, 0) * 100) / 100;
  const totalMorningCost =
    Math.round(workerCostRows.reduce((acc, r) => acc + r.morningCost, 0) * 100) / 100;
  const totalAfternoonCost =
    Math.round(workerCostRows.reduce((acc, r) => acc + r.afternoonCost, 0) * 100) / 100;
  const totalHolidaySurchargeCost =
    Math.round(workerCostRows.reduce((acc, r) => acc + r.holidaySurchargeCost, 0) * 100) / 100;
  const grandTotalCost =
    Math.round(workerCostRows.reduce((acc, r) => acc + r.totalCost, 0) * 100) / 100;

  const fisseCost =
    Math.round(
      workerCostRows
        .filter((r) => r.role === 'Fisso')
        .reduce((acc, r) => acc + r.totalCost, 0) * 100
    ) / 100;
  const fisseHours = workerCostRows
    .filter((r) => r.role === 'Fisso')
    .reduce((acc, r) => acc + r.totalHours, 0);

  const sostituteCost =
    Math.round(
      workerCostRows
        .filter((r) => r.role === 'Sostituta')
        .reduce((acc, r) => acc + r.totalCost, 0) * 100
    ) / 100;
  const sostituteHours = workerCostRows
    .filter((r) => r.role === 'Sostituta')
    .reduce((acc, r) => acc + r.totalHours, 0);

  const pct = (part: number) =>
    grandTotalCost > 0 ? Math.round((part / grandTotalCost) * 1000) / 10 : 0;

  const categoryPieData = [
    { name: 'Turno BAR', value: totalBarCost, hours: totalBarHours, color: CATEGORY_COLORS.BAR },
    {
      name: 'Pulizie MATTINA',
      value: totalMorningCost,
      hours: totalMorningHours,
      color: CATEGORY_COLORS.MORNING,
    },
    {
      name: 'Pulizie POMERIGGIO',
      value: totalAfternoonCost,
      hours: totalAfternoonHours,
      color: CATEGORY_COLORS.AFTERNOON,
    },
    ...(totalHolidaySurchargeCost > 0
      ? [
          {
            name: 'Magg. Festivi (Fisse)',
            value: totalHolidaySurchargeCost,
            hours: totalHolidayHours,
            color: CATEGORY_COLORS.HOLIDAY,
          },
        ]
      : []),
  ];

  const rolePieData = [
    { name: 'Personale Fisso', value: fisseCost, hours: fisseHours, color: ROLE_COLORS[0] },
    {
      name: 'Sostitute a Chiamata',
      value: sostituteCost,
      hours: sostituteHours,
      color: ROLE_COLORS[1],
    },
  ];

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <Euro className="w-5 h-5 text-slate-900" />
            <h2 className="text-base font-bold text-slate-900">
              Analisi Economica: Stima Costo Personale, Maggiorazione Festivi Fisse e Categorie
            </h2>
            <span className="text-xs font-mono text-slate-500">
              ({formatPeriodLabel(config)})
            </span>
          </div>
          <p className="text-xs text-slate-600">
            Calcolo dinamico in tempo reale della spesa mensile moltiplicando le ore effettive per
            il costo orario (€/h) e applicando la{' '}
            <strong className="text-emerald-800">Maggiorazione Festivi (%)</strong> alle ore
            lavorate nei giorni festivi dalle lavoratrici <strong className="text-slate-900">Fisse</strong>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {onApplyBulkHourlyRate && (
            <div className="flex flex-wrap items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
              <Calculator className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-xs font-medium text-slate-700">Tariffa Fisse:</span>
              <input
                type="number"
                step="0.25"
                min={5}
                max={50}
                value={bulkRateFisse}
                onChange={(e) => setBulkRateFisse(Number(e.target.value) || 12.5)}
                className="w-16 px-2 py-1 text-xs font-mono font-bold text-right bg-white border border-slate-300 rounded"
              />
              <button
                type="button"
                onClick={() => onApplyBulkHourlyRate('Fisso', bulkRateFisse)}
                className="px-2.5 py-1 text-xs font-semibold text-slate-800 bg-slate-200 hover:bg-slate-300 rounded transition-colors cursor-pointer"
              >
                Applica Fisse
              </button>

              <span className="text-slate-300">|</span>

              <span className="text-xs font-medium text-slate-700">Sostitute:</span>
              <input
                type="number"
                step="0.25"
                min={5}
                max={50}
                value={bulkRateSostitute}
                onChange={(e) => setBulkRateSostitute(Number(e.target.value) || 13.0)}
                className="w-16 px-2 py-1 text-xs font-mono font-bold text-right bg-white border border-slate-300 rounded"
              />
              <button
                type="button"
                onClick={() => onApplyBulkHourlyRate('Sostituta', bulkRateSostitute)}
                className="px-2.5 py-1 text-xs font-semibold text-slate-800 bg-slate-200 hover:bg-slate-300 rounded transition-colors cursor-pointer"
              >
                Applica Sost.
              </button>

              {onApplyBulkHolidaySurcharge && (
                <>
                  <span className="text-slate-300">|</span>
                  <Percent className="w-3.5 h-3.5 text-emerald-700" />
                  <span className="text-xs font-medium text-emerald-900">Magg. Festivi Fisse:</span>
                  <input
                    type="number"
                    step="1"
                    min={0}
                    max={200}
                    value={bulkHolidayPctFisse}
                    onChange={(e) =>
                      setBulkHolidayPctFisse(Math.max(0, Math.min(200, Number(e.target.value) || 0)))
                    }
                    className="w-14 px-2 py-1 text-xs font-mono font-bold text-right text-emerald-900 bg-white border border-emerald-300 rounded"
                  />
                  <span className="text-xs font-mono text-emerald-800">%</span>
                  <button
                    type="button"
                    onClick={() => onApplyBulkHolidaySurcharge(bulkHolidayPctFisse)}
                    className="px-2.5 py-1 text-xs font-semibold text-emerald-900 bg-emerald-100 hover:bg-emerald-200 border border-emerald-300 rounded transition-colors cursor-pointer"
                  >
                    Applica % Festivi
                  </button>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => exportScheduleToExcel(config, solution)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors cursor-pointer whitespace-nowrap"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Esporta Excel con Foglio Costi (.xlsx)
          </button>
        </div>
      </div>

      {/* 5 Analytical Summary Cards by Category & Contract Type */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        {/* Card 1: Grand Total */}
        <div className="p-4 rounded-lg border-2 border-slate-900 bg-slate-900 text-white flex flex-col justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Totale Generale Mese (Incl. Festivi)
          </div>
          <div className="my-2 text-2xl font-mono font-bold tracking-tight">
            {formatEuro(grandTotalCost)}
          </div>
          <div className="text-xs text-slate-300 font-mono flex items-center justify-between border-t border-slate-700 pt-2">
            <span>{grandTotalHours}h totali</span>
            <span className="text-emerald-300">+{formatEuro(totalHolidaySurchargeCost)} fest.</span>
          </div>
        </div>

        {/* Card 2: Quota Turno BAR */}
        <div className="p-4 rounded-lg border border-amber-300 bg-[#FEF08A]/35 flex flex-col justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-900">
            Quota Turno BAR
          </div>
          <div className="my-2 text-xl font-mono font-bold text-slate-950">
            {formatEuro(totalBarCost)}
          </div>
          <div className="text-xs text-slate-700 font-mono flex items-center justify-between border-t border-amber-300/80 pt-2">
            <span>{totalBarHours} ore (6-12/6-13)</span>
            <span className="font-bold">{pct(totalBarCost)}%</span>
          </div>
        </div>

        {/* Card 3: Quota Turno MATTINA */}
        <div className="p-4 rounded-lg border border-red-200 bg-red-50/40 flex flex-col justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-[#DC2626]">
            Quota Pulizie MATTINA
          </div>
          <div className="my-2 text-xl font-mono font-bold text-slate-950">
            {formatEuro(totalMorningCost)}
          </div>
          <div className="text-xs text-slate-700 font-mono flex items-center justify-between border-t border-red-200/80 pt-2">
            <span>{totalMorningHours} ore (7-13/7-14)</span>
            <span className="font-bold text-[#DC2626]">{pct(totalMorningCost)}%</span>
          </div>
        </div>

        {/* Card 4: Quota Turno POMERIGGIO */}
        <div className="p-4 rounded-lg border border-slate-300 bg-slate-50 flex flex-col justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-900">
            Quota Pulizie POMERIGGIO
          </div>
          <div className="my-2 text-xl font-mono font-bold text-slate-950">
            {formatEuro(totalAfternoonCost)}
          </div>
          <div className="text-xs text-slate-700 font-mono flex items-center justify-between border-t border-slate-200 pt-2">
            <span>{totalAfternoonHours} ore (14-20/14-21)</span>
            <span className="font-bold">{pct(totalAfternoonCost)}%</span>
          </div>
        </div>

        {/* Card 5: Ripartizione Fisse vs Sostitute */}
        <div className="p-4 rounded-lg border border-slate-200 bg-white flex flex-col justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-800">
            Fisse vs Sostitute
          </div>
          <div className="my-1.5 space-y-1 text-xs font-mono">
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Fisse ({fisseHours}h):</span>
              <span className="font-bold text-slate-950">{formatEuro(fisseCost)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">Sostitute ({sostituteHours}h):</span>
              <span className="font-bold text-slate-800">{formatEuro(sostituteCost)}</span>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-between border-t border-slate-200 pt-1.5">
            <span>Organico Fisso: {pct(fisseCost)}%</span>
            <span>Chiamata: {pct(sostituteCost)}%</span>
          </div>
        </div>
      </div>

      {/* Charts Grid: BarChart per Dipendente/Turno + DonutChart Ripartizione Categorie */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Left 2 Columns: Stacked BarChart Cost per Worker & Shift Category */}
        <div className="xl:col-span-2 bg-slate-50/70 border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
              <BarChart3 className="w-4 h-4 text-slate-800" />
              <span>
                Confronto Spesa Stimata (€) per Dipendente e Tipologia di Turno (Bar, Mattina,
                Pomeriggio, Magg. Festivi)
              </span>
            </div>
          </div>

          <div className="h-[310px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={workerCostRows}
                margin={{ top: 16, right: 24, left: 8, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fontWeight: 700, fill: '#0f172a' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#475569' }}
                  tickFormatter={(val) => `€${val}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#ffffff',
                    borderColor: '#cbd5e1',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value: unknown, name: unknown) => [
                    formatEuro(Number(value) || 0),
                    String(name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '6px' }} />
                <Bar
                  dataKey="barCost"
                  name="Costo Turno BAR"
                  stackId="a"
                  fill={CATEGORY_COLORS.BAR}
                  maxBarSize={42}
                />
                <Bar
                  dataKey="morningCost"
                  name="Costo Pulizie MATTINA"
                  stackId="a"
                  fill={CATEGORY_COLORS.MORNING}
                  maxBarSize={42}
                />
                <Bar
                  dataKey="afternoonCost"
                  name="Costo Pulizie POMERIGGIO"
                  stackId="a"
                  fill={CATEGORY_COLORS.AFTERNOON}
                  maxBarSize={42}
                />
                <Bar
                  dataKey="holidaySurchargeCost"
                  name="Extra Magg. Festivi (Fisse)"
                  stackId="a"
                  fill={CATEGORY_COLORS.HOLIDAY}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={42}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right Column: DonutChart Breakdown by Department & Contract */}
        <div className="bg-slate-50/70 border border-slate-200 rounded-lg p-4 flex flex-col justify-between space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
            <PieChartIcon className="w-4 h-4 text-slate-800" />
            <span>Ripartizione % Spesa per Mansione (Bar / Mattina / Pomeriggio / Festivi)</span>
          </div>

          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryPieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={82}
                  paddingAngle={3}
                >
                  {categoryPieData.map((entry, idx) => (
                    <Cell key={`cat-cell-${idx}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: unknown, name: unknown) => [
                    formatEuro(Number(value) || 0),
                    String(name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="border-t border-slate-200 pt-2.5 space-y-1.5 text-xs">
            {rolePieData.map((r) => (
              <div key={r.name} className="flex items-center justify-between font-mono">
                <span className="font-sans font-medium text-slate-700">{r.name}:</span>
                <span className="font-bold text-slate-900">
                  {formatEuro(r.value)} ({pct(r.value)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Detailed Summary Table with Editable Hourly Rate, Holiday Surcharge & Grand Total Row */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-800">
            Prospetto Analitico Costo Personale per Lavoratrice (Tariffa Base + Maggiorazione Festivi Fisse)
          </span>
          <span className="text-xs text-slate-500">
            Puoi modificare <strong>Tariffa Oraria (€/h)</strong> e{' '}
            <strong>Magg. Festivi (%) per le Fisse</strong> direttamente nella tabella
          </span>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 font-semibold text-slate-700">
                <th className="py-3 px-2.5 text-center">ID #</th>
                <th className="py-3 px-3">Dipendente</th>
                <th className="py-3 px-2.5">Ruolo / Priorità</th>
                <th className="py-3 px-2.5 text-center">Ore BAR</th>
                <th className="py-3 px-2.5 text-center">Ore MATT.</th>
                <th className="py-3 px-2.5 text-center">Ore POM.</th>
                <th className="py-3 px-2.5 text-center">Ore Totali</th>
                <th className="py-3 px-2.5 text-center text-emerald-900 bg-emerald-50/60">
                  Ore Festivi
                </th>
                <th className="py-3 px-3 text-right">Tariffa (€/h)</th>
                <th className="py-3 px-3 text-right text-emerald-900 bg-emerald-50/60">
                  Magg. Festivi (%)
                </th>
                <th className="py-3 px-2.5 text-right">Quota BAR</th>
                <th className="py-3 px-2.5 text-right">Quota MATT.</th>
                <th className="py-3 px-2.5 text-right">Quota POM.</th>
                <th className="py-3 px-2.5 text-right text-emerald-900 bg-emerald-50/60">
                  Extra Festivi (€)
                </th>
                <th className="py-3 px-3.5 text-right">Costo Totale (€)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 font-mono">
              {workerCostRows.map((row) => (
                <tr key={row.workerId} className="hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 px-2.5 text-center font-bold text-slate-500">
                    #{row.workerId}
                  </td>
                  <td className="py-2.5 px-3 font-sans font-bold text-slate-900">
                    {row.name}
                  </td>
                  <td className="py-2.5 px-2.5 font-sans text-slate-700">
                    {row.role === 'Fisso'
                      ? 'Fisso (Organico)'
                      : row.priority === 5
                      ? 'Sostituta (P5 Esclusa)'
                      : `Sostituta (P${row.priority})`}
                  </td>
                  <td className="py-2.5 px-2.5 text-center text-slate-800">
                    {row.barHours > 0 ? `${row.barHours}h` : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-center text-[#DC2626] font-semibold">
                    {row.morningHours > 0 ? `${row.morningHours}h` : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-center text-slate-900 font-bold">
                    {row.afternoonHours > 0 ? `${row.afternoonHours}h` : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-center font-bold text-slate-950 bg-slate-50/70">
                    {row.totalHours}h
                  </td>
                  <td className="py-2.5 px-2.5 text-center font-bold text-emerald-800 bg-emerald-50/40">
                    {row.holidayHours > 0 ? `${row.holidayHours}h` : '0h'}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <input
                        type="number"
                        step="0.25"
                        min={1}
                        max={100}
                        value={row.hourlyRate}
                        onChange={(e) =>
                          onUpdateWorkerHourlyRate(
                            row.workerId,
                            Math.max(1, Number(e.target.value) || 12.5)
                          )
                        }
                        className="w-18 px-2 py-1 text-right font-mono text-xs font-bold text-slate-900 bg-white border border-slate-300 rounded focus:outline-none focus:border-slate-900"
                      />
                      <span className="text-slate-500">€/h</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right bg-emerald-50/40">
                    {row.role === 'Fisso' ? (
                      <div className="inline-flex items-center gap-1">
                        <span className="text-emerald-700 font-bold">+</span>
                        <input
                          type="number"
                          step="1"
                          min={0}
                          max={200}
                          value={row.holidaySurchargePct}
                          onChange={(e) =>
                            onUpdateWorkerHolidaySurcharge?.(
                              row.workerId,
                              Math.max(0, Math.min(200, Number(e.target.value) || 0))
                            )
                          }
                          className="w-14 px-1.5 py-1 text-right font-mono text-xs font-bold text-emerald-900 bg-white border border-emerald-300 rounded focus:outline-none focus:border-emerald-700"
                        />
                        <span className="text-emerald-700 font-bold">%</span>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400 font-sans">Solo Fisse</span>
                    )}
                  </td>
                  <td className="py-2.5 px-2.5 text-right text-slate-700">
                    {row.barCost > 0 ? formatEuro(row.barCost) : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-right text-slate-700">
                    {row.morningCost > 0 ? formatEuro(row.morningCost) : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-right text-slate-700">
                    {row.afternoonCost > 0 ? formatEuro(row.afternoonCost) : '—'}
                  </td>
                  <td className="py-2.5 px-2.5 text-right font-bold text-emerald-800 bg-emerald-50/40">
                    {row.holidaySurchargeCost > 0
                      ? `+${formatEuro(row.holidaySurchargeCost)}`
                      : '—'}
                  </td>
                  <td className="py-2.5 px-3.5 text-right font-bold text-slate-950 bg-slate-50/70 text-sm">
                    {formatEuro(row.totalCost)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-900 text-white font-mono text-xs font-bold">
              <tr>
                <td colSpan={3} className="py-3 px-3 font-sans uppercase tracking-wider">
                  Totale Generale ({formatPeriodLabel(config)})
                </td>
                <td className="py-3 px-2.5 text-center text-amber-300">{totalBarHours}h</td>
                <td className="py-3 px-2.5 text-center text-red-300">{totalMorningHours}h</td>
                <td className="py-3 px-2.5 text-center text-slate-200">{totalAfternoonHours}h</td>
                <td className="py-3 px-2.5 text-center text-base">{grandTotalHours}h</td>
                <td className="py-3 px-2.5 text-center text-emerald-300">{totalHolidayHours}h</td>
                <td colSpan={2} className="py-3 px-3 text-right text-slate-300">
                  Media:{' '}
                  {grandTotalHours > 0
                    ? formatEuro(Math.round((grandTotalCost / grandTotalHours) * 100) / 100)
                    : '—'}
                  /h
                </td>
                <td className="py-3 px-2.5 text-right text-amber-300">
                  {formatEuro(totalBarCost)}
                </td>
                <td className="py-3 px-2.5 text-right text-red-300">
                  {formatEuro(totalMorningCost)}
                </td>
                <td className="py-3 px-2.5 text-right text-slate-200">
                  {formatEuro(totalAfternoonCost)}
                </td>
                <td className="py-3 px-2.5 text-right text-emerald-300">
                  +{formatEuro(totalHolidaySurchargeCost)}
                </td>
                <td className="py-3 px-3.5 text-right text-base text-emerald-300">
                  {formatEuro(grandTotalCost)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
};
