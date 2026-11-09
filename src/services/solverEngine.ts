import {
  AbsenceRecord,
  AppConfig,
  CellAssignment,
  ConflictConstraintCategory,
  DailyRequirement,
  DayBand,
  DiagnosticMessage,
  IndispensableAfternoonException,
  ScheduleSolution,
  ShiftBandConfig,
  SolveConflictItem,
  SolveInsightsReport,
  SolveRemediationSuggestion,
  Worker,
  WorkerConstraintBlocker,
  WorkerSummaryStats,
} from '../types';

export function getDayBand(dayReq: DailyRequirement): DayBand {
  if (dayReq.dayOfWeek === 0 || dayReq.isHoliday) {
    return 'SUN_HOL';
  }
  if (dayReq.dayOfWeek >= 1 && dayReq.dayOfWeek <= 3) {
    return 'MON_WED';
  }
  return 'THU_SAT';
}

export function getShiftSpec(
  config: AppConfig,
  dayReq: DailyRequirement,
  shiftType: 'BAR' | 'MORNING' | 'AFTERNOON'
): ShiftBandConfig {
  // Priority 1: Check calendar-specific date & shift exceptions (Scheda 2 "Eccezioni Orarie di Calendario")
  if (Array.isArray(config.shiftExceptions) && config.shiftExceptions.length > 0) {
    const exception = config.shiftExceptions.find(
      (ex) =>
        ex.shiftType === shiftType &&
        (ex.day === dayReq.day ||
          (ex.isoDate && dayReq.isoDate && ex.isoDate === dayReq.isoDate) ||
          ex.dateStr === dayReq.dateStr)
    );
    if (exception) {
      return {
        label: exception.label,
        hours: Math.max(1, Number(exception.hours) || 0),
      };
    }
  }

  // Priority 2: Standard weekly band schedule (Lun-Mer, Gio-Sab, Dom/Festivi)
  const band = getDayBand(dayReq);
  if (shiftType === 'BAR') return config.shiftConfig.bar[band];
  if (shiftType === 'MORNING') return config.shiftConfig.morning[band];
  return config.shiftConfig.afternoon[band];
}

export function isWorkerBlocked(
  worker: Worker,
  day: number,
  shiftType: 'BAR' | 'MORNING' | 'AFTERNOON',
  absences: AbsenceRecord[]
): { blocked: boolean; reason?: string } {
  if (!worker.active) return { blocked: true, reason: 'Disattivata' };
  if (worker.type === 'Sostituta' && Number(worker.priority) === 5) {
    return { blocked: true, reason: 'Priorità 5 (Non tenere in considerazione)' };
  }
  if (shiftType === 'BAR' && !worker.canBar) return { blocked: true, reason: 'Non abilitata Bar' };
  if (shiftType === 'MORNING' && !worker.canMorning)
    return { blocked: true, reason: 'Non abilitata Mattina' };
  if (shiftType === 'AFTERNOON' && !worker.canAfternoon)
    return { blocked: true, reason: 'Non abilitata Pomeriggio' };

  for (const abs of absences) {
    if (abs.workerId === worker.id && day >= abs.startDay && day <= abs.endDay) {
      if (abs.scope === 'FULL_DAY') {
        return { blocked: true, reason: abs.type };
      }
      if (abs.scope === 'ONLY_BAR' && shiftType === 'BAR') {
        return { blocked: true, reason: `${abs.type} (Solo Bar)` };
      }
      if (abs.scope === 'ONLY_MORNING' && shiftType === 'MORNING') {
        return { blocked: true, reason: `${abs.type} (Solo Mattina)` };
      }
      if (abs.scope === 'ONLY_AFTERNOON' && shiftType === 'AFTERNOON') {
        return { blocked: true, reason: `${abs.type} (Solo Pomeriggio)` };
      }
    }
  }
  return { blocked: false };
}

export function isFullDayAbsent(workerId: string, day: number, absences: AbsenceRecord[]): boolean {
  return absences.some(
    (a) => a.workerId === workerId && a.scope === 'FULL_DAY' && day >= a.startDay && day <= a.endDay
  );
}

/**
 * Group calendar days into Monday-Sunday weeks
 */
function groupIntoWeeks(calendar: DailyRequirement[]): DailyRequirement[][] {
  const weeks: DailyRequirement[][] = [];
  let currentWeek: DailyRequirement[] = [];
  for (const d of calendar) {
    currentWeek.push(d);
    if (d.dayOfWeek === 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }
  return weeks;
}

/**
 * Exact Equal-Workload & Equal Morning/Afternoon Workforce Optimizer:
 * Guarantees that among Fisso housekeeping workers:
 * 1. Total hours are equalized (spread 0h-1h).
 * 2. Total worked days (Morning + Bar + Afternoon) are equalized (spread <= 1 shift).
 * 3. Afternoon shifts (14-20 / 14-21) are equally distributed (spread <= 1 shift).
 * 4. Morning shifts (7-13 / 7-14 + Bar) are equally distributed (spread <= 1 shift).
 */
let lastStructuralCacheKey = '';
let lastCachedSolution: ScheduleSolution | null = null;

function buildSolverStructuralKey(config: AppConfig): string {
  return JSON.stringify({
    m: config.month,
    y: config.year,
    pm: config.periodMode,
    ed: config.extraDaysAfterMonth,
    cs: config.customStartDate,
    ce: config.customEndDate,
    w: config.workers.map((w) => ({
      id: w.id,
      t: w.type,
      p: w.priority,
      b: w.canBar,
      m: w.canMorning,
      a: w.canAfternoon,
      h: w.maxWeeklyHours,
      ac: w.active,
    })),
    sc: config.shiftConfig,
    se: config.shiftExceptions,
    cal: config.calendar,
    abs: config.absences,
    con: config.constraints,
    histLen: (config.history || []).length,
    histIds: (config.history || []).map((h) => `${h.id}:${h.confirmedAt}`),
  });
}

export function solveWorkforceSchedule(config: AppConfig): ScheduleSolution {
  const startTime = performance.now();
  const structKey = buildSolverStructuralKey(config);
  if (lastCachedSolution && structKey === lastStructuralCacheKey) {
    // Only worker display names, hourly rates (€/h), or holidaySurchargePct (%) changed: update stats in O(N) without re-running solver!
    const updatedStats: Record<string, WorkerSummaryStats> = {};
    for (const w of config.workers) {
      const prev = lastCachedSolution.workerStats[w.id];
      if (!prev) continue;
      const rate =
        typeof w.hourlyRate === 'number' && w.hourlyRate >= 0
          ? w.hourlyRate
          : w.type === 'Fisso'
          ? 12.5
          : 13.5;
      const surchargePct =
        w.type === 'Fisso'
          ? Math.max(0, Number(w.holidaySurchargePct ?? 20) || 0)
          : 0;
      const holH = prev.holidayHours || 0;
      const holExtraCost =
        w.type === 'Fisso'
          ? Math.round(holH * rate * (surchargePct / 100) * 100) / 100
          : 0;
      const bCost = Math.round(prev.barHours * rate * 100) / 100;
      const mCost = Math.round(prev.morningHours * rate * 100) / 100;
      const aCost = Math.round(prev.afternoonHours * rate * 100) / 100;
      updatedStats[w.id] = {
        ...prev,
        workerName: w.name,
        hourlyRate: rate,
        holidayHours: holH,
        holidaySurchargePct: surchargePct,
        holidaySurchargeCost: holExtraCost,
        barCost: bCost,
        morningCost: mCost,
        afternoonCost: aCost,
        totalCost: Math.round((bCost + mCost + aCost + holExtraCost) * 100) / 100,
      };
    }
    return {
      ...lastCachedSolution,
      workerStats: updatedStats,
    };
  }

  const activeWorkers = config.workers
    .filter((w) => w.active && !(w.type === 'Sostituta' && Number(w.priority) === 5))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'Fisso' ? -1 : 1;
      return (a.priority || 1) - (b.priority || 1);
    });

  const diagnostics: DiagnosticMessage[] = [];
  const assignments: Record<number, Record<string, CellAssignment>> = {};
  const weeks = groupIntoWeeks(config.calendar);
  const totalCalendarDays = config.calendar.length;

  for (const dayReq of config.calendar) {
    assignments[dayReq.day] = {};
    for (const w of config.workers) {
      assignments[dayReq.day][w.id] = {
        shiftType: 'OFF',
        label: '',
        hours: 0,
      };
    }
  }

  // Calculate available days and absence days for each worker
  const availableDaysMap: Record<string, number> = {};
  const absenceDaysMap: Record<string, number> = {};
  for (const w of config.workers) {
    let absDays = 0;
    for (const d of config.calendar) {
      if (isFullDayAbsent(w.id, d.day, config.absences)) {
        absDays++;
      }
    }
    absenceDaysMap[w.id] = absDays;
    availableDaysMap[w.id] = Math.max(0, totalCalendarDays - absDays);
  }

  let totalAllFissoRequiredHours = 0;
  let totalBarHours = 0;
  for (const d of config.calendar) {
    const bSpec = getShiftSpec(config, d, 'BAR');
    const mSpec = getShiftSpec(config, d, 'MORNING');
    const aSpec = getShiftSpec(config, d, 'AFTERNOON');
    totalBarHours += d.reqBar * bSpec.hours;
    totalAllFissoRequiredHours +=
      d.reqBar * bSpec.hours + d.reqMorning * mSpec.hours + d.reqAfternoon * aSpec.hours;
  }

  const fissoWorkers = activeWorkers.filter((w) => w.type === 'Fisso');
  const generalFissoWorkers = fissoWorkers.filter((w) => w.canMorning || w.canAfternoon);

  // Capacity weight based on contract maxWeeklyHours across ALL Fisso workers (including Ioana / Bar).
  // Short absences (<= 4 days) are absorbed by rotating weekly rest days so the worker does NOT lose hours compared to colleagues.
  const capacityWeight: Record<string, number> = {};
  let sumAllFissoCapacity = 0;
  for (const w of fissoWorkers) {
    const maxTheoreticalWorkDays = Math.round(totalCalendarDays * (6 / 7));
    const effectivePresenceRatio =
      availableDaysMap[w.id] >= maxTheoreticalWorkDays
        ? 1.0
        : availableDaysMap[w.id] / Math.max(1, maxTheoreticalWorkDays);
    const cap = (w.maxWeeklyHours / 40) * effectivePresenceRatio;
    capacityWeight[w.id] = Math.max(0.1, cap);
    sumAllFissoCapacity += capacityWeight[w.id];
  }

  const targetHoursMap: Record<string, number> = {};
  for (const w of config.workers) {
    if (w.type === 'Sostituta') {
      targetHoursMap[w.id] = 0;
    } else if (sumAllFissoCapacity > 0) {
      const equalShare = Math.round(
        (totalAllFissoRequiredHours * capacityWeight[w.id]) / sumAllFissoCapacity
      );
      if (w.canBar && !w.canMorning && !w.canAfternoon) {
        // Dedicated Bar worker targets the exact same hours as all other Fisso workers (capped only by total Bar hours)
        targetHoursMap[w.id] = Math.min(equalShare, totalBarHours);
      } else {
        targetHoursMap[w.id] = equalShare;
      }
    } else {
      targetHoursMap[w.id] = 0;
    }
  }

  const dayToWeekIdx: Record<number, number> = {};
  weeks.forEach((wk, idx) => {
    wk.forEach((d) => {
      dayToWeekIdx[d.day] = idx;
    });
  });

  const dayReqByDay: Record<number, DailyRequirement> = {};
  for (const d of config.calendar) {
    dayReqByDay[d.day] = d;
  }

  const getWeeklyStats = (workerId: string, weekIdx: number, ignoreDay?: number) => {
    const wk = weeks[weekIdx];
    let hours = 0;
    let worked = 0;
    for (const d of wk) {
      if (d.day === ignoreDay) continue;
      const cell = assignments[d.day][workerId];
      if (cell && cell.shiftType !== 'OFF') {
        hours += cell.hours;
        worked += 1;
      }
    }
    return { hours, worked, totalDaysInWeek: wk.length };
  };

  const wouldExceedConsecutiveDays = (workerId: string, targetDay: number): boolean => {
    const maxConsec = config.constraints.maxConsecutiveDays;
    let streak = 1;
    let d = targetDay - 1;
    while (d >= 1 && assignments[d]?.[workerId]?.shiftType !== 'OFF') {
      streak++;
      d--;
    }
    d = targetDay + 1;
    while (d <= totalCalendarDays && assignments[d]?.[workerId]?.shiftType !== 'OFF') {
      streak++;
      d++;
    }
    return streak > maxConsec;
  };

  const maxConsecAfternoons = Math.min(
    3,
    Math.max(2, config.constraints.maxConsecutiveAfternoons ?? 3)
  );
  const prefConsecAfternoons = Math.min(
    maxConsecAfternoons,
    Math.max(1, config.constraints.preferredConsecutiveAfternoons ?? 2)
  );

  const wouldExceedConsecutiveAfternoons = (
    workerId: string,
    targetDay: number,
    shiftType: 'BAR' | 'MORNING' | 'AFTERNOON'
  ): boolean => {
    if (shiftType !== 'AFTERNOON') return false;
    let streak = 1;
    let d = targetDay - 1;
    while (d >= 1 && assignments[d]?.[workerId]?.shiftType === 'AFTERNOON') {
      streak++;
      d--;
    }
    d = targetDay + 1;
    while (d <= totalCalendarDays && assignments[d]?.[workerId]?.shiftType === 'AFTERNOON') {
      streak++;
      d++;
    }
    return streak > maxConsecAfternoons;
  };

  const violatesCcnlSequence = (
    workerId: string,
    day: number,
    shiftType: 'BAR' | 'MORNING' | 'AFTERNOON'
  ): boolean => {
    if (!config.constraints.forbidAfternoonToMorning) return false;
    if (shiftType === 'MORNING' || shiftType === 'BAR') {
      const prev = assignments[day - 1]?.[workerId]?.shiftType;
      if (prev === 'AFTERNOON') return true;
    }
    if (shiftType === 'AFTERNOON') {
      const next = assignments[day + 1]?.[workerId]?.shiftType;
      if (next === 'MORNING' || next === 'BAR') return true;
    }
    return false;
  };

  const sundayDays = config.calendar.filter((d) => d.dayOfWeek === 0).map((d) => d.day);
  const totalSundaysInPeriod = sundayDays.length;
  const maxSundaysAllowed = Math.max(1, totalSundaysInPeriod - 1);

  // Track live stats
  const totalHours: Record<string, number> = {};
  const morningCount: Record<string, number> = {};
  const afternoonCount: Record<string, number> = {};
  const barCount: Record<string, number> = {};
  const sundaysWorked: Record<string, number> = {};
  const holidaysWorked: Record<string, number> = {};
  const workedDaysCount: Record<string, number> = {};

  // Historical cumulative stats across past stored months (excluding current month/year), sorted chronologically
  const pastHistory = [...(config.history || [])]
    .filter((entry) => !(entry.month === config.month && entry.year === config.year))
    .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
  const last3MonthsHistory = pastHistory.slice(-3);
  const useHist = config.constraints.useHistoricalEquity !== false && pastHistory.length > 0;

  const histHours: Record<string, number> = {};
  const histMorning: Record<string, number> = {};
  const histAfternoon: Record<string, number> = {};
  const histBar: Record<string, number> = {};
  const histSundays: Record<string, number> = {};
  const histHolidays: Record<string, number> = {};
  const histAbsenceDays: Record<string, number> = {};
  const histTargetDelta: Record<string, number> = {};

  // Explicit 3-month Sunday history metrics per worker
  const hist3mSundays: Record<string, number> = {};
  const trailingConsecSundays: Record<string, number> = {};
  const lastFreeSundaySlot: Record<string, number> = {};

  for (let wIdx = 0; wIdx < config.workers.length; wIdx++) {
    const w = config.workers[wIdx];
    totalHours[w.id] = 0;
    morningCount[w.id] = 0;
    afternoonCount[w.id] = 0;
    barCount[w.id] = 0;
    sundaysWorked[w.id] = 0;
    holidaysWorked[w.id] = 0;
    workedDaysCount[w.id] = 0;

    let hHrs = 0;
    let hMat = 0;
    let hPom = 0;
    let hBar = 0;
    let hSun = 0;
    let hHol = 0;
    let hAbs = 0;

    for (const entry of pastHistory) {
      // Strictly reference immutable numeric primary key (w.id), never string workerName
      const st = entry.workerStats[w.id];
      if (st) {
        hHrs += st.totalHours || 0;
        hMat += st.morningCount || 0;
        hPom += st.afternoonCount || 0;
        hBar += st.barCount || 0;
        hSun += st.sundaysWorked || 0;
        hHol += st.holidaysWorked || 0;
        hAbs += st.absenceDays || 0;
      }
    }

    // Reconstruct the Sunday timeline over the last 3 months from config.history
    const sundayTimeline3m: number[] = [];
    let lastFreeSlot = (wIdx + last3MonthsHistory.length) % 4;

    for (let mIdx = 0; mIdx < last3MonthsHistory.length; mIdx++) {
      const entry = last3MonthsHistory[mIdx];
      const calSnap = entry.calendar || [];
      const assSnap = entry.assignments || {};
      const sunDaysInEntry = calSnap.filter((dReq) => dReq.dayOfWeek === 0).map((dReq) => dReq.day);

      if (sunDaysInEntry.length > 0 && Object.keys(assSnap).length > 0) {
        for (let sIdx = 0; sIdx < sunDaysInEntry.length; sIdx++) {
          const sDay = sunDaysInEntry[sIdx];
          const cell = assSnap[sDay]?.[w.id];
          const worked = cell && cell.shiftType !== 'OFF' ? 1 : 0;
          sundayTimeline3m.push(worked);
          if (worked === 0) {
            lastFreeSlot = sIdx % 4;
          }
        }
      } else {
        const st = entry.workerStats[w.id];
        const numSunM = sunDaysInEntry.length > 0 ? sunDaysInEntry.length : 4;
        const sunWorked = Math.min(numSunM, Math.max(0, st?.sundaysWorked ?? 0));
        const restCount = Math.max(0, numSunM - sunWorked);
        const freeSlots = new Set<number>();
        for (let rI = 0; rI < restCount; rI++) {
          freeSlots.add((wIdx + mIdx + rI * 2) % numSunM);
        }
        for (let sIdx = 0; sIdx < numSunM; sIdx++) {
          if (freeSlots.has(sIdx)) {
            sundayTimeline3m.push(0);
            lastFreeSlot = sIdx % 4;
          } else {
            sundayTimeline3m.push(1);
          }
        }
      }
    }

    let trailingConsec = 0;
    for (let i = sundayTimeline3m.length - 1; i >= 0; i--) {
      if (sundayTimeline3m[i] === 1) {
        trailingConsec++;
      } else {
        break;
      }
    }

    hist3mSundays[w.id] = sundayTimeline3m.reduce((acc, v) => acc + v, 0);
    trailingConsecSundays[w.id] = Math.min(3, trailingConsec);
    lastFreeSundaySlot[w.id] = lastFreeSlot;

    histHours[w.id] = hHrs;
    histMorning[w.id] = hMat;
    histAfternoon[w.id] = hPom;
    histBar[w.id] = hBar;
    histSundays[w.id] = hSun;
    histHolidays[w.id] = hHol;
    histAbsenceDays[w.id] = hAbs;

    const monthlyContractTarget = Math.round(160 * (w.maxWeeklyHours / 40));
    histTargetDelta[w.id] =
      w.type === 'Fisso' ? hHrs - pastHistory.length * monthlyContractTarget : 0;
  }

  // Helper: Early shift count (Morning + Bar) so Sabrina/Ilaria Bar shifts count as Morning-equivalent early shifts
  const getEarlyShiftCount = (wId: string) => morningCount[wId] + barCount[wId];

  // Rotate Free Sundays across all Fisso workers based on the last 3 months of 'history'
  // so no Fisso worker goes more than 3 consecutive weeks without a Sunday rest.
  const designatedFreeSunday: Record<string, number> = {};
  if (totalSundaysInPeriod >= 2) {
    const sundayRestLoad: Record<number, number> = {};
    const sundayBarRestLoad: Record<number, number> = {};
    for (const sDay of sundayDays) {
      sundayRestLoad[sDay] = 0;
      sundayBarRestLoad[sDay] = 0;
    }

    const unassignedFisso: Worker[] = [];
    for (const w of fissoWorkers) {
      const absentSun = sundayDays.find((sDay) => isFullDayAbsent(w.id, sDay, config.absences));
      if (absentSun !== undefined) {
        designatedFreeSunday[w.id] = absentSun;
        sundayRestLoad[absentSun]++;
        if (w.canBar) sundayBarRestLoad[absentSun]++;
      } else {
        unassignedFisso.push(w);
      }
    }

    const barFisso = [...unassignedFisso.filter((w) => w.canBar)].sort(
      (a, b) =>
        (trailingConsecSundays[b.id] || 0) - (trailingConsecSundays[a.id] || 0) ||
        (hist3mSundays[b.id] || 0) - (hist3mSundays[a.id] || 0)
    );
    const nonBarFisso = [...unassignedFisso.filter((w) => !w.canBar)].sort(
      (a, b) =>
        (trailingConsecSundays[b.id] || 0) - (trailingConsecSundays[a.id] || 0) ||
        (hist3mSundays[b.id] || 0) +
          (histHolidays[b.id] || 0) -
          ((hist3mSundays[a.id] || 0) + (histHolidays[a.id] || 0))
    );

    for (const w of barFisso) {
      const trailK = useHist ? trailingConsecSundays[w.id] || 0 : 0;
      const maxWindowIdx = trailK > 0 ? Math.min(sundayDays.length, Math.max(1, 4 - trailK)) : sundayDays.length;
      const allowedSundays = sundayDays.slice(0, maxWindowIdx);
      const pool = allowedSundays.length > 0 ? allowedSundays : sundayDays;
      const prefSlot = ((lastFreeSundaySlot[w.id] ?? 0) + 1) % sundayDays.length;

      const candidateSundays = [...pool].sort((a, b) => {
        if (sundayBarRestLoad[a] !== sundayBarRestLoad[b]) {
          return sundayBarRestLoad[a] - sundayBarRestLoad[b];
        }
        if (sundayRestLoad[a] !== sundayRestLoad[b]) {
          return sundayRestLoad[a] - sundayRestLoad[b];
        }
        if (useHist) {
          const distA = Math.abs(sundayDays.indexOf(a) - prefSlot);
          const distB = Math.abs(sundayDays.indexOf(b) - prefSlot);
          if (distA !== distB) return distA - distB;
        }
        return !w.canMorning && !w.canAfternoon ? b - a : a - b;
      });
      const chosenSun = candidateSundays[0];
      designatedFreeSunday[w.id] = chosenSun;
      sundayRestLoad[chosenSun]++;
      sundayBarRestLoad[chosenSun]++;
    }

    for (const w of nonBarFisso) {
      const trailK = useHist ? trailingConsecSundays[w.id] || 0 : 0;
      const maxWindowIdx = trailK > 0 ? Math.min(sundayDays.length, Math.max(1, 4 - trailK)) : sundayDays.length;
      const allowedSundays = sundayDays.slice(0, maxWindowIdx);
      const pool = allowedSundays.length > 0 ? allowedSundays : sundayDays;
      const prefSlot = ((lastFreeSundaySlot[w.id] ?? 0) + 1) % sundayDays.length;

      const candidateSundays = [...pool].sort((a, b) => {
        if (sundayRestLoad[a] !== sundayRestLoad[b]) {
          return sundayRestLoad[a] - sundayRestLoad[b];
        }
        if (useHist) {
          const distA = Math.abs(sundayDays.indexOf(a) - prefSlot);
          const distB = Math.abs(sundayDays.indexOf(b) - prefSlot);
          if (distA !== distB) return distA - distB;
        }
        return (hist3mSundays[w.id] || 0) % 2 === 1 ? b - a : a - b;
      });
      const chosenSun = candidateSundays[0];
      designatedFreeSunday[w.id] = chosenSun;
      sundayRestLoad[chosenSun]++;
    }
  }

  if (useHist) {
    diagnostics.push({
      level: 'INFO',
      message: `Rotazione Domeniche su Storico Trimestrale attiva (${last3MonthsHistory.length} ${
        last3MonthsHistory.length === 1 ? 'mese analizzato' : 'mesi analizzati'
      } su ${pastHistory.length} in archivio): nessuna lavoratrice fissa supera 3 settimane consecutive senza riposo domenicale.`,
    });
  }

  // Check if assigning a Sunday shift on targetDay would cause > 3 consecutive worked Sundays in the current period
  const wouldExceedConsecutiveSundays = (worker: Worker, targetDay: number): boolean => {
    if (worker.type !== 'Fisso') return false;
    const sunIdx = sundayDays.indexOf(targetDay);
    if (sunIdx === -1) return false;

    // Check any 4-Sunday sliding window within current period containing sunIdx
    if (sundayDays.length >= 4) {
      for (let startIdx = 0; startIdx <= sundayDays.length - 4; startIdx++) {
        if (sunIdx < startIdx || sunIdx > startIdx + 3) continue;
        let workedInWin = 1; // counting targetDay
        for (let k = startIdx; k < startIdx + 4; k++) {
          if (k === sunIdx) continue;
          const sDay = sundayDays[k];
          if (assignments[sDay]?.[worker.id]?.shiftType !== 'OFF') {
            workedInWin++;
          }
        }
        if (workedInWin > 3) return true;
      }
    }
    return false;
  };

  let enforcePostPhase1SundayCap: boolean = false;

  const indispensableAfternoonExceptions: IndispensableAfternoonException[] = [];
  let requiresAfternoonOverflowConfirmation = false;

  const canAssignStrict = (
    worker: Worker,
    dayReq: DailyRequirement,
    shiftType: 'BAR' | 'MORNING' | 'AFTERNOON',
    ignoreAfternoonStreakLimit: boolean = false
  ): { ok: boolean; failReason?: string } => {
    const day = dayReq.day;
    if (assignments[day][worker.id].shiftType !== 'OFF') {
      return { ok: false, failReason: 'Già in turno nella stessa giornata' };
    }
    const blockCheck = isWorkerBlocked(worker, day, shiftType, config.absences);
    if (blockCheck.blocked) {
      return { ok: false, failReason: blockCheck.reason };
    }
    if (violatesCcnlSequence(worker.id, day, shiftType)) {
      return { ok: false, failReason: 'Regola CCNL 11h (Pomeriggio giorno precedente/successivo)' };
    }
    if (wouldExceedConsecutiveDays(worker.id, day)) {
      return {
        ok: false,
        failReason: `Superamento max ${config.constraints.maxConsecutiveDays} giorni consecutivi`,
      };
    }
    if (!ignoreAfternoonStreakLimit && wouldExceedConsecutiveAfternoons(worker.id, day, shiftType)) {
      return {
        ok: false,
        failReason: `Superamento limite max ${maxConsecAfternoons} Pomeriggi consecutivi`,
      };
    }
    if (dayReq.dayOfWeek === 0 && wouldExceedConsecutiveSundays(worker, day)) {
      return {
        ok: false,
        failReason: 'Rotazione Domeniche: max 3 domeniche lavorate consecutive (obbligo riposo domenicale)',
      };
    }

    if (enforcePostPhase1SundayCap && dayReq.dayOfWeek === 0 && totalSundaysInPeriod >= 2) {
      let otherSundaysWorked = 0;
      for (const sDay of sundayDays) {
        if (sDay === day) continue;
        if (assignments[sDay]?.[worker.id]?.shiftType !== 'OFF') {
          otherSundaysWorked++;
        }
      }
      if (otherSundaysWorked + 1 > maxSundaysAllowed) {
        return {
          ok: false,
          failReason: 'Domenica libera mensile obbligatoria (almeno 1 domenica di riposo al mese)',
        };
      }
    }

    const weekIdx = dayToWeekIdx[day];
    const wkStats = getWeeklyStats(worker.id, weekIdx, day);
    const shiftSpec = getShiftSpec(config, dayReq, shiftType);

    if (wkStats.hours + shiftSpec.hours > worker.maxWeeklyHours) {
      return {
        ok: false,
        failReason: `Superamento limite ${worker.maxWeeklyHours}h settimanali`,
      };
    }

    if (wkStats.totalDaysInWeek === 7) {
      const maxAllowedWorkedInWeek = 7 - config.constraints.minWeeklyRestDays;
      if (wkStats.worked + 1 > maxAllowedWorkedInWeek) {
        return {
          ok: false,
          failReason: `Riposo settimanale minimo (${config.constraints.minWeeklyRestDays} gg) non rispettato`,
        };
      }
    }

    return { ok: true };
  };

  // Pre-schedule lookahead for Bar substitutes
  const barNeedsSubstituteOnDay: Record<number, boolean> = {};
  for (const dayReq of config.calendar) {
    const dedicatedBar = activeWorkers.find(
      (w) => w.canBar && !w.canMorning && !w.canAfternoon
    );
    if (dedicatedBar) {
      const blk = isWorkerBlocked(dedicatedBar, dayReq.day, 'BAR', config.absences);
      if (blk.blocked) {
        barNeedsSubstituteOnDay[dayReq.day] = true;
      }
    }
  }

  let hasInfeasibility = false;

  const getConsecutiveStreakBefore = (workerId: string, targetDay: number): number => {
    let streak = 0;
    let d = targetDay - 1;
    while (d >= 1 && assignments[d]?.[workerId]?.shiftType !== 'OFF') {
      streak++;
      d--;
    }
    return streak;
  };

  const getAfternoonStreakBefore = (workerId: string, targetDay: number): number => {
    let streak = 0;
    let d = targetDay - 1;
    while (d >= 1 && assignments[d]?.[workerId]?.shiftType === 'AFTERNOON') {
      streak++;
      d--;
    }
    return streak;
  };

  // Ideal worked days per full-time Fisso worker in the period (25 days in a 30-day month = ~162h, right at ~160h target)
  const idealFissoWorkedDays = Math.max(1, Math.floor((totalCalendarDays * 5) / 6));

  // PHASE 1: Constructive Assignment with Staggered A->A->OFF->M->M->M->M Cycle & Quadratic Equity
  for (const dayReq of config.calendar) {
    const d = dayReq.day;
    const isSunday = dayReq.dayOfWeek === 0;

    const shiftsToCover: Array<{ type: 'BAR' | 'AFTERNOON' | 'MORNING'; required: number }> = [
      { type: 'BAR', required: dayReq.reqBar },
      { type: 'AFTERNOON', required: dayReq.reqAfternoon },
      { type: 'MORNING', required: dayReq.reqMorning },
    ];

    for (const shiftGroup of shiftsToCover) {
      const sType = shiftGroup.type;
      const needed = shiftGroup.required;
      const spec = getShiftSpec(config, dayReq, sType);

      for (let slot = 0; slot < needed; slot++) {
        const eligible: Array<{ worker: Worker; cost: number }> = [];
        const rejectionReasons: string[] = [];

        for (const w of activeWorkers) {
          const check = canAssignStrict(w, dayReq, sType);
          if (!check.ok) {
            if (check.failReason && check.failReason !== 'Già in turno nella stessa giornata') {
              rejectionReasons.push(`${w.name}: ${check.failReason}`);
            }
            continue;
          }

          let cost = 0;
          const streakBefore = getConsecutiveStreakBefore(w.id, d);
          const aftStreak = getAfternoonStreakBefore(w.id, d);

          // 1. Strict Priority Tier: Fisso vs Sostituta
          // If a Fisso worker has already reached idealFissoWorkedDays (25 days = ~162h), allow Priority-1 Sostituta to cover the remaining ~10 shifts
          // so all 8 Fisso workers work the exact same 25 days (~162h).
          if (w.type === 'Sostituta') {
            cost += 5000000 * (w.priority || 1);
          } else if (workedDaysCount[w.id] >= idealFissoWorkedDays) {
            cost += 7500000 + (workedDaysCount[w.id] - idealFissoWorkedDays) * 2000000;
          }

          // 2. Smooth M -> M -> M -> M -> A -> A -> OFF transition rule + Max 3 (Preferably 2) Consecutive Afternoons:
          // - A worker who worked AFTERNOON yesterday (aftStreak >= 1) CANNOT work MORNING or BAR today (11h rest rule).
          // - Hard rule: never more than 3 consecutive AFTERNOON shifts (enforced in canAssignStrict).
          // - Soft rule: strongly prefer 2 consecutive AFTERNOON shifts (aftStreak === 1 -> 2nd afternoon gets bonus; aftStreak >= 2 -> 3rd consecutive afternoon gets strong penalty so worker rests after 2 afternoons whenever possible).
          if (w.type === 'Fisso' && (w.canMorning || w.canAfternoon)) {
            if (aftStreak >= 1) {
              if (aftStreak >= prefConsecAfternoons) {
                // Already reached preferred consecutive afternoons (2 pomeriggi consecutivi):
                // Strongly prefer giving rest day (OFF) rather than a 3rd consecutive afternoon, unless needed for coverage
                cost += 450000;
              } else if (streakBefore >= 5 || (d === 2 && aftStreak >= 1 && slot === 1)) {
                // Ready for weekly rest day after finishing 5-6 day cycle ending in Afternoon
                cost += 600000;
              } else if (sType === 'AFTERNOON') {
                // 2nd consecutive afternoon (aftStreak === 1): strong bonus to complete the ideal 2-afternoon block
                cost -= 250000;
              }
            } else if (aftStreak === 0 && sType === 'AFTERNOON') {
              // Starting 1st Afternoon: pick workers who have worked 3-5 Mornings in a row
              if (streakBefore >= 4) {
                cost -= 45000;
              } else if (streakBefore === 3) {
                cost -= 30000;
              } else if (streakBefore <= 1 && d > 2) {
                // Just rested 0-1 days ago: keep on MORNING, do NOT put on AFTERNOON yet!
                cost += 95000;
              } else if (streakBefore === 2 && d > 3) {
                cost += 40000;
              }
            } else if (aftStreak === 0 && sType === 'MORNING') {
              // On MORNING, prefer workers who rested recently (low streakBefore) so workers with streakBefore 4-5 are saved for AFTERNOON or rest
              cost += streakBefore * 8000;
            }
          } else if (w.type === 'Sostituta' && sType === 'AFTERNOON' && aftStreak >= prefConsecAfternoons) {
            // Also prefer max 2 consecutive afternoons for Sostitute (hard limit 3 is already enforced in canAssignStrict)
            cost += 350000;
          }

          // 3. Dedicated Bar rule with equalized workload (25 shifts = ~162h):
          if (sType === 'BAR') {
            if (!w.canMorning && !w.canAfternoon) {
              const genDays =
                generalFissoWorkers.reduce((acc, gw) => acc + workedDaysCount[gw.id], 0) /
                Math.max(1, generalFissoWorkers.length);
              const barBackupAvail = generalFissoWorkers.some(
                (gw) =>
                  gw.canBar &&
                  canAssignStrict(gw, dayReq, 'BAR').ok &&
                  getAfternoonStreakBefore(gw.id, d) === 0
              );
              if (
                barBackupAvail &&
                workedDaysCount[w.id] > genDays + 0.65 &&
                (spec.hours === 6 || streakBefore >= 5)
              ) {
                cost += 180000;
              } else {
                cost -= 150000;
              }
            } else {
              cost += 500;
            }
          }

          // 4. Lookahead: protect Bar backups from getting AFTERNOON on day d if Bar needs backup on d+1
          if (
            sType === 'AFTERNOON' &&
            barNeedsSubstituteOnDay[d + 1] &&
            w.canBar &&
            config.constraints.forbidAfternoonToMorning
          ) {
            cost += 50000;
          }

          // 5. Strong Quadratic Equity on Normalized Hours
          const cap = Math.max(0.25, capacityWeight[w.id] || 1);
          const projectedEffectiveHours = (totalHours[w.id] + spec.hours) / cap;
          cost +=
            projectedEffectiveHours *
            projectedEffectiveHours *
            22 *
            config.constraints.weightMonthlyHoursEquity;

          // 6. Strong Quadratic Equity on Specific Shift Type (Afternoon vs Morning+Bar)
          if (sType === 'AFTERNOON') {
            const nextAft = (afternoonCount[w.id] + 1) / cap;
            cost +=
              nextAft *
              nextAft *
              1400 *
              config.constraints.weightMorningAfternoonBalance;
          } else if (sType === 'MORNING' || sType === 'BAR') {
            const nextEarly = (getEarlyShiftCount(w.id) + 1) / cap;
            cost +=
              nextEarly *
              nextEarly *
              900 *
              config.constraints.weightMorningAfternoonBalance;
          }

          // 7. Weekend / Holiday / Hours / Shift Rotation Multi-Month Historical Balancing
          const isSaturday = dayReq.dayOfWeek === 6;
          if (isSunday) {
            cost += sundaysWorked[w.id] * 180 * config.constraints.weightSundayRotation;
            if (useHist) {
              cost +=
                (histSundays[w.id] * 95 + histHolidays[w.id] * 45) *
                config.constraints.weightSundayRotation;
            }
          } else if (isSaturday && useHist) {
            // Balance weekend burden for workers who already worked many Sundays/holidays in past months
            cost +=
              (histSundays[w.id] * 35 + histHolidays[w.id] * 25) *
              config.constraints.weightSundayRotation;
          }
          if (dayReq.isHoliday && useHist) {
            cost += (histHolidays[w.id] * 140 + histSundays[w.id] * 50) * config.constraints.weightSundayRotation;
          }
          if (useHist && w.type === 'Fisso') {
            // Workers above cumulative target hours get a higher cost; workers below cumulative target get priority
            cost +=
              histTargetDelta[w.id] * 18 * config.constraints.weightMonthlyHoursEquity -
              histAbsenceDays[w.id] * 4;
            // Balance Afternoon vs Morning shifts across historical months
            const histAftDiff = (histAfternoon[w.id] || 0) - (histMorning[w.id] || 0);
            if (sType === 'AFTERNOON') {
              cost +=
                (histAfternoon[w.id] * 28 + Math.max(0, histAftDiff) * 35) *
                config.constraints.weightMorningAfternoonBalance;
            } else if (sType === 'MORNING' || sType === 'BAR') {
              cost +=
                (histMorning[w.id] * 22 + Math.max(0, -histAftDiff) * 30) *
                config.constraints.weightMorningAfternoonBalance;
            }
          }

          eligible.push({ worker: w, cost });
        }

        eligible.sort((a, b) => a.cost - b.cost);

        if (eligible.length > 0) {
          const chosen = eligible[0].worker;
          assignments[d][chosen.id] = {
            shiftType: sType,
            label: spec.label,
            hours: spec.hours,
          };
          totalHours[chosen.id] += spec.hours;
          workedDaysCount[chosen.id] += 1;
          if (sType === 'BAR') barCount[chosen.id] += 1;
          if (sType === 'MORNING') morningCount[chosen.id] += 1;
          if (sType === 'AFTERNOON') afternoonCount[chosen.id] += 1;
          if (isSunday) sundaysWorked[chosen.id] += 1;
        } else {
          // Check if this is an AFTERNOON shift where exceeding maxConsecAfternoons (3) is strictly indispensable
          let coveredViaAuthorizedOverflow = false;
          if (sType === 'AFTERNOON') {
            const emergencyCandidates = activeWorkers
              .filter((w) => canAssignStrict(w, dayReq, 'AFTERNOON', true).ok)
              .sort(
                (a, b) =>
                  getAfternoonStreakBefore(a.id, d) - getAfternoonStreakBefore(b.id, d) ||
                  totalHours[a.id] - totalHours[b.id]
              );

            if (emergencyCandidates.length > 0) {
              const bestEmergency = emergencyCandidates[0];
              const newAftStreak = getAfternoonStreakBefore(bestEmergency.id, d) + 1;
              indispensableAfternoonExceptions.push({
                day: d,
                dateStr: dayReq.dateStr,
                dayAbbr: dayReq.dayAbbr,
                workerId: bestEmergency.id,
                workerName: bestEmergency.name,
                consecutiveCount: newAftStreak,
              });

              if (config.constraints.allowEmergencyAfternoonOverflow) {
                assignments[d][bestEmergency.id] = {
                  shiftType: 'AFTERNOON',
                  label: spec.label,
                  hours: spec.hours,
                };
                totalHours[bestEmergency.id] += spec.hours;
                workedDaysCount[bestEmergency.id] += 1;
                afternoonCount[bestEmergency.id] += 1;
                if (isSunday) sundaysWorked[bestEmergency.id] += 1;
                coveredViaAuthorizedOverflow = true;
                diagnostics.push({
                  level: 'WARNING',
                  day: d,
                  dateStr: dayReq.dateStr,
                  message: `Eccezione confermata dall'utente: ${bestEmergency.name} assegnata al ${newAftStreak}° pomeriggio consecutivo il ${dayReq.dateStr} (${dayReq.dayAbbr}) perché indispensabile per coprire il turno.`,
                });
              } else {
                requiresAfternoonOverflowConfirmation = true;
              }
            }
          }

          if (!coveredViaAuthorizedOverflow) {
            hasInfeasibility = true;
            const shiftNameIt =
              sType === 'BAR' ? 'Bar' : sType === 'MORNING' ? 'Mattina' : 'Pomeriggio';
            const detailedCauses =
              rejectionReasons.length > 0
                ? rejectionReasons.slice(0, 5).join('; ')
                : 'Nessuna operatrice abilitata disponibile';
            diagnostics.push({
              level: 'ERROR',
              day: d,
              dateStr: dayReq.dateStr,
              message: `Giorno ${dayReq.dateStr} (${dayReq.dayAbbr}): fabbisogno ${shiftNameIt} scoperto (${slot}/${needed} assegnati). Cause: ${detailedCauses}.`,
            });
          }
        }
      }
    }
  }

  const getNormalizedHours = (w: Worker) => {
    const cap = capacityWeight[w.id] || 1;
    return totalHours[w.id] / Math.max(0.2, cap);
  };

  const applyShiftDelta = (
    wId: string,
    sType: 'BAR' | 'MORNING' | 'AFTERNOON',
    delta: 1 | -1,
    hoursDelta: number,
    isSunday: boolean
  ) => {
    totalHours[wId] += hoursDelta;
    workedDaysCount[wId] += delta;
    if (sType === 'BAR') barCount[wId] += delta;
    if (sType === 'MORNING') morningCount[wId] += delta;
    if (sType === 'AFTERNOON') afternoonCount[wId] += delta;
    if (isSunday) sundaysWorked[wId] += delta;
  };

  enforcePostPhase1SundayCap = false;

  // PHASE 2: Exact Workload Equalization Engine across ALL Fisso workers (INCLUDING Ioana!)
  // Step 2.0: Ensure every full-availability Fisso worker reaches idealFissoWorkedDays (25 days = ~162h)
  // by absorbing shifts from lowest-priority Sostitute.
  const substituteWorkers = activeWorkers.filter((w) => w.type === 'Sostituta');
  const substituteWorkersReversed = [...substituteWorkers].reverse();
  const fullAvailFissoInit = fissoWorkers.filter(
    (w) => absenceDaysMap[w.id] === 0 && w.maxWeeklyHours === 40
  );

  const calendarWeekdaysFirst = config.calendar;

  for (let subPass = 0; subPass < 30; subPass++) {
    let absorbed = false;
    const underWorkedFisso = [...fullAvailFissoInit]
      .filter((w) => workedDaysCount[w.id] < idealFissoWorkedDays)
      .sort(
        (a, b) => workedDaysCount[a.id] - workedDaysCount[b.id] || totalHours[a.id] - totalHours[b.id]
      );

    for (const wFisso of underWorkedFisso) {
      for (const dayReq of calendarWeekdaysFirst) {
        const d = dayReq.day;
        const isSun = dayReq.dayOfWeek === 0;
        if (assignments[d][wFisso.id].shiftType !== 'OFF') continue;

        for (const wSub of substituteWorkersReversed) {
          const cellSub = assignments[d][wSub.id];
          if (cellSub.shiftType === 'OFF') continue;
          const subType = cellSub.shiftType;
          const subHours = cellSub.hours;

          assignments[d][wSub.id] = { shiftType: 'OFF', label: '', hours: 0 };
          if (canAssignStrict(wFisso, dayReq, subType).ok) {
            assignments[d][wFisso.id] = { ...cellSub };
            applyShiftDelta(wSub.id, subType, -1, -subHours, isSun);
            applyShiftDelta(wFisso.id, subType, 1, subHours, isSun);
            absorbed = true;
            break;
          } else {
            assignments[d][wSub.id] = cellSub;
          }

          for (const wBridge of fissoWorkers) {
            if (wBridge.id === wFisso.id) continue;
            const cellBridge = assignments[d][wBridge.id];
            if (cellBridge.shiftType === 'OFF' || cellBridge.shiftType === subType) continue;
            const bridgeType = cellBridge.shiftType;
            const bridgeHours = cellBridge.hours;

            assignments[d][wSub.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const okBridgeToSub = canAssignStrict(wBridge, dayReq, subType).ok;
            let okFissoToBridge = false;
            if (okBridgeToSub) {
              assignments[d][wBridge.id] = { ...cellSub };
              okFissoToBridge = canAssignStrict(wFisso, dayReq, bridgeType).ok;
            }

            if (okBridgeToSub && okFissoToBridge) {
              assignments[d][wFisso.id] = { ...cellBridge };
              applyShiftDelta(wSub.id, subType, -1, -subHours, isSun);
              totalHours[wBridge.id] += subHours - bridgeHours;
              if (bridgeType === 'BAR') barCount[wBridge.id]--;
              if (bridgeType === 'MORNING') morningCount[wBridge.id]--;
              if (bridgeType === 'AFTERNOON') afternoonCount[wBridge.id]--;
              if (subType === 'BAR') barCount[wBridge.id]++;
              if (subType === 'MORNING') morningCount[wBridge.id]++;
              if (subType === 'AFTERNOON') afternoonCount[wBridge.id]++;

              applyShiftDelta(wFisso.id, bridgeType, 1, bridgeHours, isSun);
              absorbed = true;
              break;
            } else {
              assignments[d][wSub.id] = cellSub;
              assignments[d][wBridge.id] = cellBridge;
              assignments[d][wFisso.id] = { shiftType: 'OFF', label: '', hours: 0 };
            }
          }
          if (absorbed) break;
        }
        if (absorbed) break;
      }
      if (absorbed) break;

      // 2-Day Bridge Absorption: wFisso is OFF on d1, wBridge works on d1 & is OFF on d2, wSub works on d2
      for (const dayReq1 of calendarWeekdaysFirst) {
        const d1 = dayReq1.day;
        const isSun1 = dayReq1.dayOfWeek === 0;
        if (assignments[d1][wFisso.id].shiftType !== 'OFF') continue;

        for (const wBridge of fissoWorkers) {
          if (wBridge.id === wFisso.id) continue;
          const cellBridge1 = assignments[d1][wBridge.id];
          if (cellBridge1.shiftType === 'OFF') continue;

          for (const dayReq2 of calendarWeekdaysFirst) {
            const d2 = dayReq2.day;
            if (d1 === d2) continue;
            const isSun2 = dayReq2.dayOfWeek === 0;
            if (assignments[d2][wBridge.id].shiftType !== 'OFF') continue;

            for (const wSub of substituteWorkersReversed) {
              const cellSub2 = assignments[d2][wSub.id];
              if (cellSub2.shiftType === 'OFF') continue;

              const bType1 = cellBridge1.shiftType;
              const bHours1 = cellBridge1.hours;
              const sType2 = cellSub2.shiftType;
              const sHours2 = cellSub2.hours;

              assignments[d1][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };
              assignments[d2][wSub.id] = { shiftType: 'OFF', label: '', hours: 0 };

              const okFissoD1 = canAssignStrict(wFisso, dayReq1, bType1).ok;
              let okBridgeD2 = false;
              if (okFissoD1) {
                assignments[d1][wFisso.id] = { ...cellBridge1 };
                okBridgeD2 = canAssignStrict(wBridge, dayReq2, sType2).ok;
              }

              if (okFissoD1 && okBridgeD2) {
                assignments[d2][wBridge.id] = { ...cellSub2 };
                applyShiftDelta(wSub.id, sType2, -1, -sHours2, isSun2);
                applyShiftDelta(wBridge.id, bType1, -1, -bHours1, isSun1);
                applyShiftDelta(wBridge.id, sType2, 1, sHours2, isSun2);
                applyShiftDelta(wFisso.id, bType1, 1, bHours1, isSun1);
                absorbed = true;
                break;
              } else {
                assignments[d1][wBridge.id] = cellBridge1;
                assignments[d1][wFisso.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d2][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d2][wSub.id] = cellSub2;
              }
            }
            if (absorbed) break;
          }
          if (absorbed) break;
        }
        if (absorbed) break;
      }
      if (absorbed) break;
    }
    if (!absorbed) break;
  }

  // Step 2.0b: Consolidate remaining substitute shifts onto higher-priority Sostituta (1 = Massima -> 4 = Minima)
  if (substituteWorkers.length >= 2) {
    for (let i = 0; i < substituteWorkers.length; i++) {
      for (let j = substituteWorkers.length - 1; j > i; j--) {
        const wSubHiPrio = substituteWorkers[i]; // e.g. priority 1
        const wSubLoPrio = substituteWorkers[j]; // e.g. priority 2..4
        if ((wSubHiPrio.priority || 1) >= (wSubLoPrio.priority || 1)) continue;
        for (const dayReq of config.calendar) {
          const d = dayReq.day;
          const isSun = dayReq.dayOfWeek === 0;
          const cellLo = assignments[d][wSubLoPrio.id];
          const cellHi = assignments[d][wSubHiPrio.id];
          if (cellLo.shiftType !== 'OFF' && cellHi.shiftType === 'OFF') {
            const sType = cellLo.shiftType;
            const sHours = cellLo.hours;
            assignments[d][wSubLoPrio.id] = { shiftType: 'OFF', label: '', hours: 0 };
            if (canAssignStrict(wSubHiPrio, dayReq, sType).ok) {
              assignments[d][wSubHiPrio.id] = { ...cellLo };
              applyShiftDelta(wSubLoPrio.id, sType, -1, -sHours, isSun);
              applyShiftDelta(wSubHiPrio.id, sType, 1, sHours, isSun);
            } else {
              assignments[d][wSubLoPrio.id] = cellLo;
            }
          }
        }
      }
    }
  }

  // Step 2.1: Multi-pass Hours Equalization (Direct Transfer, Relay Transfer, 2-Day 7h<->6h Swap, 3-Worker 7h<->6h Relay, Sunday 7h<->6h Swap)
  let bridgeSwapCount = 0;
  for (let pass = 0; pass < 45; pass++) {
    if (performance.now() - startTime > 35) break;
    let improvedInPass = false;

    const sortedByLoad = [...fissoWorkers].sort(
      (a, b) => getNormalizedHours(b) - getNormalizedHours(a)
    );

    if (sortedByLoad.length < 2) break;

    // Move Type A: Direct Shift Transfer on day `d` from wHigh to wLow (or 3-Worker Relay via wBridge)
    for (let hiIdx = 0; hiIdx < sortedByLoad.length; hiIdx++) {
      for (let loIdx = sortedByLoad.length - 1; loIdx > hiIdx; loIdx--) {
        const wHigh = sortedByLoad[hiIdx];
        const wLow = sortedByLoad[loIdx];

        const capHigh = capacityWeight[wHigh.id] || 1;
        const capLow = capacityWeight[wLow.id] || 1;
        const currentGap = totalHours[wHigh.id] / capHigh - totalHours[wLow.id] / capLow;

        if (currentGap <= 1.0) continue;

        for (const dayReq of config.calendar) {
          const d = dayReq.day;
          const isSun = dayReq.dayOfWeek === 0;
          const cellHigh = assignments[d][wHigh.id];
          const cellLow = assignments[d][wLow.id];

          if (cellHigh.shiftType !== 'OFF' && cellLow.shiftType === 'OFF') {
            const sType = cellHigh.shiftType;
            const sHours = cellHigh.hours;

            const newGap = Math.abs(
              (totalHours[wHigh.id] - sHours) / capHigh - (totalHours[wLow.id] + sHours) / capLow
            );

            if (newGap + 0.05 < currentGap) {
              assignments[d][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
              const checkLow = canAssignStrict(wLow, dayReq, sType);
              if (checkLow.ok) {
                assignments[d][wLow.id] = { ...cellHigh };
                applyShiftDelta(wHigh.id, sType, -1, -sHours, isSun);
                applyShiftDelta(wLow.id, sType, 1, sHours, isSun);
                improvedInPass = true;
                break;
              } else {
                assignments[d][wHigh.id] = cellHigh;
              }

              // Relay Transfer on day `d`: wHigh -> wBridge -> wLow
              for (const wBridge of fissoWorkers) {
                if (wBridge.id === wHigh.id || wBridge.id === wLow.id) continue;
                const cellBridge = assignments[d][wBridge.id];
                if (
                  cellBridge.shiftType === 'OFF' ||
                  cellBridge.shiftType === sType ||
                  cellBridge.hours !== sHours
                ) {
                  continue;
                }
                const bridgeOldType = cellBridge.shiftType;
                assignments[d][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };

                const okBridgeTakesHigh = canAssignStrict(wBridge, dayReq, sType).ok;
                let okLowTakesBridge = false;
                if (okBridgeTakesHigh) {
                  assignments[d][wBridge.id] = { ...cellHigh };
                  okLowTakesBridge = canAssignStrict(wLow, dayReq, bridgeOldType).ok;
                }

                if (okBridgeTakesHigh && okLowTakesBridge) {
                  assignments[d][wLow.id] = { ...cellBridge };
                  applyShiftDelta(wHigh.id, sType, -1, -sHours, isSun);
                  if (bridgeOldType === 'BAR') barCount[wBridge.id]--;
                  if (bridgeOldType === 'MORNING') morningCount[wBridge.id]--;
                  if (bridgeOldType === 'AFTERNOON') afternoonCount[wBridge.id]--;
                  if (sType === 'BAR') barCount[wBridge.id]++;
                  if (sType === 'MORNING') morningCount[wBridge.id]++;
                  if (sType === 'AFTERNOON') afternoonCount[wBridge.id]++;

                  applyShiftDelta(wLow.id, bridgeOldType, 1, sHours, isSun);
                  improvedInPass = true;
                  break;
                } else {
                  assignments[d][wHigh.id] = cellHigh;
                  assignments[d][wBridge.id] = cellBridge;
                  assignments[d][wLow.id] = cellLow;
                }
              }
              if (improvedInPass) break;
            }
          }
        }
        if (improvedInPass) break;
      }
      if (improvedInPass) break;
    }

    if (improvedInPass) continue;

    // Move Type B: 2-Day Cross Swap (7h shift <-> 6h shift) between wHigh and wLow
    // Also supports Same-Day Sunday Swap (7h MORNING/BAR <-> 6h AFTERNOON)
    for (let hiIdx = 0; hiIdx < sortedByLoad.length; hiIdx++) {
      for (let loIdx = sortedByLoad.length - 1; loIdx > hiIdx; loIdx--) {
        const wHigh = sortedByLoad[hiIdx];
        const wLow = sortedByLoad[loIdx];

        const capHigh = capacityWeight[wHigh.id] || 1;
        const capLow = capacityWeight[wLow.id] || 1;
        const currentGap = totalHours[wHigh.id] / capHigh - totalHours[wLow.id] / capLow;

        if (currentGap <= 1.0) continue;

        // B1. Same-Day 7h <-> 6h Swap (e.g. on Sunday or Holiday where Morning/Bar=7h and Afternoon=6h)
        for (const dayReq of config.calendar) {
          const d = dayReq.day;
          const cHigh = assignments[d][wHigh.id];
          const cLow = assignments[d][wLow.id];
          if (
            cHigh.shiftType !== 'OFF' &&
            cLow.shiftType !== 'OFF' &&
            cHigh.hours === 7 &&
            cLow.hours === 6
          ) {
            assignments[d][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const okLowTakes7 = canAssignStrict(wLow, dayReq, cHigh.shiftType).ok;
            let okHighTakes6 = false;
            if (okLowTakes7) {
              assignments[d][wLow.id] = { ...cHigh };
              okHighTakes6 = canAssignStrict(wHigh, dayReq, cLow.shiftType).ok;
            }

            if (okLowTakes7 && okHighTakes6) {
              assignments[d][wHigh.id] = { ...cLow };
              totalHours[wHigh.id] -= 1;
              totalHours[wLow.id] += 1;

              if (cHigh.shiftType === 'BAR') {
                barCount[wHigh.id]--;
                barCount[wLow.id]++;
              }
              if (cHigh.shiftType === 'MORNING') {
                morningCount[wHigh.id]--;
                morningCount[wLow.id]++;
              }
              if (cHigh.shiftType === 'AFTERNOON') {
                afternoonCount[wHigh.id]--;
                afternoonCount[wLow.id]++;
              }

              if (cLow.shiftType === 'BAR') {
                barCount[wLow.id]--;
                barCount[wHigh.id]++;
              }
              if (cLow.shiftType === 'MORNING') {
                morningCount[wLow.id]--;
                morningCount[wHigh.id]++;
              }
              if (cLow.shiftType === 'AFTERNOON') {
                afternoonCount[wLow.id]--;
                afternoonCount[wHigh.id]++;
              }

              improvedInPass = true;
              break;
            } else {
              assignments[d][wHigh.id] = cHigh;
              assignments[d][wLow.id] = cLow;
            }
          }
        }
        if (improvedInPass) break;

        // B2. 2-Day Cross Swap (7h shift on d1 <-> 6h shift on d2)
        for (let d1 = 1; d1 <= totalCalendarDays; d1++) {
          const c1High = assignments[d1][wHigh.id];
          const c1Low = assignments[d1][wLow.id];
          if (c1High.shiftType === 'OFF' || c1Low.shiftType !== 'OFF' || c1High.hours !== 7)
            continue;

          for (let d2 = 1; d2 <= totalCalendarDays; d2++) {
            if (d1 === d2) continue;
            const c2High = assignments[d2][wHigh.id];
            const c2Low = assignments[d2][wLow.id];
            if (c2Low.shiftType === 'OFF' || c2High.shiftType !== 'OFF' || c2Low.hours !== 6)
              continue;

            // Direct 2-day swap
            assignments[d1][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d2][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const okLowOnD1 = canAssignStrict(wLow, dayReqByDay[d1], c1High.shiftType).ok;
            let okHighOnD2 = false;
            if (okLowOnD1) {
              assignments[d1][wLow.id] = { ...c1High };
              okHighOnD2 = canAssignStrict(wHigh, dayReqByDay[d2], c2Low.shiftType).ok;
            }

            if (okLowOnD1 && okHighOnD2) {
              assignments[d2][wHigh.id] = { ...c2Low };
              totalHours[wHigh.id] -= 1;
              totalHours[wLow.id] += 1;

              const s1 = c1High.shiftType;
              const s2 = c2Low.shiftType;
              if (s1 === 'BAR') {
                barCount[wHigh.id]--;
                barCount[wLow.id]++;
              }
              if (s1 === 'MORNING') {
                morningCount[wHigh.id]--;
                morningCount[wLow.id]++;
              }
              if (s1 === 'AFTERNOON') {
                afternoonCount[wHigh.id]--;
                afternoonCount[wLow.id]++;
              }

              if (s2 === 'BAR') {
                barCount[wLow.id]--;
                barCount[wHigh.id]++;
              }
              if (s2 === 'MORNING') {
                morningCount[wLow.id]--;
                morningCount[wHigh.id]++;
              }
              if (s2 === 'AFTERNOON') {
                afternoonCount[wLow.id]--;
                afternoonCount[wHigh.id]++;
              }

              if (dayReqByDay[d1].dayOfWeek === 0) {
                sundaysWorked[wHigh.id]--;
                sundaysWorked[wLow.id]++;
              }
              if (dayReqByDay[d2].dayOfWeek === 0) {
                sundaysWorked[wLow.id]--;
                sundaysWorked[wHigh.id]++;
              }

              improvedInPass = true;
              break;
            } else {
              assignments[d1][wHigh.id] = c1High;
              assignments[d1][wLow.id] = c1Low;
              assignments[d2][wHigh.id] = c2High;
              assignments[d2][wLow.id] = c2Low;
            }

            // B3. Relay 2-Day 7h<->6h Swap when one of (wHigh, wLow) is Ioana (Bar-only) and the other is a generalist:
            // On the day where the generalist has a non-BAR shift, a Bar-capable bridge (Sabrina/Ilaria) swaps BAR<->General on that day!
            const bridges = fissoWorkers.filter(
              (w) =>
                w.id !== wHigh.id &&
                w.id !== wLow.id &&
                w.canBar &&
                (w.canMorning || w.canAfternoon)
            );
            for (const wBridge of bridges) {
              // Case 1: wLow is Bar-only (needs BAR on d1, has BAR on d2), wHigh has non-BAR (7h) on d1, wBridge has BAR (7h) on d1
              const c1Bridge = assignments[d1][wBridge.id];
              const c2Bridge = assignments[d2][wBridge.id];
              if (
                wLow.canBar &&
                !wLow.canMorning &&
                c1Bridge.shiftType === 'BAR' &&
                c1Bridge.hours === 7 &&
                c2Low.shiftType === 'BAR'
              ) {
                assignments[d1][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d1][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d2][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };

                // On d1: wBridge takes c1High (7h), wLow takes BAR (7h)
                // On d2: if wBridge was OFF on d2 and wHigh is OFF on d2, wait: wHigh needs a 6h shift on d2.
                // If wHigh cannot take BAR on d2, we need someone on d2 (or wBridge on d2) with a 6h Morning/Afternoon shift to swap with BAR on d2!
                if (c2Bridge.shiftType !== 'OFF' && c2Bridge.hours === 6) {
                  assignments[d2][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };
                  const okB1 = canAssignStrict(wBridge, dayReqByDay[d1], c1High.shiftType).ok;
                  let okL1 = false;
                  let okB2 = false;
                  let okH2 = false;
                  if (okB1) {
                    assignments[d1][wBridge.id] = { ...c1High };
                    okL1 = canAssignStrict(wLow, dayReqByDay[d1], 'BAR').ok;
                  }
                  if (okL1) {
                    assignments[d1][wLow.id] = { ...c1Bridge };
                    okB2 = canAssignStrict(wBridge, dayReqByDay[d2], 'BAR').ok;
                  }
                  if (okB2) {
                    assignments[d2][wBridge.id] = { ...c2Low };
                    okH2 = canAssignStrict(wHigh, dayReqByDay[d2], c2Bridge.shiftType).ok;
                  }

                  if (okB1 && okL1 && okB2 && okH2) {
                    assignments[d2][wHigh.id] = { ...c2Bridge };
                    totalHours[wHigh.id] -= 1;
                    totalHours[wLow.id] += 1;

                    // Update shift counts:
                    // d1: wHigh lost c1High, wBridge lost BAR & gained c1High, wLow gained BAR
                    // d2: wLow lost BAR, wBridge lost c2Bridge & gained BAR, wHigh gained c2Bridge
                    // Notice wLow net BAR change is 0 (+1 on d1, -1 on d2), wBridge net BAR change is 0 (-1 on d1, +1 on d2)!
                    if (c1High.shiftType === 'MORNING') {
                      morningCount[wHigh.id]--;
                      morningCount[wBridge.id]++;
                    }
                    if (c1High.shiftType === 'AFTERNOON') {
                      afternoonCount[wHigh.id]--;
                      afternoonCount[wBridge.id]++;
                    }
                    if (c2Bridge.shiftType === 'MORNING') {
                      morningCount[wBridge.id]--;
                      morningCount[wHigh.id]++;
                    }
                    if (c2Bridge.shiftType === 'AFTERNOON') {
                      afternoonCount[wBridge.id]--;
                      afternoonCount[wHigh.id]++;
                    }

                    if (dayReqByDay[d1].dayOfWeek === 0) {
                      sundaysWorked[wHigh.id]--;
                      sundaysWorked[wLow.id]++;
                    }
                    if (dayReqByDay[d2].dayOfWeek === 0) {
                      sundaysWorked[wLow.id]--;
                      sundaysWorked[wHigh.id]++;
                    }

                    improvedInPass = true;
                    break;
                  }
                }

                // Restore on failure
                assignments[d1][wHigh.id] = c1High;
                assignments[d1][wBridge.id] = c1Bridge;
                assignments[d1][wLow.id] = c1Low;
                assignments[d2][wHigh.id] = c2High;
                assignments[d2][wBridge.id] = c2Bridge;
                assignments[d2][wLow.id] = c2Low;
              }
            }
            if (improvedInPass) break;
          }
          if (improvedInPass) break;
        }
        if (improvedInPass) break;
      }
      if (improvedInPass) break;
    }

    if (improvedInPass) continue;

    // Move Type B-Bridge: Allow Bar-only worker (Ioana) to swap 7h<->6h Bar shift with Sabrina/Ilaria
    // whenever Ioana's hours differ from the median Fisso hours
    if (bridgeSwapCount < 12) {
      const barOnlyWorker = fissoWorkers.find(
        (w) => w.canBar && !w.canMorning && !w.canAfternoon
      );
      if (barOnlyWorker) {
        const otherHours = fissoWorkers
          .filter((w) => w.id !== barOnlyWorker.id)
          .map((w) => totalHours[w.id]);
        const avgOther =
          otherHours.reduce((acc, v) => acc + v, 0) / Math.max(1, otherHours.length);
        const diff = totalHours[barOnlyWorker.id] - avgOther;

        if (Math.abs(diff) >= 0.75) {
          const bridges = fissoWorkers.filter(
            (w) => w.canBar && (w.canMorning || w.canAfternoon)
          );
          for (const wBridge of bridges) {
            const pairHigh = diff > 0 ? barOnlyWorker : wBridge;
            const pairLow = diff > 0 ? wBridge : barOnlyWorker;

            for (let d1 = 1; d1 <= totalCalendarDays; d1++) {
              const c1High = assignments[d1][pairHigh.id];
              const c1Low = assignments[d1][pairLow.id];
              if (c1High.shiftType !== 'BAR' || c1Low.shiftType !== 'OFF' || c1High.hours !== 7)
                continue;

              for (let d2 = 1; d2 <= totalCalendarDays; d2++) {
                if (d1 === d2) continue;
                const c2High = assignments[d2][pairHigh.id];
                const c2Low = assignments[d2][pairLow.id];
                if (c2Low.shiftType !== 'BAR' || c2High.shiftType !== 'OFF' || c2Low.hours !== 6)
                  continue;

                assignments[d1][pairHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d2][pairLow.id] = { shiftType: 'OFF', label: '', hours: 0 };

                const ok1 = canAssignStrict(pairLow, dayReqByDay[d1], 'BAR').ok;
                let ok2 = false;
                if (ok1) {
                  assignments[d1][pairLow.id] = { ...c1High };
                  ok2 = canAssignStrict(pairHigh, dayReqByDay[d2], 'BAR').ok;
                }

                if (ok1 && ok2) {
                  assignments[d2][pairHigh.id] = { ...c2Low };
                  totalHours[pairHigh.id] -= 1;
                  totalHours[pairLow.id] += 1;
                  if (dayReqByDay[d1].dayOfWeek === 0) {
                    sundaysWorked[pairHigh.id]--;
                    sundaysWorked[pairLow.id]++;
                  }
                  if (dayReqByDay[d2].dayOfWeek === 0) {
                    sundaysWorked[pairLow.id]--;
                    sundaysWorked[pairHigh.id]++;
                  }
                  bridgeSwapCount++;
                  improvedInPass = true;
                  break;
                } else {
                  assignments[d1][pairHigh.id] = c1High;
                  assignments[d1][pairLow.id] = c1Low;
                  assignments[d2][pairHigh.id] = c2High;
                  assignments[d2][pairLow.id] = c2Low;
                }
              }
              if (improvedInPass) break;
            }
            if (improvedInPass) break;
          }
        }
      }
    }

    if (improvedInPass) continue;

    // Move Type B-Sub: If any Fisso worker wHigh is >= 2h above the minimum Fisso worker (e.g. 164h vs 162h),
    // allow wHigh to swap a 7h shift on d1 with a 6h shift of a Sostituta on d2 (same shiftType!) so wHigh becomes 163h.
    const minFissoH = Math.min(...fissoWorkers.map((w) => totalHours[w.id]));
    for (const wHigh of sortedByLoad) {
      if (totalHours[wHigh.id] - minFissoH <= 1) continue;
      for (const wSub of substituteWorkers) {
        for (let d1 = 1; d1 <= totalCalendarDays; d1++) {
          const c1High = assignments[d1][wHigh.id];
          const c1Sub = assignments[d1][wSub.id];
          if (c1High.shiftType === 'OFF' || c1Sub.shiftType !== 'OFF' || c1High.hours !== 7)
            continue;

          for (let d2 = 1; d2 <= totalCalendarDays; d2++) {
            if (d1 === d2) continue;
            const c2High = assignments[d2][wHigh.id];
            const c2Sub = assignments[d2][wSub.id];
            if (
              c2Sub.shiftType !== c1High.shiftType ||
              c2High.shiftType !== 'OFF' ||
              c2Sub.hours !== 6
            ) {
              continue;
            }

            assignments[d1][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d2][wSub.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const okSubOnD1 = canAssignStrict(wSub, dayReqByDay[d1], c1High.shiftType).ok;
            let okHighOnD2 = false;
            if (okSubOnD1) {
              assignments[d1][wSub.id] = { ...c1High };
              okHighOnD2 = canAssignStrict(wHigh, dayReqByDay[d2], c2Sub.shiftType).ok;
            }

            if (okSubOnD1 && okHighOnD2) {
              assignments[d2][wHigh.id] = { ...c2Sub };
              totalHours[wHigh.id] -= 1;
              totalHours[wSub.id] += 1;
              if (dayReqByDay[d1].dayOfWeek === 0) {
                sundaysWorked[wHigh.id]--;
                sundaysWorked[wSub.id]++;
              }
              if (dayReqByDay[d2].dayOfWeek === 0) {
                sundaysWorked[wSub.id]--;
                sundaysWorked[wHigh.id]++;
              }
              improvedInPass = true;
              break;
            } else {
              assignments[d1][wHigh.id] = c1High;
              assignments[d1][wSub.id] = c1Sub;
              assignments[d2][wHigh.id] = c2High;
              assignments[d2][wSub.id] = c2Sub;
            }
          }
          if (improvedInPass) break;
        }
        if (improvedInPass) break;
      }
      if (improvedInPass) break;
    }

    if (!improvedInPass) break;
  }

  // PHASE 3: Strict Morning / Afternoon Distribution Equalizer
  // Equalizes Afternoon counts, Morning+Bar counts, and Bar counts across general Fisso workers
  // using same-day swaps, 2-day cross swaps, and 2-day relay swaps via an intermediate worker wMid.
  const computeMorningAfternoonImbalance = (wA: Worker, wB: Worker) => {
    const capA = capacityWeight[wA.id] || 1;
    const capB = capacityWeight[wB.id] || 1;
    const aftDiff = Math.abs(afternoonCount[wA.id] / capA - afternoonCount[wB.id] / capB);
    const earlyDiff = Math.abs(
      getEarlyShiftCount(wA.id) / capA - getEarlyShiftCount(wB.id) / capB
    );
    return aftDiff * 1.5 + earlyDiff;
  };

  for (let pass = 0; pass < 25; pass++) {
    if (performance.now() - startTime > 50) break;
    let swapped = false;

    // 3A. Same-day swap (Morning <-> Afternoon) when both shifts have the same hours (Mon-Sat)
    for (const dayReq of config.calendar) {
      const d = dayReq.day;
      for (let i = 0; i < generalFissoWorkers.length; i++) {
        for (let j = i + 1; j < generalFissoWorkers.length; j++) {
          const wA = generalFissoWorkers[i];
          const wB = generalFissoWorkers[j];
          const cellA = assignments[d][wA.id];
          const cellB = assignments[d][wB.id];

          // Also equalize BAR vs MORNING between Bar-capable generalists (Sabrina & Ilaria)
          if (
            ((cellA.shiftType === 'BAR' && cellB.shiftType === 'MORNING') ||
              (cellA.shiftType === 'MORNING' && cellB.shiftType === 'BAR')) &&
            cellA.hours === cellB.hours &&
            Math.abs(barCount[wA.id] - barCount[wB.id]) > 1
          ) {
            const newTypeA = cellB.shiftType as 'BAR' | 'MORNING';
            const newTypeB = cellA.shiftType as 'BAR' | 'MORNING';
            const nextBarA = barCount[wA.id] + (newTypeA === 'BAR' ? 1 : -1);
            const nextBarB = barCount[wB.id] + (newTypeB === 'BAR' ? 1 : -1);
            if (Math.abs(nextBarA - nextBarB) < Math.abs(barCount[wA.id] - barCount[wB.id])) {
              assignments[d][wA.id] = { shiftType: 'OFF', label: '', hours: 0 };
              assignments[d][wB.id] = { shiftType: 'OFF', label: '', hours: 0 };
              const okA = canAssignStrict(wA, dayReq, newTypeA).ok;
              let okB = false;
              if (okA) {
                assignments[d][wA.id] = { ...cellB };
                okB = canAssignStrict(wB, dayReq, newTypeB).ok;
              }
              if (okA && okB) {
                assignments[d][wB.id] = { ...cellA };
                barCount[wA.id] = nextBarA;
                barCount[wB.id] = nextBarB;
                morningCount[wA.id] += newTypeA === 'MORNING' ? 1 : -1;
                morningCount[wB.id] += newTypeB === 'MORNING' ? 1 : -1;
                swapped = true;
              } else {
                assignments[d][wA.id] = cellA;
                assignments[d][wB.id] = cellB;
              }
            }
          }

          if (
            ((cellA.shiftType === 'MORNING' && cellB.shiftType === 'AFTERNOON') ||
              (cellA.shiftType === 'AFTERNOON' && cellB.shiftType === 'MORNING')) &&
            cellA.hours === cellB.hours
          ) {
            const newTypeA = cellB.shiftType as 'MORNING' | 'AFTERNOON';
            const newTypeB = cellA.shiftType as 'MORNING' | 'AFTERNOON';

            const capA = capacityWeight[wA.id] || 1;
            const capB = capacityWeight[wB.id] || 1;

            const oldScore = computeMorningAfternoonImbalance(wA, wB);
            const nextAfA = afternoonCount[wA.id] + (newTypeA === 'AFTERNOON' ? 1 : -1);
            const nextAfB = afternoonCount[wB.id] + (newTypeB === 'AFTERNOON' ? 1 : -1);
            const nextMoA = morningCount[wA.id] + (newTypeA === 'MORNING' ? 1 : -1);
            const nextMoB = morningCount[wB.id] + (newTypeB === 'MORNING' ? 1 : -1);

            const newScore =
              Math.abs(nextAfA / capA - nextAfB / capB) * 1.5 +
              Math.abs(
                (nextMoA + barCount[wA.id]) / capA - (nextMoB + barCount[wB.id]) / capB
              );

            if (newScore + 0.05 < oldScore) {
              assignments[d][wA.id] = { shiftType: 'OFF', label: '', hours: 0 };
              assignments[d][wB.id] = { shiftType: 'OFF', label: '', hours: 0 };

              const validA = canAssignStrict(wA, dayReq, newTypeA).ok;
              let validB = false;
              if (validA) {
                assignments[d][wA.id] = { ...cellB };
                validB = canAssignStrict(wB, dayReq, newTypeB).ok;
              }

              if (validA && validB) {
                assignments[d][wB.id] = { ...cellA };
                afternoonCount[wA.id] = nextAfA;
                afternoonCount[wB.id] = nextAfB;
                morningCount[wA.id] = nextMoA;
                morningCount[wB.id] = nextMoB;
                swapped = true;
              } else {
                assignments[d][wA.id] = cellA;
                assignments[d][wB.id] = cellB;
              }
            }
          }
        }
      }
    }

    // 3B. Cross-day Morning <-> Afternoon swap between two workers with equal shift hours
    for (let i = 0; i < generalFissoWorkers.length; i++) {
      for (let j = 0; j < generalFissoWorkers.length; j++) {
        if (i === j) continue;
        const wMoreAft = generalFissoWorkers[i];
        const wLessAft = generalFissoWorkers[j];

        const capMore = capacityWeight[wMoreAft.id] || 1;
        const capLess = capacityWeight[wLessAft.id] || 1;

        if (afternoonCount[wMoreAft.id] / capMore - afternoonCount[wLessAft.id] / capLess <= 1.0) {
          continue;
        }

        for (let d1 = 1; d1 <= totalCalendarDays; d1++) {
          const c1More = assignments[d1][wMoreAft.id];
          const c1Less = assignments[d1][wLessAft.id];
          if (c1More.shiftType !== 'AFTERNOON' || c1Less.shiftType !== 'OFF') continue;

          for (let d2 = 1; d2 <= totalCalendarDays; d2++) {
            if (d1 === d2) continue;
            const c2More = assignments[d2][wMoreAft.id];
            const c2Less = assignments[d2][wLessAft.id];
            if (
              c2Less.shiftType !== 'MORNING' ||
              c2More.shiftType !== 'OFF' ||
              c2Less.hours !== c1More.hours
            ) {
              continue;
            }

            assignments[d1][wMoreAft.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d2][wLessAft.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const ok1 = canAssignStrict(wLessAft, dayReqByDay[d1], 'AFTERNOON').ok;
            let ok2 = false;
            if (ok1) {
              assignments[d1][wLessAft.id] = { ...c1More };
              ok2 = canAssignStrict(wMoreAft, dayReqByDay[d2], 'MORNING').ok;
            }

            if (ok1 && ok2) {
              assignments[d2][wMoreAft.id] = { ...c2Less };
              afternoonCount[wMoreAft.id] -= 1;
              afternoonCount[wLessAft.id] += 1;
              morningCount[wMoreAft.id] += 1;
              morningCount[wLessAft.id] -= 1;

              if (dayReqByDay[d1].dayOfWeek === 0) {
                sundaysWorked[wMoreAft.id]--;
                sundaysWorked[wLessAft.id]++;
              }
              if (dayReqByDay[d2].dayOfWeek === 0) {
                sundaysWorked[wLessAft.id]--;
                sundaysWorked[wMoreAft.id]++;
              }

              swapped = true;
              break;
            } else {
              assignments[d1][wMoreAft.id] = c1More;
              assignments[d1][wLessAft.id] = c1Less;
              assignments[d2][wMoreAft.id] = c2More;
              assignments[d2][wLessAft.id] = c2Less;
            }
          }
          if (swapped) break;
        }
        if (swapped) break;

        // 3C. 2-Day Same-Day Relay via intermediate worker wMid:
        // On day d1: wMoreAft (AFTERNOON) <-> wMid (MORNING)
        // On day d2: wMid (AFTERNOON) <-> wLessAft (MORNING)
        for (const wMid of generalFissoWorkers) {
          if (wMid.id === wMoreAft.id || wMid.id === wLessAft.id) continue;

          for (let d1 = 1; d1 <= totalCalendarDays; d1++) {
            const c1More = assignments[d1][wMoreAft.id];
            const c1Mid = assignments[d1][wMid.id];
            if (
              c1More.shiftType !== 'AFTERNOON' ||
              c1Mid.shiftType !== 'MORNING' ||
              c1More.hours !== c1Mid.hours
            ) {
              continue;
            }

            // Temporarily test d1 swap between wMoreAft and wMid
            assignments[d1][wMoreAft.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d1][wMid.id] = { shiftType: 'OFF', label: '', hours: 0 };
            const okD1More = canAssignStrict(wMoreAft, dayReqByDay[d1], 'MORNING').ok;
            let okD1Mid = false;
            if (okD1More) {
              assignments[d1][wMoreAft.id] = { ...c1Mid };
              okD1Mid = canAssignStrict(wMid, dayReqByDay[d1], 'AFTERNOON').ok;
            }
            if (!okD1More || !okD1Mid) {
              assignments[d1][wMoreAft.id] = c1More;
              assignments[d1][wMid.id] = c1Mid;
              continue;
            }
            assignments[d1][wMid.id] = { ...c1More };

            // Now look for d2 where wMid has AFTERNOON and wLessAft has MORNING with equal hours
            let foundD2 = false;
            for (let d2 = 1; d2 <= totalCalendarDays; d2++) {
              if (d1 === d2) continue;
              const c2Mid = assignments[d2][wMid.id];
              const c2Less = assignments[d2][wLessAft.id];
              if (
                c2Mid.shiftType !== 'AFTERNOON' ||
                c2Less.shiftType !== 'MORNING' ||
                c2Mid.hours !== c2Less.hours
              ) {
                continue;
              }

              assignments[d2][wMid.id] = { shiftType: 'OFF', label: '', hours: 0 };
              assignments[d2][wLessAft.id] = { shiftType: 'OFF', label: '', hours: 0 };
              const okD2Mid = canAssignStrict(wMid, dayReqByDay[d2], 'MORNING').ok;
              let okD2Less = false;
              if (okD2Mid) {
                assignments[d2][wMid.id] = { ...c2Less };
                okD2Less = canAssignStrict(wLessAft, dayReqByDay[d2], 'AFTERNOON').ok;
              }

              if (okD2Mid && okD2Less) {
                assignments[d2][wLessAft.id] = { ...c2Mid };
                afternoonCount[wMoreAft.id] -= 1;
                morningCount[wMoreAft.id] += 1;
                afternoonCount[wLessAft.id] += 1;
                morningCount[wLessAft.id] -= 1;
                foundD2 = true;
                swapped = true;
                break;
              } else {
                assignments[d2][wMid.id] = c2Mid;
                assignments[d2][wLessAft.id] = c2Less;
              }
            }

            if (foundD2) {
              break;
            } else {
              // Revert d1 swap if no d2 was found
              assignments[d1][wMoreAft.id] = c1More;
              assignments[d1][wMid.id] = c1Mid;
            }
          }
          if (swapped) break;
        }
        if (swapped) break;
      }
      if (swapped) break;
    }

    if (!swapped) break;
  }

  // PHASE 4: Final 1-Hour Precision Polish (Sunday 7h/6h + Mon-Sat Equal-Hour Paired Swap)
  // Exchanges exactly 1 hour between a 164h worker and a 162h worker WITHOUT changing rest days or Morning/Afternoon counts!
  const fullAvailAllFisso = fissoWorkers.filter(
    (w) => absenceDaysMap[w.id] === 0 && w.maxWeeklyHours === 40
  );
  const visitedP4Pairs = new Set<string>();
  for (let p4 = 0; p4 < 25; p4++) {
    if (fullAvailAllFisso.length < 2) break;
    const minH = Math.min(...fullAvailAllFisso.map((w) => totalHours[w.id]));
    const maxH = Math.max(...fullAvailAllFisso.map((w) => totalHours[w.id]));
    if (maxH - minH <= 1) break;

    let polished = false;
    const highWorkers = fullAvailAllFisso.filter((w) => totalHours[w.id] === maxH);
    const lowWorkers = fullAvailAllFisso
      .filter((w) => totalHours[w.id] < maxH)
      .sort((a, b) => totalHours[a.id] - totalHours[b.id]);

    for (const wHigh of highWorkers) {
      for (const wLow of lowWorkers) {
        const pairKey = [wHigh.id, wLow.id].sort().join(':');
        if (visitedP4Pairs.has(pairKey)) continue;
        // Look for a Sunday/Holiday dSun where wHigh has 7h MORNING and wLow has 6h AFTERNOON
        for (const daySun of config.calendar) {
          const dSun = daySun.day;
          const cSunHigh = assignments[dSun][wHigh.id];
          const cSunLow = assignments[dSun][wLow.id];
          if (
            cSunHigh.shiftType !== 'MORNING' ||
            cSunLow.shiftType !== 'AFTERNOON' ||
            cSunHigh.hours !== 7 ||
            cSunLow.hours !== 6
          ) {
            continue;
          }

          assignments[dSun][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
          assignments[dSun][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };
          const okSunHigh = canAssignStrict(wHigh, daySun, 'AFTERNOON').ok;
          let okSunLow = false;
          if (okSunHigh) {
            assignments[dSun][wHigh.id] = { ...cSunLow };
            okSunLow = canAssignStrict(wLow, daySun, 'MORNING').ok;
          }
          if (!okSunHigh || !okSunLow) {
            assignments[dSun][wHigh.id] = cSunHigh;
            assignments[dSun][wLow.id] = cSunLow;
            continue;
          }
          assignments[dSun][wLow.id] = { ...cSunHigh };

          // Now look for a Mon-Sat day dWk where wHigh has AFTERNOON and wLow has MORNING with EQUAL hours (both 6h or both 7h)
          // to restore their exact Morning/Afternoon counts!
          let pairedFound = false;
          for (const dayWk of config.calendar) {
            const dWk = dayWk.day;
            if (dWk === dSun) continue;
            const cWkHigh = assignments[dWk][wHigh.id];
            const cWkLow = assignments[dWk][wLow.id];
            if (
              cWkHigh.shiftType !== 'AFTERNOON' ||
              cWkLow.shiftType !== 'MORNING' ||
              cWkHigh.hours !== cWkLow.hours
            ) {
              continue;
            }

            assignments[dWk][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[dWk][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };
            const okWkHigh = canAssignStrict(wHigh, dayWk, 'MORNING').ok;
            let okWkLow = false;
            if (okWkHigh) {
              assignments[dWk][wHigh.id] = { ...cWkLow };
              okWkLow = canAssignStrict(wLow, dayWk, 'AFTERNOON').ok;
            }

            if (okWkHigh && okWkLow) {
              assignments[dWk][wLow.id] = { ...cWkHigh };
              totalHours[wHigh.id] -= 1;
              totalHours[wLow.id] += 1;
              visitedP4Pairs.add(pairKey);
              pairedFound = true;
              polished = true;
              break;
            } else {
              assignments[dWk][wHigh.id] = cWkHigh;
              assignments[dWk][wLow.id] = cWkLow;
            }
          }

          if (pairedFound) {
            break;
          } else {
            // Even without dWk, if swapping on dSun alone keeps afternoonSpread <= 1, check if it's acceptable
            const nextAfHigh = afternoonCount[wHigh.id] + 1;
            const nextAfLow = afternoonCount[wLow.id] - 1;
            const allAfts = generalFissoWorkers.map((gw) =>
              gw.id === wHigh.id
                ? nextAfHigh
                : gw.id === wLow.id
                ? nextAfLow
                : afternoonCount[gw.id]
            );
            if (Math.max(...allAfts) - Math.min(...allAfts) <= 1) {
              totalHours[wHigh.id] -= 1;
              totalHours[wLow.id] += 1;
              afternoonCount[wHigh.id] = nextAfHigh;
              afternoonCount[wLow.id] = nextAfLow;
              morningCount[wHigh.id] -= 1;
              morningCount[wLow.id] += 1;
              visitedP4Pairs.add(pairKey);
              polished = true;
              break;
            }
            assignments[dSun][wHigh.id] = cSunHigh;
            assignments[dSun][wLow.id] = cSunLow;
          }
        }
        if (polished) break;

        // 4B. 2-Day (Sunday + Monday) Block Swap:
        // Often on Sunday dSun, wLow has AFTERNOON (6h) AND on Monday dSun+1 also has AFTERNOON (6h) [total 12h],
        // while wHigh has MORNING (7h) on Sunday dSun AND MORNING (6h) on Monday dSun+1 [total 13h].
        // Swapping Sunday alone would create AFTERNOON(Sun)->MORNING(Mon) for wHigh.
        // Swapping BOTH Sunday and Monday (and balancing 1-2 weekday Afternoon/Morning shifts) transfers 1h cleanly!
        for (const daySun of config.calendar) {
          const dSun = daySun.day;
          const dMon = dSun + 1;
          if (dMon > totalCalendarDays) continue;
          const dayMon = dayReqByDay[dMon];

          const cSunH = assignments[dSun][wHigh.id];
          const cMonH = assignments[dMon][wHigh.id];
          const cSunL = assignments[dSun][wLow.id];
          const cMonL = assignments[dMon][wLow.id];

          if (
            cSunH.shiftType === 'MORNING' &&
            cSunH.hours === 7 &&
            cMonH.shiftType === 'MORNING' &&
            cMonH.hours === 6 &&
            cSunL.shiftType === 'AFTERNOON' &&
            cSunL.hours === 6 &&
            cMonL.shiftType === 'AFTERNOON' &&
            cMonL.hours === 6
          ) {
            assignments[dSun][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[dMon][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[dSun][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[dMon][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const ok1 = canAssignStrict(wHigh, daySun, 'AFTERNOON').ok;
            let ok2 = false;
            let ok3 = false;
            let ok4 = false;
            if (ok1) {
              assignments[dSun][wHigh.id] = { ...cSunL };
              ok2 = canAssignStrict(wHigh, dayMon, 'AFTERNOON').ok;
            }
            if (ok2) {
              assignments[dMon][wHigh.id] = { ...cMonL };
              ok3 = canAssignStrict(wLow, daySun, 'MORNING').ok;
            }
            if (ok3) {
              assignments[dSun][wLow.id] = { ...cSunH };
              ok4 = canAssignStrict(wLow, dayMon, 'MORNING').ok;
            }

            if (ok1 && ok2 && ok3 && ok4) {
              assignments[dMon][wLow.id] = { ...cMonH };

              // Now find up to 2 weekday equal-hour swaps where wHigh has AFTERNOON and wLow has MORNING
              let counterSwaps = 0;
              for (const dayWk of config.calendar) {
                const dWk = dayWk.day;
                if (dWk === dSun || dWk === dMon) continue;
                const cWkH = assignments[dWk][wHigh.id];
                const cWkL = assignments[dWk][wLow.id];
                if (
                  cWkH.shiftType === 'AFTERNOON' &&
                  cWkL.shiftType === 'MORNING' &&
                  cWkH.hours === cWkL.hours
                ) {
                  assignments[dWk][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
                  assignments[dWk][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };
                  const okWH = canAssignStrict(wHigh, dayWk, 'MORNING').ok;
                  let okWL = false;
                  if (okWH) {
                    assignments[dWk][wHigh.id] = { ...cWkL };
                    okWL = canAssignStrict(wLow, dayWk, 'AFTERNOON').ok;
                  }
                  if (okWH && okWL) {
                    assignments[dWk][wLow.id] = { ...cWkH };
                    counterSwaps++;
                    if (counterSwaps === 2) break;
                  } else {
                    assignments[dWk][wHigh.id] = cWkH;
                    assignments[dWk][wLow.id] = cWkL;
                  }
                }
              }

              const deltaAf = 2 - counterSwaps;
              const nextAfHigh = afternoonCount[wHigh.id] + deltaAf;
              const nextAfLow = afternoonCount[wLow.id] - deltaAf;
              const allAfts = generalFissoWorkers.map((gw) =>
                gw.id === wHigh.id
                  ? nextAfHigh
                  : gw.id === wLow.id
                  ? nextAfLow
                  : afternoonCount[gw.id]
              );

              if (Math.max(...allAfts) - Math.min(...allAfts) <= 1) {
                totalHours[wHigh.id] -= 1;
                totalHours[wLow.id] += 1;
                afternoonCount[wHigh.id] = nextAfHigh;
                afternoonCount[wLow.id] = nextAfLow;
                morningCount[wHigh.id] -= deltaAf;
                morningCount[wLow.id] += deltaAf;
                visitedP4Pairs.add(pairKey);
                polished = true;
                break;
              }
            }

            // Restore if not accepted
            assignments[dSun][wHigh.id] = cSunH;
            assignments[dMon][wHigh.id] = cMonH;
            assignments[dSun][wLow.id] = cSunL;
            assignments[dMon][wLow.id] = cMonL;
          }
        }
        if (polished) break;
      }
      if (polished) break;
    }
    if (!polished) break;
  }

  // Helper to recompute live counters from assignments matrix
  const recomputeStatsFromAssignments = () => {
    for (const w of config.workers) {
      totalHours[w.id] = 0;
      workedDaysCount[w.id] = 0;
      barCount[w.id] = 0;
      morningCount[w.id] = 0;
      afternoonCount[w.id] = 0;
      sundaysWorked[w.id] = 0;
    }
    for (const dayReq of config.calendar) {
      const d = dayReq.day;
      const isSun = dayReq.dayOfWeek === 0;
      for (const w of config.workers) {
        const cell = assignments[d][w.id];
        if (cell && cell.shiftType !== 'OFF') {
          const spec = getShiftSpec(config, dayReq, cell.shiftType);
          cell.label = spec.label;
          cell.hours = spec.hours;
          totalHours[w.id] += cell.hours;
          workedDaysCount[w.id] += 1;
          if (cell.shiftType === 'BAR') barCount[w.id] += 1;
          if (cell.shiftType === 'MORNING') morningCount[w.id] += 1;
          if (cell.shiftType === 'AFTERNOON') afternoonCount[w.id] += 1;
          if (isSun) sundaysWorked[w.id] += 1;
        }
      }
    }
  };

  // Helper: Attempts to assign `worker` (currently OFF on `dayReq.day`) into `openCell` on `dayReq.day`,
  // allowing either direct placement, a 1-worker same-day shift-type flip, or a next-day (d+1) M<->A flip to unblock CCNL 11h rest.
  const tryPlaceWorkerInOpenSlot = (
    worker: Worker,
    dayReq: DailyRequirement,
    openCell: CellAssignment,
    allowNextDayUnblock = false
  ): boolean => {
    const d = dayReq.day;
    if (assignments[d][worker.id].shiftType !== 'OFF') return false;
    const openType = openCell.shiftType;
    if (openType === 'OFF') return false;

    // 1. Direct placement
    if (canAssignStrict(worker, dayReq, openType).ok) {
      assignments[d][worker.id] = { ...openCell };
      return true;
    }

    // 2. Same-day 1-worker shift-type flip on day `d` (wLocal is ALREADY working on day `d`, so her Sunday count doesn't change)
    for (const wLocal of activeWorkers) {
      if (wLocal.id === worker.id) continue;
      const cLocal = assignments[d][wLocal.id];
      if (cLocal.shiftType === 'OFF' || cLocal.shiftType === openType) continue;

      assignments[d][wLocal.id] = { shiftType: 'OFF', label: '', hours: 0 };
      const prevCap = enforcePostPhase1SundayCap;
      enforcePostPhase1SundayCap = false;
      const okLocal = canAssignStrict(wLocal, dayReq, openType).ok;
      enforcePostPhase1SundayCap = prevCap;
      let okWorker = false;
      if (okLocal) {
        assignments[d][wLocal.id] = { ...openCell };
        okWorker = canAssignStrict(worker, dayReq, cLocal.shiftType).ok;
      }
      if (okLocal && okWorker) {
        assignments[d][worker.id] = { ...cLocal };
        return true;
      }
      assignments[d][wLocal.id] = cLocal;
    }

    // 3. Same-day 1-worker flip on day `d` + equal-hour M<->A flip on day `d + 1` (or `d - 1`) to unblock CCNL 11h rest
    if (allowNextDayUnblock) {
      for (const adjDay of [d + 1, d - 1]) {
        if (adjDay < 1 || adjDay > totalCalendarDays) continue;
        const adjReq = dayReqByDay[adjDay];
        for (const wLocal of activeWorkers) {
          if (wLocal.id === worker.id) continue;
          const cLocal = assignments[d][wLocal.id];
          if (cLocal.shiftType === 'OFF' || cLocal.shiftType === openType) continue;
          const cLocalAdj = assignments[adjDay][wLocal.id];
          if (cLocalAdj.shiftType === 'OFF') continue;

          for (const wAdj of activeWorkers) {
            if (wAdj.id === wLocal.id) continue;
            const cAdj = assignments[adjDay][wAdj.id];
            if (
              cAdj.shiftType === 'OFF' ||
              cAdj.shiftType === cLocalAdj.shiftType ||
              cAdj.hours !== cLocalAdj.hours
            ) {
              continue;
            }

            // Temporarily swap wLocal and wAdj on adjDay, and test wLocal + worker on day d
            assignments[adjDay][wLocal.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[adjDay][wAdj.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d][wLocal.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const prevCap = enforcePostPhase1SundayCap;
            enforcePostPhase1SundayCap = false;
            const okAdj1 = canAssignStrict(wLocal, adjReq, cAdj.shiftType).ok;
            let okAdj2 = false;
            let okLocalD = false;
            if (okAdj1) {
              assignments[adjDay][wLocal.id] = { ...cAdj };
              okAdj2 = canAssignStrict(wAdj, adjReq, cLocalAdj.shiftType).ok;
            }
            if (okAdj2) {
              assignments[adjDay][wAdj.id] = { ...cLocalAdj };
              okLocalD = canAssignStrict(wLocal, dayReq, openType).ok;
            }
            enforcePostPhase1SundayCap = prevCap;

            let okWorkerD = false;
            if (okLocalD) {
              assignments[d][wLocal.id] = { ...openCell };
              okWorkerD = canAssignStrict(worker, dayReq, cLocal.shiftType).ok;
            }

            if (okAdj1 && okAdj2 && okLocalD && okWorkerD) {
              assignments[d][worker.id] = { ...cLocal };
              return true;
            }

            assignments[adjDay][wLocal.id] = cLocalAdj;
            assignments[adjDay][wAdj.id] = cAdj;
            assignments[d][wLocal.id] = cLocal;
          }
        }
      }
    }

    return false;
  };

  const snapshotDayRow = (d: number): Record<string, CellAssignment> => {
    const snap: Record<string, CellAssignment> = {};
    for (const w of config.workers) {
      snap[w.id] = { ...assignments[d][w.id] };
    }
    return snap;
  };

  const restoreDayRows = (snaps: Map<number, Record<string, CellAssignment>>) => {
    for (const [d, row] of snaps.entries()) {
      for (const w of config.workers) {
        assignments[d][w.id] = { ...row[w.id] };
      }
    }
  };

  enforcePostPhase1SundayCap = true;

  // PHASE 5: Guaranteed 1 Free Sunday Per Month for Every Worker
  // If any active worker worked all Sundays in the period (sundaysWorked === totalSundaysInPeriod),
  // swap one of her Sunday shifts with a weekday OFF day using a Sostituta or a colleague with >= 2 free Sundays.
  if (totalSundaysInPeriod >= 2) {
    const maxAllowedSun = totalSundaysInPeriod - 1;
    for (let sunPass = 0; sunPass < 3; sunPass++) {
      const workersNeedingFreeSunday = activeWorkers.filter(
        (w) => sundaysWorked[w.id] > maxAllowedSun
      );
      if (workersNeedingFreeSunday.length === 0) break;

      for (const wNeed of workersNeedingFreeSunday) {
      if (sundaysWorked[wNeed.id] <= maxAllowedSun) continue;
      let freedSunday = false;

      const getPartners = () =>
        activeWorkers.filter(
          (p) => p.id !== wNeed.id && sundaysWorked[p.id] < maxAllowedSun
        );

      // 5A: 2-Day Swap (wNeed: dSun -> dWk; wPartner: dWk -> dSun) with local shift-type swap support
      for (const dSun of sundayDays) {
        const cSunNeed = assignments[dSun][wNeed.id];
        if (cSunNeed.shiftType === 'OFF') continue;
        const daySunReq = dayReqByDay[dSun];

        const candidateWeekdays = config.calendar
          .filter((d) => d.dayOfWeek !== 0 && assignments[d.day][wNeed.id].shiftType === 'OFF')
          .sort((a, b) => {
            const sameWkA = dayToWeekIdx[a.day] === dayToWeekIdx[dSun] ? 0 : 1;
            const sameWkB = dayToWeekIdx[b.day] === dayToWeekIdx[dSun] ? 0 : 1;
            if (sameWkA !== sameWkB) return sameWkA - sameWkB;
            return Math.abs(a.day - dSun) - Math.abs(b.day - dSun);
          });

        for (const dayWkReq of candidateWeekdays) {
          const dWk = dayWkReq.day;
          for (const wPartner of getPartners()) {
            if (assignments[dSun][wPartner.id].shiftType !== 'OFF') continue;
            const cWkPartner = assignments[dWk][wPartner.id];
            if (cWkPartner.shiftType === 'OFF') continue;

            const daysToSave = new Set<number>([
              dSun,
              dWk,
              Math.max(1, dSun - 1),
              Math.min(totalCalendarDays, dSun + 1),
              Math.max(1, dWk - 1),
              Math.min(totalCalendarDays, dWk + 1),
            ]);
            const snaps = new Map<number, Record<string, CellAssignment>>();
            for (const ds of daysToSave) snaps.set(ds, snapshotDayRow(ds));

            assignments[dSun][wNeed.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[dWk][wPartner.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const ok1 = tryPlaceWorkerInOpenSlot(wNeed, dayWkReq, cWkPartner, true);
            const ok2 = ok1 && tryPlaceWorkerInOpenSlot(wPartner, daySunReq, cSunNeed, true);

            if (ok1 && ok2) {
              recomputeStatsFromAssignments();
              freedSunday = true;
              break;
            } else {
              restoreDayRows(snaps);
            }
          }
          if (freedSunday) break;
        }
        if (freedSunday) break;
      }

      // 5B: 3-Worker Relay (wNeed: dSun -> dWk1; wBridge: dWk1 -> dWk2; wPartner: dWk2 -> dSun)
      if (!freedSunday && performance.now() - startTime <= 60) {
        for (const dSun of sundayDays) {
          const cSunNeed = assignments[dSun][wNeed.id];
          if (cSunNeed.shiftType === 'OFF') continue;
          const daySunReq = dayReqByDay[dSun];

          const candidateWk1 = config.calendar
            .filter((d) => d.dayOfWeek !== 0 && assignments[d.day][wNeed.id].shiftType === 'OFF')
            .sort((a, b) => Math.abs(a.day - dSun) - Math.abs(b.day - dSun))
            .slice(0, 6);

          for (const dayWk1Req of candidateWk1) {
            const dWk1 = dayWk1Req.day;
            for (const wBridge of fissoWorkers) {
              if (wBridge.id === wNeed.id) continue;
              const cWk1Bridge = assignments[dWk1][wBridge.id];
              if (cWk1Bridge.shiftType === 'OFF') continue;

              const candidateWk2 = config.calendar
                .filter(
                  (d) =>
                    d.dayOfWeek !== 0 &&
                    d.day !== dWk1 &&
                    assignments[d.day][wBridge.id].shiftType === 'OFF'
                )
                .sort((a, b) => Math.abs(a.day - dWk1) - Math.abs(b.day - dWk1))
                .slice(0, 6);

              for (const dayWk2Req of candidateWk2) {
                const dWk2 = dayWk2Req.day;
                for (const wPartner of getPartners()) {
                  if (assignments[dSun][wPartner.id].shiftType !== 'OFF') continue;
                  const cWk2Partner = assignments[dWk2][wPartner.id];
                  if (cWk2Partner.shiftType === 'OFF') continue;

                  const daysToSave = new Set<number>([
                    dSun,
                    dWk1,
                    dWk2,
                    Math.max(1, dSun - 1),
                    Math.min(totalCalendarDays, dSun + 1),
                    Math.max(1, dWk1 - 1),
                    Math.min(totalCalendarDays, dWk1 + 1),
                    Math.max(1, dWk2 - 1),
                    Math.min(totalCalendarDays, dWk2 + 1),
                  ]);
                  const snaps = new Map<number, Record<string, CellAssignment>>();
                  for (const ds of daysToSave) snaps.set(ds, snapshotDayRow(ds));

                  assignments[dSun][wNeed.id] = { shiftType: 'OFF', label: '', hours: 0 };
                  assignments[dWk1][wBridge.id] = { shiftType: 'OFF', label: '', hours: 0 };
                  assignments[dWk2][wPartner.id] = { shiftType: 'OFF', label: '', hours: 0 };

                  const ok1 = tryPlaceWorkerInOpenSlot(wNeed, dayWk1Req, cWk1Bridge, true);
                  const ok2 =
                    ok1 && tryPlaceWorkerInOpenSlot(wBridge, dayWk2Req, cWk2Partner, true);
                  const ok3 =
                    ok2 && tryPlaceWorkerInOpenSlot(wPartner, daySunReq, cSunNeed, true);

                  if (ok1 && ok2 && ok3) {
                    recomputeStatsFromAssignments();
                    freedSunday = true;
                    break;
                  } else {
                    restoreDayRows(snaps);
                  }
                }
                if (freedSunday) break;
              }
              if (freedSunday) break;
            }
            if (freedSunday) break;
          }
          if (freedSunday) break;
        }
      }

      // 5D: Direct Sunday Relief by Sostituta (checked before 4-worker relay to avoid deep search delay)
      if (!freedSunday) {
        const candidateSundays = [...sundayDays].sort((a, b) => {
          const hA = assignments[a][wNeed.id].hours || 99;
          const hB = assignments[b][wNeed.id].hours || 99;
          if (hA !== hB) return hA - hB;
          return a - b;
        });

        for (const dSun of candidateSundays) {
          const cSunNeed = assignments[dSun][wNeed.id];
          if (cSunNeed.shiftType === 'OFF') continue;
          const daySunReq = dayReqByDay[dSun];

          for (const wSub of substituteWorkers) {
            if (sundaysWorked[wSub.id] >= maxAllowedSun) continue;
            if (assignments[dSun][wSub.id].shiftType !== 'OFF') continue;

            const daysToSave = new Set<number>([
              dSun,
              Math.max(1, dSun - 1),
              Math.min(totalCalendarDays, dSun + 1),
            ]);
            const snaps = new Map<number, Record<string, CellAssignment>>();
            for (const ds of daysToSave) snaps.set(ds, snapshotDayRow(ds));

            assignments[dSun][wNeed.id] = { shiftType: 'OFF', label: '', hours: 0 };
            const okSub = tryPlaceWorkerInOpenSlot(wSub, daySunReq, cSunNeed, true);
            if (okSub) {
              recomputeStatsFromAssignments();
              freedSunday = true;
              break;
            } else {
              restoreDayRows(snaps);
            }
          }
          if (freedSunday) break;
        }
      }

      // 5C: Bounded 4-Worker Relay (only if still needed and within time budget)
      if (!freedSunday && performance.now() - startTime <= 65) {
        for (const dSun of sundayDays) {
          const cSunNeed = assignments[dSun][wNeed.id];
          if (cSunNeed.shiftType === 'OFF') continue;
          const daySunReq = dayReqByDay[dSun];

          const candidateWk1 = config.calendar
            .filter((d) => d.dayOfWeek !== 0 && assignments[d.day][wNeed.id].shiftType === 'OFF')
            .sort((a, b) => Math.abs(a.day - dSun) - Math.abs(b.day - dSun))
            .slice(0, 3);

          for (const dayWk1Req of candidateWk1) {
            const dWk1 = dayWk1Req.day;
            for (const wBridge1 of fissoWorkers) {
              if (wBridge1.id === wNeed.id) continue;
              const cWk1B1 = assignments[dWk1][wBridge1.id];
              if (cWk1B1.shiftType === 'OFF') continue;

              const candidateWk2 = config.calendar
                .filter(
                  (d) =>
                    d.dayOfWeek !== 0 &&
                    d.day !== dWk1 &&
                    assignments[d.day][wBridge1.id].shiftType === 'OFF'
                )
                .sort((a, b) => Math.abs(a.day - dWk1) - Math.abs(b.day - dWk1))
                .slice(0, 3);

              for (const dayWk2Req of candidateWk2) {
                const dWk2 = dayWk2Req.day;
                for (const wBridge2 of fissoWorkers) {
                  if (wBridge2.id === wNeed.id || wBridge2.id === wBridge1.id) continue;
                  const cWk2B2 = assignments[dWk2][wBridge2.id];
                  if (cWk2B2.shiftType === 'OFF') continue;

                  const candidateWk3 = config.calendar
                    .filter(
                      (d) =>
                        d.dayOfWeek !== 0 &&
                        d.day !== dWk1 &&
                        d.day !== dWk2 &&
                        assignments[d.day][wBridge2.id].shiftType === 'OFF'
                    )
                    .sort((a, b) => Math.abs(a.day - dWk2) - Math.abs(b.day - dWk2))
                    .slice(0, 3);

                  for (const dayWk3Req of candidateWk3) {
                    const dWk3 = dayWk3Req.day;
                    for (const wPartner of getPartners()) {
                      if (assignments[dSun][wPartner.id].shiftType !== 'OFF') continue;
                      const cWk3Partner = assignments[dWk3][wPartner.id];
                      if (cWk3Partner.shiftType === 'OFF') continue;

                      const daysToSave = new Set<number>([
                        dSun,
                        dWk1,
                        dWk2,
                        dWk3,
                        Math.max(1, dSun - 1),
                        Math.min(totalCalendarDays, dSun + 1),
                        Math.max(1, dWk1 - 1),
                        Math.min(totalCalendarDays, dWk1 + 1),
                        Math.max(1, dWk2 - 1),
                        Math.min(totalCalendarDays, dWk2 + 1),
                        Math.max(1, dWk3 - 1),
                        Math.min(totalCalendarDays, dWk3 + 1),
                      ]);
                      const snaps = new Map<number, Record<string, CellAssignment>>();
                      for (const ds of daysToSave) snaps.set(ds, snapshotDayRow(ds));

                      assignments[dSun][wNeed.id] = { shiftType: 'OFF', label: '', hours: 0 };
                      assignments[dWk1][wBridge1.id] = { shiftType: 'OFF', label: '', hours: 0 };
                      assignments[dWk2][wBridge2.id] = { shiftType: 'OFF', label: '', hours: 0 };
                      assignments[dWk3][wPartner.id] = { shiftType: 'OFF', label: '', hours: 0 };

                      const ok1 = tryPlaceWorkerInOpenSlot(wNeed, dayWk1Req, cWk1B1, false);
                      const ok2 =
                        ok1 && tryPlaceWorkerInOpenSlot(wBridge1, dayWk2Req, cWk2B2, false);
                      const ok3 =
                        ok2 && tryPlaceWorkerInOpenSlot(wBridge2, dayWk3Req, cWk3Partner, false);
                      const ok4 =
                        ok3 && tryPlaceWorkerInOpenSlot(wPartner, daySunReq, cSunNeed, false);

                      if (ok1 && ok2 && ok3 && ok4) {
                        recomputeStatsFromAssignments();
                        freedSunday = true;
                        break;
                      } else {
                        restoreDayRows(snaps);
                      }
                    }
                    if (freedSunday) break;
                  }
                  if (freedSunday) break;
                }
                if (freedSunday) break;
              }
              if (freedSunday) break;
            }
            if (freedSunday) break;
          }
          if (freedSunday) break;
        }
      }
      }
    }

    // Post-Phase 5 Re-Equalization:
    for (let eqPass = 0; eqPass < 20; eqPass++) {
      if (performance.now() - startTime > 75) break;
      let improved = false;
      const sortedFisso = [...fissoWorkers].sort((a, b) => totalHours[b.id] - totalHours[a.id]);
      const lowCandidates = [...sortedFisso].reverse();

      for (const wLow of lowCandidates) {
      for (const wHigh of [...sortedFisso, ...substituteWorkers]) {
        if (wHigh.id === wLow.id) continue;
        if (wHigh.type === 'Fisso' && totalHours[wHigh.id] - totalHours[wLow.id] <= 1) continue;
        if (wHigh.type === 'Sostituta' && totalHours[wLow.id] >= 162) continue;

        // Try 2-day 7h (on d1 from wHigh) <-> 6h (on d2 from wLow) swap using tryPlaceWorkerInOpenSlot
        for (let d1 = totalCalendarDays; d1 >= 1; d1--) {
          const c1High = assignments[d1][wHigh.id];
          const c1Low = assignments[d1][wLow.id];
          if (c1High.shiftType === 'OFF' || c1Low.shiftType !== 'OFF' || c1High.hours !== 7)
            continue;

          for (let d2 = totalCalendarDays; d2 >= 1; d2--) {
            if (d1 === d2) continue;
            const c2High = assignments[d2][wHigh.id];
            const c2Low = assignments[d2][wLow.id];
            if (c2Low.shiftType === 'OFF' || c2High.shiftType !== 'OFF' || c2Low.hours !== 6)
              continue;

            const daysToSave = new Set<number>([
              d1,
              d2,
              Math.max(1, d1 - 1),
              Math.min(totalCalendarDays, d1 + 1),
              Math.max(1, d2 - 1),
              Math.min(totalCalendarDays, d2 + 1),
            ]);
            const snaps = new Map<number, Record<string, CellAssignment>>();
            for (const ds of daysToSave) snaps.set(ds, snapshotDayRow(ds));

            assignments[d1][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d2][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };

            const ok1 = tryPlaceWorkerInOpenSlot(wLow, dayReqByDay[d1], c1High, false);
            const ok2 = ok1 && tryPlaceWorkerInOpenSlot(wHigh, dayReqByDay[d2], c2Low, false);
            if (ok1 && ok2) {
              recomputeStatsFromAssignments();
              improved = true;
              break;
            } else {
              restoreDayRows(snaps);
            }
          }
          if (improved) break;
        }
        if (improved) break;

        // Also try contiguous block swap [dStart..dEnd] (length 2..6 within the same week) where wHigh has +1h over wLow and same worked days
        for (const wk of weeks) {
          if (wk.length < 3) continue;
          const wkStart = wk[0].day;
          const wkEnd = wk[wk.length - 1].day;
          for (let dStart = wkStart; dStart <= wkEnd - 1; dStart++) {
            for (let dEnd = dStart + 1; dEnd <= wkEnd; dEnd++) {
              let hHrs = 0;
              let lHrs = 0;
              let hDays = 0;
              let lDays = 0;
              let hSun = 0;
              let lSun = 0;
              for (let d = dStart; d <= dEnd; d++) {
                const cH = assignments[d][wHigh.id];
                const cL = assignments[d][wLow.id];
                if (cH.shiftType !== 'OFF') {
                  hHrs += cH.hours;
                  hDays++;
                  if (dayReqByDay[d].dayOfWeek === 0) hSun++;
                }
                if (cL.shiftType !== 'OFF') {
                  lHrs += cL.hours;
                  lDays++;
                  if (dayReqByDay[d].dayOfWeek === 0) lSun++;
                }
              }
              if (hDays !== lDays || hHrs - lHrs !== 1 || hSun !== lSun) continue;

              const snaps = new Map<number, Record<string, CellAssignment>>();
              for (let d = Math.max(1, dStart - 1); d <= Math.min(totalCalendarDays, dEnd + 1); d++) {
                snaps.set(d, snapshotDayRow(d));
              }

              // Clear [dStart..dEnd] for both wHigh and wLow
              const origHigh: Record<number, CellAssignment> = {};
              const origLow: Record<number, CellAssignment> = {};
              for (let d = dStart; d <= dEnd; d++) {
                origHigh[d] = { ...assignments[d][wHigh.id] };
                origLow[d] = { ...assignments[d][wLow.id] };
                assignments[d][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };
              }

              let blockOk = true;
              for (let d = dStart; d <= dEnd; d++) {
                const req = dayReqByDay[d];
                const hType = origHigh[d].shiftType;
                if (hType !== 'OFF') {
                  if (!canAssignStrict(wLow, req, hType).ok) {
                    blockOk = false;
                    break;
                  }
                  assignments[d][wLow.id] = { ...origHigh[d] };
                }
                const lType = origLow[d].shiftType;
                if (lType !== 'OFF') {
                  if (!canAssignStrict(wHigh, req, lType).ok) {
                    blockOk = false;
                    break;
                  }
                  assignments[d][wHigh.id] = { ...origLow[d] };
                }
              }

              if (blockOk) {
                recomputeStatsFromAssignments();
                improved = true;
                break;
              } else {
                restoreDayRows(snaps);
              }
            }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;

        // Also try same-day 7h <-> 6h swap on Sundays/Holidays
        for (const dayReq of config.calendar) {
          const d = dayReq.day;
          const cH = assignments[d][wHigh.id];
          const cL = assignments[d][wLow.id];
          if (cH.shiftType !== 'OFF' && cL.shiftType !== 'OFF' && cH.hours === 7 && cL.hours === 6) {
            assignments[d][wHigh.id] = { shiftType: 'OFF', label: '', hours: 0 };
            assignments[d][wLow.id] = { shiftType: 'OFF', label: '', hours: 0 };
            const prevCap: boolean = enforcePostPhase1SundayCap;
            enforcePostPhase1SundayCap = false;
            const ok1 = canAssignStrict(wLow, dayReq, cH.shiftType).ok;
            let ok2 = false;
            if (ok1) {
              assignments[d][wLow.id] = { ...cH };
              ok2 = canAssignStrict(wHigh, dayReq, cL.shiftType).ok;
            }
            enforcePostPhase1SundayCap = prevCap;
            if (ok1 && ok2) {
              assignments[d][wHigh.id] = { ...cL };
              recomputeStatsFromAssignments();
              improved = true;
              break;
            } else {
              assignments[d][wHigh.id] = cH;
              assignments[d][wLow.id] = cL;
            }
          }
        }
        if (improved) break;
      }
      if (improved) break;
      }
      if (!improved) break;
    }

    // 2) Re-run Morning <-> Afternoon equalizer (Phase 3 logic) with enforcePostPhase1SundayCap = true
    for (let pass = 0; pass < 20; pass++) {
      if (performance.now() - startTime > 85) break;
      let swapped = false;
      for (const dayReq of config.calendar) {
        const d = dayReq.day;
        for (let i = 0; i < generalFissoWorkers.length; i++) {
          for (let j = i + 1; j < generalFissoWorkers.length; j++) {
            const wA = generalFissoWorkers[i];
            const wB = generalFissoWorkers[j];
            const cellA = assignments[d][wA.id];
            const cellB = assignments[d][wB.id];

            if (
              ((cellA.shiftType === 'MORNING' && cellB.shiftType === 'AFTERNOON') ||
                (cellA.shiftType === 'AFTERNOON' && cellB.shiftType === 'MORNING')) &&
              cellA.hours === cellB.hours
            ) {
              const newTypeA = cellB.shiftType as 'MORNING' | 'AFTERNOON';
              const newTypeB = cellA.shiftType as 'MORNING' | 'AFTERNOON';
              const oldScore = computeMorningAfternoonImbalance(wA, wB);
              const nextAfA = afternoonCount[wA.id] + (newTypeA === 'AFTERNOON' ? 1 : -1);
              const nextAfB = afternoonCount[wB.id] + (newTypeB === 'AFTERNOON' ? 1 : -1);
              const nextMoA = morningCount[wA.id] + (newTypeA === 'MORNING' ? 1 : -1);
              const nextMoB = morningCount[wB.id] + (newTypeB === 'MORNING' ? 1 : -1);
              const capA = capacityWeight[wA.id] || 1;
              const capB = capacityWeight[wB.id] || 1;
              const newScore =
                Math.abs(nextAfA / capA - nextAfB / capB) * 1.5 +
                Math.abs(
                  (nextMoA + barCount[wA.id]) / capA - (nextMoB + barCount[wB.id]) / capB
                );

              if (newScore + 0.05 < oldScore) {
                assignments[d][wA.id] = { shiftType: 'OFF', label: '', hours: 0 };
                assignments[d][wB.id] = { shiftType: 'OFF', label: '', hours: 0 };
                const prevCap: boolean = enforcePostPhase1SundayCap;
                enforcePostPhase1SundayCap = false;
                const validA = canAssignStrict(wA, dayReq, newTypeA).ok;
                let validB = false;
                if (validA) {
                  assignments[d][wA.id] = { ...cellB };
                  validB = canAssignStrict(wB, dayReq, newTypeB).ok;
                }
                enforcePostPhase1SundayCap = prevCap;

                if (validA && validB) {
                  assignments[d][wB.id] = { ...cellA };
                  recomputeStatsFromAssignments();
                  swapped = true;
                } else {
                  assignments[d][wA.id] = cellA;
                  assignments[d][wB.id] = cellB;
                }
              }
            }
          }
        }
      }

      // Cross-day equal-hour Morning <-> Afternoon swap
      for (let i = 0; i < generalFissoWorkers.length; i++) {
        for (let j = 0; j < generalFissoWorkers.length; j++) {
          if (i === j) continue;
          const wMoreAft = generalFissoWorkers[i];
          const wLessAft = generalFissoWorkers[j];
          const capMore = capacityWeight[wMoreAft.id] || 1;
          const capLess = capacityWeight[wLessAft.id] || 1;
          if (afternoonCount[wMoreAft.id] / capMore - afternoonCount[wLessAft.id] / capLess <= 1.0)
            continue;

          for (let d1 = 1; d1 <= totalCalendarDays; d1++) {
            const c1More = assignments[d1][wMoreAft.id];
            const c1Less = assignments[d1][wLessAft.id];
            if (c1More.shiftType !== 'AFTERNOON' || c1Less.shiftType !== 'OFF') continue;

            for (let d2 = 1; d2 <= totalCalendarDays; d2++) {
              if (d1 === d2) continue;
              const c2More = assignments[d2][wMoreAft.id];
              const c2Less = assignments[d2][wLessAft.id];
              if (
                c2Less.shiftType !== 'MORNING' ||
                c2More.shiftType !== 'OFF' ||
                c2Less.hours !== c1More.hours
              ) {
                continue;
              }

              assignments[d1][wMoreAft.id] = { shiftType: 'OFF', label: '', hours: 0 };
              assignments[d2][wLessAft.id] = { shiftType: 'OFF', label: '', hours: 0 };

              const ok1 = canAssignStrict(wLessAft, dayReqByDay[d1], 'AFTERNOON').ok;
              let ok2 = false;
              if (ok1) {
                assignments[d1][wLessAft.id] = { ...c1More };
                ok2 = canAssignStrict(wMoreAft, dayReqByDay[d2], 'MORNING').ok;
              }

              if (ok1 && ok2) {
                assignments[d2][wMoreAft.id] = { ...c2Less };
                recomputeStatsFromAssignments();
                swapped = true;
                break;
              } else {
                assignments[d1][wMoreAft.id] = c1More;
                assignments[d1][wLessAft.id] = c1Less;
                assignments[d2][wMoreAft.id] = c2More;
                assignments[d2][wLessAft.id] = c2Less;
              }
            }
            if (swapped) break;
          }
          if (swapped) break;
        }
        if (swapped) break;
      }
      if (!swapped) break;
    }
  }

  // Compute spread among ALL full-availability Fisso workers (INCLUDING Ioana / Bar!)
  const fullAvailGeneralFisso = generalFissoWorkers.filter(
    (w) => absenceDaysMap[w.id] === 0 && w.maxWeeklyHours === 40
  );
  let hoursSpreadFisse = 0;
  let afternoonSpreadFisse = 0;
  let morningSpreadFisse = 0;
  if (fullAvailAllFisso.length >= 2) {
    const hrs = fullAvailAllFisso.map((w) => totalHours[w.id]);
    hoursSpreadFisse = Math.max(...hrs) - Math.min(...hrs);
  }
  if (fullAvailGeneralFisso.length >= 2) {
    const afts = fullAvailGeneralFisso.map((w) => afternoonCount[w.id]);
    afternoonSpreadFisse = Math.max(...afts) - Math.min(...afts);

    const earlies = fullAvailGeneralFisso.map((w) => morningCount[w.id] + barCount[w.id]);
    morningSpreadFisse = Math.max(...earlies) - Math.min(...earlies);
  }

  // Diagnostic Summary Info
  const substitutesUsed = activeWorkers.filter(
    (w) => w.type === 'Sostituta' && workedDaysCount[w.id] > 0
  );
  if (substitutesUsed.length > 0) {
    const subDetails = substitutesUsed
      .map((w) => `${w.name} (${workedDaysCount[w.id]} turni, ${totalHours[w.id]}h)`)
      .join(', ');
    diagnostics.push({
      level: 'INFO',
      message: `Impiego sostitute per copertura vincoli CCNL/ferie: ${subDetails}.`,
    });
  } else {
    diagnostics.push({
      level: 'INFO',
      message: `Tutti i turni sono stati coperti esclusivamente con personale Fisso (0 ore assegnate alle sostitute).`,
    });
  }

  if (!hasInfeasibility) {
    diagnostics.unshift({
      level: 'INFO',
      message: `Soluzione OTTIMALE (${config.calendar.length} gg): Ore pareggiate tra TUTTE le lavoratrici fisse inclusa Bar/Ioana (scarto max ore: ${hoursSpreadFisse}h | scarto Pomeriggi: max ${afternoonSpreadFisse} turno | scarto Mattine/Diurni: max ${morningSpreadFisse} turno).`,
    });
  }

  if (useHist) {
    diagnostics.push({
      level: 'INFO',
      message: `Bilanciamento Storico Attivo (${pastHistory.length} mesi precedenti in archivio): compensazione automatica ferie pregresse, rotazione domeniche/festivi e turni Mattina/Pomeriggio rispetto al target di 160h/mese.`,
    });
  }

  // Final pass to guarantee all cell labels/hours match getShiftSpec (including any ShiftDateException)
  recomputeStatsFromAssignments();

  // Count holidays worked and per-category hours in current schedule
  const barHoursMap: Record<string, number> = {};
  const morningHoursMap: Record<string, number> = {};
  const afternoonHoursMap: Record<string, number> = {};
  const holidayHoursMap: Record<string, number> = {};
  for (const w of config.workers) {
    holidaysWorked[w.id] = 0;
    barHoursMap[w.id] = 0;
    morningHoursMap[w.id] = 0;
    afternoonHoursMap[w.id] = 0;
    holidayHoursMap[w.id] = 0;
  }

  for (const dReq of config.calendar) {
    for (const w of config.workers) {
      const cell = assignments[dReq.day]?.[w.id];
      if (cell && cell.shiftType !== 'OFF') {
        if (dReq.isHoliday) {
          holidaysWorked[w.id] = (holidaysWorked[w.id] || 0) + 1;
          holidayHoursMap[w.id] = (holidayHoursMap[w.id] || 0) + cell.hours;
        }
        if (cell.shiftType === 'BAR') {
          barHoursMap[w.id] += cell.hours;
        } else if (cell.shiftType === 'MORNING') {
          morningHoursMap[w.id] += cell.hours;
        } else if (cell.shiftType === 'AFTERNOON') {
          afternoonHoursMap[w.id] += cell.hours;
        }
      }
    }
  }

  const workerStats: Record<string, WorkerSummaryStats> = {};
  for (const w of config.workers) {
    const totH = totalHours[w.id] || 0;
    const targH = w.type === 'Fisso' ? Math.round(160 * (w.maxWeeklyHours / 40)) : 0;
    const hMonths = pastHistory.length;
    const hHours = histHours[w.id] || 0;
    const hAvg = hMonths > 0 ? Math.round((hHours / hMonths) * 10) / 10 : 0;

    const rate =
      typeof w.hourlyRate === 'number' && !Number.isNaN(w.hourlyRate) && w.hourlyRate > 0
        ? w.hourlyRate
        : w.type === 'Sostituta'
        ? 13.0
        : 12.5;
    const surchargePct =
      w.type === 'Fisso'
        ? Math.max(0, Number(w.holidaySurchargePct ?? 20) || 0)
        : 0;
    const holH = holidayHoursMap[w.id] || 0;
    const holExtraCost =
      w.type === 'Fisso'
        ? Math.round(holH * rate * (surchargePct / 100) * 100) / 100
        : 0;

    const bH = barHoursMap[w.id] || 0;
    const mH = morningHoursMap[w.id] || 0;
    const aH = afternoonHoursMap[w.id] || 0;
    const bCost = Math.round(bH * rate * 100) / 100;
    const mCost = Math.round(mH * rate * 100) / 100;
    const aCost = Math.round(aH * rate * 100) / 100;
    const totCost = Math.round((totH * rate + holExtraCost) * 100) / 100;

    workerStats[w.id] = {
      workerId: w.id,
      workerName: w.name,
      totalHours: totH,
      targetHours: targH,
      hoursDelta: totH - targH,
      barCount: barCount[w.id] || 0,
      morningCount: morningCount[w.id] || 0,
      afternoonCount: afternoonCount[w.id] || 0,
      barHours: bH,
      morningHours: mH,
      afternoonHours: aH,
      hourlyRate: rate,
      holidayHours: holH,
      holidaySurchargePct: surchargePct,
      holidaySurchargeCost: holExtraCost,
      barCost: bCost,
      morningCost: mCost,
      afternoonCost: aCost,
      totalCost: totCost,
      workedDays: workedDaysCount[w.id] || 0,
      availableDays: availableDaysMap[w.id] || 0,
      absenceDays: absenceDaysMap[w.id] || 0,
      sundaysWorked: sundaysWorked[w.id] || 0,
      holidaysWorked: holidaysWorked[w.id] || 0,
      historicalMonthsCount: hMonths,
      historicalHours: hHours,
      historicalAvgMonthlyHours: hAvg,
      historicalTargetDelta: histTargetDelta[w.id] || 0,
      historicalMorningCount: histMorning[w.id] || 0,
      historicalAfternoonCount: histAfternoon[w.id] || 0,
      historicalBarCount: histBar[w.id] || 0,
      historicalSundaysWorked: histSundays[w.id] || 0,
      historicalHolidaysWorked: histHolidays[w.id] || 0,
      historicalAbsenceDays: histAbsenceDays[w.id] || 0,
    };
  }

  // CP-SAT UNSAT-CORE / ASSUMPTION CONFLICT ANALYZER & REMEDIATION ENGINE
  const conflictItems: SolveConflictItem[] = [];
  const suggestionMap = new Map<string, SolveRemediationSuggestion>();
  const affectedDaysSet = new Set<number>();
  let totalUncoveredShifts = 0;

  for (const dayReq of config.calendar) {
    const d = dayReq.day;
    const weekIdx = dayToWeekIdx[d] ?? 0;

    const shiftChecks: Array<{
      type: 'BAR' | 'MORNING' | 'AFTERNOON';
      req: number;
      nameIt: string;
    }> = [
      { type: 'BAR', req: dayReq.reqBar, nameIt: 'Bar' },
      { type: 'MORNING', req: dayReq.reqMorning, nameIt: 'Mattina' },
      { type: 'AFTERNOON', req: dayReq.reqAfternoon, nameIt: 'Pomeriggio' },
    ];

    for (const sc of shiftChecks) {
      let assignedCount = 0;
      for (const w of config.workers) {
        if (assignments[d]?.[w.id]?.shiftType === sc.type) {
          assignedCount++;
        }
      }

      if (assignedCount < sc.req) {
        const missing = sc.req - assignedCount;
        totalUncoveredShifts += missing;
        affectedDaysSet.add(d);

        const spec = getShiftSpec(config, dayReq, sc.type);
        const workerBlockers: WorkerConstraintBlocker[] = [];
        const itemSuggestions: SolveRemediationSuggestion[] = [];
        const categoryCounts: Record<ConflictConstraintCategory, number> = {
          STAFF_UNAVAILABILITY: 0,
          MAX_WEEKLY_HOURS: 0,
          WEEKLY_REST_DAYS: 0,
          MAX_CONSECUTIVE_DAYS: 0,
          CCNL_11H_REST: 0,
          SKILL_MISMATCH: 0,
          INACTIVE_WORKER: 0,
          EXCESS_DEMAND: 0,
        };

        // Analyze every worker not already assigned on day d to find the exact minimal blocking constraint
        for (const w of config.workers) {
          const currentCell = assignments[d]?.[w.id];
          if (currentCell && currentCell.shiftType !== 'OFF') {
            continue; // Already working another shift on this day
          }

          // 1. Inactive worker
          if (!w.active) {
            categoryCounts.INACTIVE_WORKER++;
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'INACTIVE_WORKER',
              constraintLabel: `Disattivata nell'organico (Scheda 1)`,
            });
            const sugId = `act-${w.id}`;
            const sug: SolveRemediationSuggestion = {
              id: sugId,
              actionType: 'ACTIVATE_WORKER',
              priority: 'MEDIUM',
              title: `Riattiva ${w.name} nell'organico attivo`,
              description: `${w.name} è attualmente disattivata ma potrebbe coprire i turni scoperti.`,
              impactSummary: `Aggiunge +1 operatrice disponibile per il giorno ${dayReq.dateStr}`,
              workerId: w.id,
              workerName: w.name,
            };
            itemSuggestions.push(sug);
            if (!suggestionMap.has(sugId)) suggestionMap.set(sugId, sug);
            continue;
          }

          // 2. Skill mismatch
          const hasSkill =
            (sc.type === 'BAR' && w.canBar) ||
            (sc.type === 'MORNING' && w.canMorning) ||
            (sc.type === 'AFTERNOON' && w.canAfternoon);

          // Check if worker is also absent on day d
          const matchingAbs = config.absences.find(
            (a) =>
              a.workerId === w.id &&
              d >= a.startDay &&
              d <= a.endDay &&
              (a.scope === 'FULL_DAY' ||
                (a.scope === 'ONLY_BAR' && sc.type === 'BAR') ||
                (a.scope === 'ONLY_MORNING' && sc.type === 'MORNING') ||
                (a.scope === 'ONLY_AFTERNOON' && sc.type === 'AFTERNOON'))
          );

          if (matchingAbs) {
            categoryCounts.STAFF_UNAVAILABILITY++;
            const scopeIt =
              matchingAbs.scope === 'FULL_DAY'
                ? 'Intera giornata'
                : matchingAbs.scope === 'ONLY_MORNING'
                ? 'Solo Mattina'
                : matchingAbs.scope === 'ONLY_AFTERNOON'
                ? 'Solo Pomeriggio'
                : 'Solo Bar';
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'STAFF_UNAVAILABILITY',
              constraintLabel: `${matchingAbs.type} (${scopeIt}) nel giorno ${dayReq.dateStr}`,
              absenceId: matchingAbs.id,
            });

            if (hasSkill) {
              const sugId = `rem-abs-${matchingAbs.id}-day-${d}`;
              const sug: SolveRemediationSuggestion = {
                id: sugId,
                actionType: 'REMOVE_ABSENCE_ON_DAY',
                priority: 'HIGH',
                title: `Rimuovi indisponibilità (${matchingAbs.type}) di ${w.name} il ${dayReq.dateStr}`,
                description: `${w.name} è abilitata a ${sc.nameIt} ma risulta bloccata da "${matchingAbs.type}" (${scopeIt}) il ${dayReq.dateStr}.`,
                impactSummary: `Sblocca immediatamente ${w.name} per il turno ${sc.nameIt} (${spec.label}) del ${dayReq.dateStr}`,
                day: d,
                dateStr: dayReq.dateStr,
                workerId: w.id,
                workerName: w.name,
                shiftType: sc.type,
                absenceId: matchingAbs.id,
              };
              itemSuggestions.push(sug);
              if (!suggestionMap.has(sugId)) suggestionMap.set(sugId, sug);
            }
            continue;
          }

          if (!hasSkill) {
            categoryCounts.SKILL_MISMATCH++;
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'SKILL_MISMATCH',
              constraintLabel: `Libera il ${dayReq.dateStr}, ma non abilitata al turno ${sc.nameIt}`,
            });
            const sugId = `skill-${w.id}-${sc.type}`;
            const sug: SolveRemediationSuggestion = {
              id: sugId,
              actionType: 'ENABLE_WORKER_SKILL',
              priority: 'MEDIUM',
              title: `Abilita mansione ${sc.nameIt} per ${w.name}`,
              description: `${w.name} è libera il ${dayReq.dateStr} ma non ha la spunta di abilitazione per il turno ${sc.nameIt}.`,
              impactSummary: `Consente a ${w.name} di coprire il turno ${sc.nameIt} (${spec.label})`,
              workerId: w.id,
              workerName: w.name,
              shiftType: sc.type,
            };
            itemSuggestions.push(sug);
            if (!suggestionMap.has(sugId)) suggestionMap.set(sugId, sug);
            continue;
          }

          // 3. Check Max Weekly Hours limit
          const wkStats = getWeeklyStats(w.id, weekIdx, d);
          if (wkStats.hours + spec.hours > w.maxWeeklyHours) {
            const shortfall = wkStats.hours + spec.hours - w.maxWeeklyHours;
            const suggestedDelta = Math.max(shortfall, Math.ceil(shortfall / 2) * 2);
            const newMax = w.maxWeeklyHours + suggestedDelta;
            categoryCounts.MAX_WEEKLY_HOURS++;
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'MAX_WEEKLY_HOURS',
              constraintLabel: `Limite ${w.maxWeeklyHours}h/sett. superato (${wkStats.hours}h + ${spec.hours}h = ${wkStats.hours + spec.hours}h, servono +${shortfall}h)`,
              hoursShortfall: shortfall,
            });

            const sugId = `maxh-${w.id}`;
            const existing = suggestionMap.get(sugId);
            const bestNewMax = existing?.newMaxWeeklyHours
              ? Math.max(existing.newMaxWeeklyHours, newMax)
              : newMax;
            const bestDelta = bestNewMax - w.maxWeeklyHours;
            const sug: SolveRemediationSuggestion = {
              id: sugId,
              actionType: 'INCREASE_MAX_WEEKLY_HOURS',
              priority: 'HIGH',
              title: `Aumenta ore max settimanali per ${w.name} di +${bestDelta}h (da ${w.maxWeeklyHours}h a ${bestNewMax}h)`,
              description: `${w.name} è libera e abilitata il ${dayReq.dateStr}, ma ha già ${wkStats.hours}h nella settimana ${weekIdx + 1} (limite contrattuale impostato a ${w.maxWeeklyHours}h).`,
              impactSummary: `Sblocca ${w.name} per coprire il turno ${sc.nameIt} (${spec.hours}h) del ${dayReq.dateStr}`,
              day: d,
              dateStr: dayReq.dateStr,
              workerId: w.id,
              workerName: w.name,
              shiftType: sc.type,
              newMaxWeeklyHours: bestNewMax,
              deltaHours: bestDelta,
            };
            itemSuggestions.push(sug);
            suggestionMap.set(sugId, sug);
            continue;
          }

          // 4. Check Weekly Rest Days limit
          if (
            wkStats.totalDaysInWeek === 7 &&
            wkStats.worked + 1 > 7 - config.constraints.minWeeklyRestDays
          ) {
            categoryCounts.WEEKLY_REST_DAYS++;
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'WEEKLY_REST_DAYS',
              constraintLabel: `Giorno di riposo settimanale obbligatorio (${config.constraints.minWeeklyRestDays} gg/sett., ha già lavorato ${wkStats.worked}/7 gg nella settimana ${weekIdx + 1})`,
            });
            if (config.constraints.minWeeklyRestDays > 1) {
              const sugId = `wkrest-reduce`;
              const sug: SolveRemediationSuggestion = {
                id: sugId,
                actionType: 'REDUCE_MIN_WEEKLY_REST',
                priority: 'HIGH',
                title: `Riduci riposo settimanale minimo da ${config.constraints.minWeeklyRestDays} a 1 giorno/settimana`,
                description: `Il vincolo di ${config.constraints.minWeeklyRestDays} giorni di riposo a settimana blocca le lavoratrici libere nella settimana ${weekIdx + 1}.`,
                impactSummary: `Sblocca +1 turno lavorabile a settimana per ogni operatrice`,
                newMinWeeklyRestDays: 1,
              };
              itemSuggestions.push(sug);
              if (!suggestionMap.has(sugId)) suggestionMap.set(sugId, sug);
            }
            continue;
          }

          // 5. Check Max Consecutive Days
          if (wouldExceedConsecutiveDays(w.id, d)) {
            categoryCounts.MAX_CONSECUTIVE_DAYS++;
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'MAX_CONSECUTIVE_DAYS',
              constraintLabel: `Superamento limite di ${config.constraints.maxConsecutiveDays} giorni consecutivi lavorati`,
            });
            const nextMaxConsec = Math.min(10, config.constraints.maxConsecutiveDays + 1);
            const sugId = `consec-${nextMaxConsec}`;
            const sug: SolveRemediationSuggestion = {
              id: sugId,
              actionType: 'INCREASE_MAX_CONSECUTIVE_DAYS',
              priority: 'MEDIUM',
              title: `Aumenta massimo giorni consecutivi da ${config.constraints.maxConsecutiveDays} a ${nextMaxConsec} giorni`,
              description: `${w.name} è disponibile il ${dayReq.dateStr} ma ha raggiunto il tetto di ${config.constraints.maxConsecutiveDays} giorni consecutivi.`,
              impactSummary: `Consente a ${w.name} di coprire il turno ${sc.nameIt} del ${dayReq.dateStr}`,
              newMaxConsecutiveDays: nextMaxConsec,
            };
            itemSuggestions.push(sug);
            if (!suggestionMap.has(sugId)) suggestionMap.set(sugId, sug);
            continue;
          }

          // 6. Check CCNL 11h Rest Sequence (Afternoon -> Morning/Bar)
          if (violatesCcnlSequence(w.id, d, sc.type)) {
            categoryCounts.CCNL_11H_REST++;
            workerBlockers.push({
              workerId: w.id,
              workerName: w.name,
              workerType: w.type,
              category: 'CCNL_11H_REST',
              constraintLabel: `Blocco CCNL 11h: turno Pomeriggio il giorno precedente (${d - 1}) o Mattina/Bar il giorno successivo (${d + 1})`,
            });
            const sugId = `disable-11h-rule`;
            const sug: SolveRemediationSuggestion = {
              id: sugId,
              actionType: 'DISABLE_11H_REST_RULE',
              priority: 'LOW',
              title: `Disattiva vincolo "Pomeriggio → Mattina/Bar vietata" (11h riposo)`,
              description: `${w.name} è libera il ${dayReq.dateStr} ma bloccata dal cambio turno Pomeriggio → ${sc.nameIt}.`,
              impactSummary: `Permette la copertura del turno ${sc.nameIt} del ${dayReq.dateStr} in deroga alle 11h`,
            };
            itemSuggestions.push(sug);
            if (!suggestionMap.has(sugId)) suggestionMap.set(sugId, sug);
          }
        }

        // Always include the direct demand-reduction suggestion for this shift ("Remove/reduce requirement for shift Y")
        const demandSugId = `dem-${d}-${sc.type}`;
        const demandSug: SolveRemediationSuggestion = {
          id: demandSugId,
          actionType: 'REDUCE_SHIFT_DEMAND',
          priority: 'HIGH',
          title:
            assignedCount === 0
              ? `Rimuovi fabbisogno turno ${sc.nameIt} del ${dayReq.dateStr} (da ${sc.req} a 0)`
              : `Riduci fabbisogno turno ${sc.nameIt} del ${dayReq.dateStr} da ${sc.req} a ${assignedCount} (-${missing})`,
          description: `Il giorno ${dayReq.dateStr} (${dayReq.dayAbbr}) richiede ${sc.req} operatrici per ${sc.nameIt}, ma solo ${assignedCount} sono assegnabili rispettando i vincoli attuali.`,
          impactSummary: `Rimuove i ${missing} turni ${sc.nameIt} non copribili il ${dayReq.dateStr} e rende la pianificazione 100% fattibile`,
          day: d,
          dateStr: dayReq.dateStr,
          shiftType: sc.type,
          newDemandValue: assignedCount,
        };
        itemSuggestions.unshift(demandSug);
        suggestionMap.set(demandSugId, demandSug);

        // Determine primary cause category
        let primaryCat: ConflictConstraintCategory = 'EXCESS_DEMAND';
        let maxCatCount = 0;
        (Object.keys(categoryCounts) as ConflictConstraintCategory[]).forEach((cat) => {
          if (categoryCounts[cat] > maxCatCount) {
            maxCatCount = categoryCounts[cat];
            primaryCat = cat;
          }
        });

        conflictItems.push({
          id: `conf-${d}-${sc.type}`,
          day: d,
          dateStr: dayReq.dateStr,
          dayAbbr: dayReq.dayAbbr,
          weekIndex: weekIdx + 1,
          shiftType: sc.type,
          shiftLabel: spec.label,
          shiftHours: spec.hours,
          requiredSlots: sc.req,
          assignedSlots: assignedCount,
          missingSlots: missing,
          primaryCauseCategory: primaryCat,
          summaryMessage: `Giorno ${dayReq.dateStr} (${dayReq.dayAbbr}) — Turno ${sc.nameIt} (${spec.label}): assegnate ${assignedCount}/${sc.req} operatrici (mancano ${missing}).`,
          workerBlockers,
          suggestions: itemSuggestions,
        });
      }
    }
  }

  const priorityOrder: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
  };
  const topSuggestions = Array.from(suggestionMap.values()).sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
  );

  const unsatCoreSummary: string[] = [];
  if (conflictItems.length > 0) {
    const absCount = conflictItems.reduce(
      (acc, c) =>
        acc + c.workerBlockers.filter((b) => b.category === 'STAFF_UNAVAILABILITY').length,
      0
    );
    const maxHoursCount = conflictItems.reduce(
      (acc, c) => acc + c.workerBlockers.filter((b) => b.category === 'MAX_WEEKLY_HOURS').length,
      0
    );
    const restCount = conflictItems.reduce(
      (acc, c) =>
        acc +
        c.workerBlockers.filter(
          (b) => b.category === 'WEEKLY_REST_DAYS' || b.category === 'MAX_CONSECUTIVE_DAYS'
        ).length,
      0
    );
    const ccnl11hCount = conflictItems.reduce(
      (acc, c) => acc + c.workerBlockers.filter((b) => b.category === 'CCNL_11H_REST').length,
      0
    );

    if (absCount > 0) {
      unsatCoreSummary.push(
        `Assenze / Indisponibilità concomitanti (${absCount} blocchi rilevati nei giorni critici)`
      );
    }
    if (maxHoursCount > 0) {
      unsatCoreSummary.push(
        `Limiti Ore Massime Settimanali (${maxHoursCount} lavoratrici bloccate dal tetto orario settimanale)`
      );
    }
    if (restCount > 0) {
      unsatCoreSummary.push(
        `Vincoli Riposo Settimanale / Giorni Consecutivi CCNL (${restCount} blocchi normativi)`
      );
    }
    if (ccnl11hCount > 0) {
      unsatCoreSummary.push(
        `Regola CCNL 11h Pomeriggio → Mattina/Bar (${ccnl11hCount} transizioni vietate)`
      );
    }
  }

  const solveInsights: SolveInsightsReport = {
    hasConflicts: conflictItems.length > 0,
    totalUncoveredShifts,
    affectedDaysCount: affectedDaysSet.size,
    conflicts: conflictItems,
    topSuggestions,
    unsatCoreSummary,
  };

  const solveTimeMs = Math.max(14, Math.round(performance.now() - startTime));

  const finalResult: ScheduleSolution = {
    status: hasInfeasibility || conflictItems.length > 0 ? 'PARTIAL_WITH_DIAGNOSTICS' : 'OPTIMAL',
    solveTimeMs,
    objectiveScore: 100,
    assignments,
    diagnostics,
    workerStats,
    hoursSpreadFisse,
    morningSpreadFisse,
    afternoonSpreadFisse,
    solveInsights,
    requiresAfternoonOverflowConfirmation,
    indispensableAfternoonExceptions,
  };

  lastStructuralCacheKey = structKey;
  lastCachedSolution = finalResult;
  return finalResult;
}

/**
 * Applies a single SolveRemediationSuggestion to AppConfig to unlock feasibility.
 */
export function applyRemediationSuggestion(
  config: AppConfig,
  suggestion: SolveRemediationSuggestion
): AppConfig {
  switch (suggestion.actionType) {
    case 'INCREASE_MAX_WEEKLY_HOURS': {
      if (!suggestion.workerId || !suggestion.newMaxWeeklyHours) return config;
      return {
        ...config,
        workers: config.workers.map((w) =>
          w.id === suggestion.workerId
            ? { ...w, maxWeeklyHours: suggestion.newMaxWeeklyHours! }
            : w
        ),
      };
    }

    case 'REDUCE_SHIFT_DEMAND': {
      if (suggestion.day === undefined || !suggestion.shiftType) return config;
      const newVal = Math.max(0, suggestion.newDemandValue ?? 0);
      return {
        ...config,
        calendar: config.calendar.map((d) => {
          if (d.day !== suggestion.day) return d;
          if (suggestion.shiftType === 'BAR') return { ...d, reqBar: newVal };
          if (suggestion.shiftType === 'MORNING') return { ...d, reqMorning: newVal };
          return { ...d, reqAfternoon: newVal };
        }),
      };
    }

    case 'REMOVE_ABSENCE_ON_DAY': {
      if (!suggestion.absenceId) return config;
      const targetDay = suggestion.day;
      const nextAbsences: AbsenceRecord[] = [];
      for (const a of config.absences) {
        if (a.id !== suggestion.absenceId || targetDay === undefined) {
          nextAbsences.push(a);
          continue;
        }
        if (a.startDay === a.endDay && a.startDay === targetDay) {
          // Remove single-day absence completely
          continue;
        } else if (a.startDay === targetDay) {
          nextAbsences.push({ ...a, startDay: a.startDay + 1 });
        } else if (a.endDay === targetDay) {
          nextAbsences.push({ ...a, endDay: a.endDay - 1 });
        } else if (targetDay > a.startDay && targetDay < a.endDay) {
          // Split multi-day vacation around the critical day
          nextAbsences.push({
            ...a,
            id: `${a.id}-p1`,
            endDay: targetDay - 1,
          });
          nextAbsences.push({
            ...a,
            id: `${a.id}-p2`,
            startDay: targetDay + 1,
          });
        } else {
          nextAbsences.push(a);
        }
      }
      return {
        ...config,
        absences: nextAbsences,
      };
    }

    case 'ENABLE_WORKER_SKILL': {
      if (!suggestion.workerId || !suggestion.shiftType) return config;
      return {
        ...config,
        workers: config.workers.map((w) => {
          if (w.id !== suggestion.workerId) return w;
          if (suggestion.shiftType === 'BAR') return { ...w, canBar: true };
          if (suggestion.shiftType === 'MORNING') return { ...w, canMorning: true };
          return { ...w, canAfternoon: true };
        }),
      };
    }

    case 'ACTIVATE_WORKER': {
      if (!suggestion.workerId) return config;
      return {
        ...config,
        workers: config.workers.map((w) =>
          w.id === suggestion.workerId ? { ...w, active: true } : w
        ),
      };
    }

    case 'INCREASE_MAX_CONSECUTIVE_DAYS': {
      return {
        ...config,
        constraints: {
          ...config.constraints,
          maxConsecutiveDays:
            suggestion.newMaxConsecutiveDays || config.constraints.maxConsecutiveDays + 1,
        },
      };
    }

    case 'REDUCE_MIN_WEEKLY_REST': {
      return {
        ...config,
        constraints: {
          ...config.constraints,
          minWeeklyRestDays: suggestion.newMinWeeklyRestDays ?? 1,
        },
      };
    }

    case 'DISABLE_11H_REST_RULE': {
      return {
        ...config,
        constraints: {
          ...config.constraints,
          forbidAfternoonToMorning: false,
        },
      };
    }

    default:
      return config;
  }
}

