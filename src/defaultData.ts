import { AppConfig, ConfirmedScheduleEntry, DailyRequirement, Worker } from './types';

export const ITALIAN_MONTHS = [
  { value: 1, name: 'Gennaio', abbr: 'gen' },
  { value: 2, name: 'Febbraio', abbr: 'feb' },
  { value: 3, name: 'Marzo', abbr: 'mar' },
  { value: 4, name: 'Aprile', abbr: 'apr' },
  { value: 5, name: 'Maggio', abbr: 'mag' },
  { value: 6, name: 'Giugno', abbr: 'giu' },
  { value: 7, name: 'Luglio', abbr: 'lug' },
  { value: 8, name: 'Agosto', abbr: 'ago' },
  { value: 9, name: 'Settembre', abbr: 'set' },
  { value: 10, name: 'Ottobre', abbr: 'ott' },
  { value: 11, name: 'Novembre', abbr: 'nov' },
  { value: 12, name: 'Dicembre', abbr: 'dic' },
];

export const ITALIAN_DAYS_ABBR = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

/**
 * Legacy-to-Numeric ID migration map so any previously saved profile in localStorage or JSON
 * upgrades seamlessly to sequential numeric primary keys ("1" .. "10") without losing renamed names or relations.
 */
export const LEGACY_WORKER_ID_MAP: Record<string, string> = {
  'w-ioana': '1',
  'w-sabrina': '2',
  'w-ilaria': '3',
  'w-elena': '4',
  'w-maria': '5',
  'w-giulia': '6',
  'w-anna': '7',
  'w-francesca': '8',
  'w-caterina': '9',
  'w-patrizia': '10',
};

export function getNextWorkerNumericId(workers: Worker[]): string {
  let maxId = 0;
  for (const w of workers) {
    const parsed = parseInt(String(w.id), 10);
    if (!Number.isNaN(parsed) && parsed > maxId) {
      maxId = parsed;
    } else if (w.numericId && w.numericId > maxId) {
      maxId = w.numericId;
    }
  }
  return String(maxId + 1);
}

function isItalianNationalHoliday(month: number, dayOfMonth: number): boolean {
  if (month === 1 && (dayOfMonth === 1 || dayOfMonth === 6)) return true;
  if (month === 4 && dayOfMonth === 25) return true;
  if (month === 5 && dayOfMonth === 1) return true;
  if (month === 6 && dayOfMonth === 2) return true;
  if (month === 8 && dayOfMonth === 15) return true;
  if (month === 11 && dayOfMonth === 1) return true;
  if (month === 12 && (dayOfMonth === 8 || dayOfMonth === 25 || dayOfMonth === 26)) return true;
  return false;
}

function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getMonthDateBounds(
  month: number,
  year: number,
  extraDaysAfterMonth = 0
): { startDate: string; endDate: string } {
  const start = new Date(year, month - 1, 1);
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const end = new Date(year, month - 1, lastDayOfMonth + Math.max(0, extraDaysAfterMonth));
  return {
    startDate: formatIsoDate(start),
    endDate: formatIsoDate(end),
  };
}

/**
 * Generates a sequential calendar across any arbitrary date range (single month or cross-month / multi-week).
 */
export function generateCalendarFromDateRange(
  startIso: string,
  endIso: string,
  defaultBar = 1,
  defaultMorning = 4,
  defaultAfternoon = 2,
  existingCalendar?: DailyRequirement[]
): DailyRequirement[] {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);

  const startDate = new Date(sy || 2026, (sm || 11) - 1, sd || 1);
  const endDate = new Date(ey || 2026, (em || 11) - 1, ed || 30);

  if (endDate < startDate) {
    return generateCalendarFromDateRange(
      startIso,
      startIso,
      defaultBar,
      defaultMorning,
      defaultAfternoon
    );
  }

  const existingMap = new Map<string, DailyRequirement>();
  if (existingCalendar) {
    for (const item of existingCalendar) {
      if (item.isoDate) existingMap.set(item.isoDate, item);
      existingMap.set(item.dateStr, item);
    }
  }

  const calendar: DailyRequirement[] = [];
  const curr = new Date(startDate);
  let seqIndex = 1;

  while (curr <= endDate && seqIndex <= 90) {
    const m = curr.getMonth() + 1;
    const dom = curr.getDate();
    const dow = curr.getDay();
    const monthObj = ITALIAN_MONTHS.find((x) => x.value === m) || ITALIAN_MONTHS[10];
    const dateStr = dom < 10 ? `0${dom}-${monthObj.abbr}` : `${dom}-${monthObj.abbr}`;
    const isoDate = formatIsoDate(curr);

    const prev = existingMap.get(isoDate) || existingMap.get(dateStr);

    calendar.push({
      day: seqIndex,
      isoDate,
      dateStr,
      dayOfWeek: dow,
      dayAbbr: ITALIAN_DAYS_ABBR[dow],
      reqBar: prev ? prev.reqBar : defaultBar,
      reqMorning: prev ? prev.reqMorning : defaultMorning,
      reqAfternoon: prev ? prev.reqAfternoon : defaultAfternoon,
      isHoliday: prev ? prev.isHoliday : isItalianNationalHoliday(m, dom),
    });

    curr.setDate(curr.getDate() + 1);
    seqIndex++;
  }

  return calendar;
}

export function generateCalendarForMonth(
  month: number,
  year: number,
  defaultBar = 1,
  defaultMorning = 4,
  defaultAfternoon = 2,
  extraDaysAfterMonth = 0,
  existingCalendar?: DailyRequirement[]
): DailyRequirement[] {
  const { startDate, endDate } = getMonthDateBounds(month, year, extraDaysAfterMonth);
  return generateCalendarFromDateRange(
    startDate,
    endDate,
    defaultBar,
    defaultMorning,
    defaultAfternoon,
    existingCalendar
  );
}

export function formatPeriodLabel(config: AppConfig): string {
  if (!config.calendar || config.calendar.length === 0) {
    const mObj = ITALIAN_MONTHS.find((m) => m.value === config.month) || ITALIAN_MONTHS[10];
    return `${mObj.name} ${config.year}`;
  }
  const first = config.calendar[0];
  const last = config.calendar[config.calendar.length - 1];
  const mObj = ITALIAN_MONTHS.find((m) => m.value === config.month) || ITALIAN_MONTHS[10];

  if (
    config.periodMode === 'CUSTOM_RANGE' ||
    (config.extraDaysAfterMonth && config.extraDaysAfterMonth > 0)
  ) {
    return `${first.dateStr} → ${last.dateStr} ${config.year} (${config.calendar.length} gg)`;
  }
  return `${mObj.name} ${config.year} (${first.dateStr} – ${last.dateStr})`;
}

/**
 * Default Workers with Immutable Sequential Numeric IDs ("1" .. "10")
 * and Configurable Hourly Rates (€/h).
 */
export const DEFAULT_WORKERS: Worker[] = [
  {
    id: '1',
    numericId: 1,
    name: 'Ioana',
    type: 'Fisso',
    priority: 0,
    canBar: true,
    canMorning: false,
    canAfternoon: false,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '2',
    numericId: 2,
    name: 'Sabrina',
    type: 'Fisso',
    priority: 0,
    canBar: true,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '3',
    numericId: 3,
    name: 'Ilaria',
    type: 'Fisso',
    priority: 0,
    canBar: true,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '4',
    numericId: 4,
    name: 'Elena',
    type: 'Fisso',
    priority: 0,
    canBar: false,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '5',
    numericId: 5,
    name: 'Maria',
    type: 'Fisso',
    priority: 0,
    canBar: false,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '6',
    numericId: 6,
    name: 'Giulia',
    type: 'Fisso',
    priority: 0,
    canBar: false,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '7',
    numericId: 7,
    name: 'Anna',
    type: 'Fisso',
    priority: 0,
    canBar: false,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '8',
    numericId: 8,
    name: 'Francesca',
    type: 'Fisso',
    priority: 0,
    canBar: false,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 12.5,
    holidaySurchargePct: 20,
    active: true,
  },
  {
    id: '9',
    numericId: 9,
    name: 'Caterina',
    type: 'Sostituta',
    priority: 1,
    canBar: false,
    canMorning: true,
    canAfternoon: false,
    maxWeeklyHours: 40,
    hourlyRate: 13.0,
    holidaySurchargePct: 0,
    active: true,
  },
  {
    id: '10',
    numericId: 10,
    name: 'SIG.RA PATRIZIA',
    type: 'Sostituta',
    priority: 2,
    canBar: false,
    canMorning: true,
    canAfternoon: true,
    maxWeeklyHours: 40,
    hourlyRate: 13.0,
    holidaySurchargePct: 0,
    active: true,
  },
];

export const DEFAULT_HISTORY: ConfirmedScheduleEntry[] = [
  {
    id: 'hist-2026-08',
    confirmedAt: '2026-08-31T18:00:00.000Z',
    periodLabel: 'Agosto 2026 (01-ago – 31-ago)',
    customRangeLabel: '01/08/2026 - 31/08/2026',
    month: 8,
    year: 2026,
    numDays: 31,
    workerStats: {
      '1': {
        workerId: '1',
        workerName: 'Ioana',
        totalHours: 158,
        targetHours: 160,
        barCount: 24,
        morningCount: 0,
        afternoonCount: 0,
        workedDays: 24,
        absenceDays: 2,
        sundaysWorked: 4,
        holidaysWorked: 1,
      },
      '2': {
        workerId: '2',
        workerName: 'Sabrina',
        totalHours: 164,
        targetHours: 160,
        barCount: 4,
        morningCount: 13,
        afternoonCount: 8,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 1,
      },
      '3': {
        workerId: '3',
        workerName: 'Ilaria',
        totalHours: 152,
        targetHours: 160,
        barCount: 3,
        morningCount: 12,
        afternoonCount: 8,
        workedDays: 23,
        absenceDays: 3,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '4': {
        workerId: '4',
        workerName: 'Elena',
        totalHours: 165,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 1,
      },
      '5': {
        workerId: '5',
        workerName: 'Maria',
        totalHours: 146,
        targetHours: 160,
        barCount: 0,
        morningCount: 14,
        afternoonCount: 8,
        workedDays: 22,
        absenceDays: 4,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '6': {
        workerId: '6',
        workerName: 'Giulia',
        totalHours: 163,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 1,
      },
      '7': {
        workerId: '7',
        workerName: 'Anna',
        totalHours: 160,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 8,
        workedDays: 24,
        absenceDays: 1,
        sundaysWorked: 3,
        holidaysWorked: 1,
      },
      '8': {
        workerId: '8',
        workerName: 'Francesca',
        totalHours: 154,
        targetHours: 160,
        barCount: 0,
        morningCount: 15,
        afternoonCount: 8,
        workedDays: 23,
        absenceDays: 2,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '9': {
        workerId: '9',
        workerName: 'Caterina',
        totalHours: 78,
        targetHours: 0,
        barCount: 0,
        morningCount: 12,
        afternoonCount: 0,
        workedDays: 12,
        absenceDays: 0,
        sundaysWorked: 2,
        holidaysWorked: 1,
      },
      '10': {
        workerId: '10',
        workerName: 'SIG.RA PATRIZIA',
        totalHours: 52,
        targetHours: 0,
        barCount: 0,
        morningCount: 4,
        afternoonCount: 4,
        workedDays: 8,
        absenceDays: 0,
        sundaysWorked: 2,
        holidaysWorked: 1,
      },
    },
  },
  {
    id: 'hist-2026-09',
    confirmedAt: '2026-09-30T18:00:00.000Z',
    periodLabel: 'Settembre 2026 (01-set – 30-set)',
    customRangeLabel: '01/09/2026 - 30/09/2026',
    month: 9,
    year: 2026,
    numDays: 30,
    workerStats: {
      '1': {
        workerId: '1',
        workerName: 'Ioana',
        totalHours: 162,
        targetHours: 160,
        barCount: 25,
        morningCount: 0,
        afternoonCount: 0,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '2': {
        workerId: '2',
        workerName: 'Sabrina',
        totalHours: 150,
        targetHours: 160,
        barCount: 3,
        morningCount: 12,
        afternoonCount: 8,
        workedDays: 23,
        absenceDays: 2,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '3': {
        workerId: '3',
        workerName: 'Ilaria',
        totalHours: 163,
        targetHours: 160,
        barCount: 2,
        morningCount: 14,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '4': {
        workerId: '4',
        workerName: 'Elena',
        totalHours: 156,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 8,
        workedDays: 24,
        absenceDays: 1,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '5': {
        workerId: '5',
        workerName: 'Maria',
        totalHours: 164,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '6': {
        workerId: '6',
        workerName: 'Giulia',
        totalHours: 151,
        targetHours: 160,
        barCount: 0,
        morningCount: 15,
        afternoonCount: 8,
        workedDays: 23,
        absenceDays: 2,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '7': {
        workerId: '7',
        workerName: 'Anna',
        totalHours: 162,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '8': {
        workerId: '8',
        workerName: 'Francesca',
        totalHours: 163,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '9': {
        workerId: '9',
        workerName: 'Caterina',
        totalHours: 58,
        targetHours: 0,
        barCount: 0,
        morningCount: 9,
        afternoonCount: 0,
        workedDays: 9,
        absenceDays: 0,
        sundaysWorked: 2,
        holidaysWorked: 0,
      },
      '10': {
        workerId: '10',
        workerName: 'SIG.RA PATRIZIA',
        totalHours: 39,
        targetHours: 0,
        barCount: 0,
        morningCount: 4,
        afternoonCount: 2,
        workedDays: 6,
        absenceDays: 0,
        sundaysWorked: 1,
        holidaysWorked: 0,
      },
    },
  },
  {
    id: 'hist-2026-10',
    confirmedAt: '2026-10-31T18:00:00.000Z',
    periodLabel: 'Ottobre 2026 (01-ott – 31-ott)',
    customRangeLabel: '01/10/2026 - 31/10/2026',
    month: 10,
    year: 2026,
    numDays: 31,
    workerStats: {
      '1': {
        workerId: '1',
        workerName: 'Ioana',
        totalHours: 163,
        targetHours: 160,
        barCount: 25,
        morningCount: 0,
        afternoonCount: 0,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '2': {
        workerId: '2',
        workerName: 'Sabrina',
        totalHours: 162,
        targetHours: 160,
        barCount: 3,
        morningCount: 13,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '3': {
        workerId: '3',
        workerName: 'Ilaria',
        totalHours: 164,
        targetHours: 160,
        barCount: 3,
        morningCount: 14,
        afternoonCount: 8,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '4': {
        workerId: '4',
        workerName: 'Elena',
        totalHours: 158,
        targetHours: 160,
        barCount: 0,
        morningCount: 15,
        afternoonCount: 9,
        workedDays: 24,
        absenceDays: 1,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '5': {
        workerId: '5',
        workerName: 'Maria',
        totalHours: 165,
        targetHours: 160,
        barCount: 0,
        morningCount: 17,
        afternoonCount: 8,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '6': {
        workerId: '6',
        workerName: 'Giulia',
        totalHours: 162,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '7': {
        workerId: '7',
        workerName: 'Anna',
        totalHours: 156,
        targetHours: 160,
        barCount: 0,
        morningCount: 15,
        afternoonCount: 9,
        workedDays: 24,
        absenceDays: 1,
        sundaysWorked: 3,
        holidaysWorked: 0,
      },
      '8': {
        workerId: '8',
        workerName: 'Francesca',
        totalHours: 161,
        targetHours: 160,
        barCount: 0,
        morningCount: 16,
        afternoonCount: 9,
        workedDays: 25,
        absenceDays: 0,
        sundaysWorked: 4,
        holidaysWorked: 0,
      },
      '9': {
        workerId: '9',
        workerName: 'Caterina',
        totalHours: 59,
        targetHours: 0,
        barCount: 0,
        morningCount: 9,
        afternoonCount: 0,
        workedDays: 9,
        absenceDays: 0,
        sundaysWorked: 2,
        holidaysWorked: 0,
      },
      '10': {
        workerId: '10',
        workerName: 'SIG.RA PATRIZIA',
        totalHours: 38,
        targetHours: 0,
        barCount: 0,
        morningCount: 3,
        afternoonCount: 3,
        workedDays: 6,
        absenceDays: 0,
        sundaysWorked: 1,
        holidaysWorked: 0,
      },
    },
  },
];

export const INITIAL_APP_CONFIG: AppConfig = {
  month: 11,
  year: 2026,
  periodMode: 'MONTHLY',
  customStartDate: '2026-11-01',
  customEndDate: '2026-11-30',
  extraDaysAfterMonth: 0,
  workers: DEFAULT_WORKERS,
  shiftConfig: {
    bar: {
      MON_WED: { label: '6-12', hours: 6 },
      THU_SAT: { label: '6-13', hours: 7 },
      SUN_HOL: { label: '6-13', hours: 7 },
    },
    morning: {
      MON_WED: { label: '7-13', hours: 6 },
      THU_SAT: { label: '7-14', hours: 7 },
      SUN_HOL: { label: '7-14', hours: 7 },
    },
    afternoon: {
      MON_WED: { label: '14-20', hours: 6 },
      THU_SAT: { label: '14-21', hours: 7 },
      SUN_HOL: { label: '14-20', hours: 6 },
    },
  },
  shiftExceptions: [],
  calendar: generateCalendarForMonth(11, 2026, 1, 4, 2, 0),
  absences: [],
  constraints: {
    forbidAfternoonToMorning: true,
    maxConsecutiveDays: 6,
    maxConsecutiveAfternoons: 3,
    preferredConsecutiveAfternoons: 2,
    minWeeklyRestDays: 1,
    weightMorningAfternoonBalance: 5,
    weightSundayRotation: 4,
    weightMonthlyHoursEquity: 5,
    useHistoricalEquity: true,
  },
  history: DEFAULT_HISTORY,
};

export const LOCAL_STORAGE_CONFIG_KEY = 'turni_donne_pulizie_rt_config_v1';
export const LOCAL_STORAGE_HISTORY_KEY = 'turni_donne_pulizie_rt_history_v1';

/**
 * Normalizes and migrates any AppConfig (from localStorage or external JSON file) so that:
 * 1. Every worker has an immutable sequential numeric ID ("1", "2", ... "N") and `numericId: number`.
 * 2. Every worker has a valid `hourlyRate` (default 12.50 €/h for Fisso, 13.00 €/h for Sostituta).
 * 3. All internal foreign keys (`absences.workerId`, `history.workerStats`, `history.assignments`)
 *    reference the numeric ID.
 */
export function normalizeAndMigrateAppConfig(raw: Partial<AppConfig>): AppConfig {
  const idTranslation = new Map<string, string>(Object.entries(LEGACY_WORKER_ID_MAP));
  const rawWorkers = Array.isArray(raw.workers) && raw.workers.length > 0 ? raw.workers : DEFAULT_WORKERS;

  const usedNumericIds = new Set<number>();
  let nextCandidate = 1;

  const migratedWorkers: Worker[] = rawWorkers.map((w, idx) => {
    const oldId = String(w.id ?? idx + 1);
    let mappedId = idTranslation.get(oldId) || oldId;
    let numId = /^\d+$/.test(mappedId) ? parseInt(mappedId, 10) : NaN;

    if (Number.isNaN(numId) || numId <= 0 || usedNumericIds.has(numId)) {
      while (usedNumericIds.has(nextCandidate)) {
        nextCandidate++;
      }
      numId = nextCandidate;
      mappedId = String(numId);
    }

    usedNumericIds.add(numId);
    idTranslation.set(oldId, mappedId);

    const defaultRate = w.type === 'Sostituta' ? 13.0 : 12.5;
    const rate =
      typeof w.hourlyRate === 'number' && !Number.isNaN(w.hourlyRate) && w.hourlyRate > 0
        ? w.hourlyRate
        : defaultRate;

    const normalizedPriority =
      w.type === 'Sostituta'
        ? Math.min(5, Math.max(1, Math.round(Number(w.priority) || 1)))
        : 0;

    const defaultSurcharge = w.type === 'Fisso' ? 20 : 0;
    const surchargePct =
      w.type === 'Fisso'
        ? typeof w.holidaySurchargePct === 'number' &&
          !Number.isNaN(w.holidaySurchargePct) &&
          w.holidaySurchargePct >= 0
          ? w.holidaySurchargePct
          : defaultSurcharge
        : 0;

    return {
      ...w,
      id: mappedId,
      numericId: numId,
      priority: normalizedPriority,
      hourlyRate: rate,
      holidaySurchargePct: surchargePct,
    };
  });

  const workerNameById = new Map<string, string>(
    migratedWorkers.map((w) => [w.id, w.name])
  );

  const migratedAbsences = (Array.isArray(raw.absences) ? raw.absences : []).map((a) => {
    const newWId = idTranslation.get(String(a.workerId)) || String(a.workerId);
    return {
      ...a,
      workerId: newWId,
    };
  });

  const rawHistory =
    Array.isArray(raw.history) && raw.history.length > 0 ? raw.history : DEFAULT_HISTORY;

  const migratedHistory: ConfirmedScheduleEntry[] = rawHistory.map((entry) => {
    const newWorkerStats: ConfirmedScheduleEntry['workerStats'] = {};
    if (entry.workerStats && typeof entry.workerStats === 'object') {
      for (const [k, stat] of Object.entries(entry.workerStats)) {
        const mappedWId = idTranslation.get(k) || idTranslation.get(String(stat.workerId)) || String(k);
        newWorkerStats[mappedWId] = {
          ...stat,
          workerId: mappedWId,
          // Keep current worker name synced via immutable numeric ID while preserving historical record
          workerName: workerNameById.get(mappedWId) || stat.workerName,
        };
      }
    }

    let newAssignments = entry.assignments;
    if (entry.assignments && typeof entry.assignments === 'object') {
      newAssignments = {};
      for (const [dayKey, dayMap] of Object.entries(entry.assignments)) {
        const dNum = Number(dayKey);
        newAssignments[dNum] = {};
        if (dayMap && typeof dayMap === 'object') {
          for (const [wKey, cell] of Object.entries(dayMap)) {
            const mappedWId = idTranslation.get(wKey) || wKey;
            newAssignments[dNum][mappedWId] = cell;
          }
        }
      }
    }

    return {
      ...entry,
      workerStats: newWorkerStats,
      assignments: newAssignments,
    };
  });

  return {
    ...INITIAL_APP_CONFIG,
    ...raw,
    workers: migratedWorkers,
    shiftConfig: raw.shiftConfig || INITIAL_APP_CONFIG.shiftConfig,
    shiftExceptions: Array.isArray(raw.shiftExceptions) ? raw.shiftExceptions : [],
    calendar:
      Array.isArray(raw.calendar) && raw.calendar.length > 0
        ? raw.calendar
        : INITIAL_APP_CONFIG.calendar,
    absences: migratedAbsences,
    constraints: {
      ...INITIAL_APP_CONFIG.constraints,
      ...(raw.constraints || {}),
      maxConsecutiveAfternoons: Math.min(
        3,
        Math.max(2, Number(raw.constraints?.maxConsecutiveAfternoons) || 3)
      ),
      preferredConsecutiveAfternoons: Math.min(
        3,
        Math.max(1, Number(raw.constraints?.preferredConsecutiveAfternoons) || 2)
      ),
    },
    history: migratedHistory,
  };
}

export function loadPersistedAppConfig(): AppConfig {
  if (typeof window === 'undefined') return INITIAL_APP_CONFIG;
  try {
    const rawConfig = window.localStorage.getItem(LOCAL_STORAGE_CONFIG_KEY);
    const rawHistory = window.localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY);
    let parsedHistory = DEFAULT_HISTORY;
    if (rawHistory) {
      const h = JSON.parse(rawHistory);
      if (Array.isArray(h) && h.length > 0) {
        parsedHistory = h;
      }
    }
    if (rawConfig) {
      const parsed = JSON.parse(rawConfig) as Partial<AppConfig>;
      if (parsed && Array.isArray(parsed.workers) && Array.isArray(parsed.calendar)) {
        return normalizeAndMigrateAppConfig({
          ...parsed,
          history:
            Array.isArray(parsed.history) && parsed.history.length > 0
              ? parsed.history
              : parsedHistory,
        });
      }
    }
    return normalizeAndMigrateAppConfig({
      ...INITIAL_APP_CONFIG,
      history: parsedHistory,
    });
  } catch {
    return INITIAL_APP_CONFIG;
  }
}

export function savePersistedAppConfig(config: AppConfig): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized = normalizeAndMigrateAppConfig(config);
    window.localStorage.setItem(LOCAL_STORAGE_CONFIG_KEY, JSON.stringify(normalized));
    if (Array.isArray(normalized.history)) {
      window.localStorage.setItem(
        LOCAL_STORAGE_HISTORY_KEY,
        JSON.stringify(normalized.history)
      );
    }
  } catch {
    // Ignore storage quota errors
  }
}
