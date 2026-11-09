export type WorkerRoleType = 'Fisso' | 'Sostituta';

export interface Worker {
  /**
   * Immutable sequential numeric primary key represented as string ("1", "2", "3", ... "N").
   * Never changes when the worker's display name (`name`) is modified.
   */
  id: string;
  numericId?: number; // 1, 2, 3, ... N
  name: string;
  type: WorkerRoleType;
  priority: number; // 0 for Fisso; 1..5 for Sostituta (1=Massima, 4=Minima, 5=Non considerare)
  canBar: boolean;
  canMorning: boolean;
  canAfternoon: boolean;
  maxWeeklyHours: number;
  hourlyRate: number; // Costo orario lordo/retribuito (€/h), es. 12.50
  holidaySurchargePct?: number; // Maggiorazione % per ore lavorate nei giorni festivi (solo Fisse), es. 20 = +20%
  active: boolean;
}

export type DayBand = 'MON_WED' | 'THU_SAT' | 'SUN_HOL';

export interface ShiftBandConfig {
  label: string; // e.g., "6-12"
  hours: number; // e.g., 6
}

export interface ShiftScheduleConfig {
  bar: Record<DayBand, ShiftBandConfig>;
  morning: Record<DayBand, ShiftBandConfig>;
  afternoon: Record<DayBand, ShiftBandConfig>;
}

/**
 * Eccezione oraria di calendario per un giorno specifico e un turno specifico
 * (es. 03-nov-2026, solo Turno Mattina -> orario "7-12", 5 ore invece di "7-13", 6 ore).
 */
export interface ShiftDateException {
  id: string;
  day: number; // Sequential day index 1..N
  dateStr: string; // e.g., "03-nov"
  isoDate?: string; // e.g., "2026-11-03"
  shiftType: 'BAR' | 'MORNING' | 'AFTERNOON';
  label: string; // e.g., "7-12"
  hours: number; // e.g., 5
  note?: string;
}

export interface DailyRequirement {
  day: number; // Sequential index 1..N across the selected period
  isoDate?: string; // "2026-11-01"
  dateStr: string; // "01-nov", "01-dic"
  dayOfWeek: number; // 0=Dom, 1=Lun, ..., 6=Sab
  dayAbbr: string; // "Dom", "Lun", etc.
  reqBar: number;
  reqMorning: number;
  reqAfternoon: number;
  isHoliday: boolean;
}

export type AbsenceType =
  | 'Ferie'
  | 'Malattia'
  | 'Permesso ROL'
  | 'Riposo richiesto'
  | 'Indisponibilità generica';

export type AbsenceScope =
  | 'FULL_DAY'
  | 'ONLY_MORNING'
  | 'ONLY_AFTERNOON'
  | 'ONLY_BAR';

export interface AbsenceRecord {
  id: string;
  workerId: string; // References Worker.id (immutable numeric ID "1", "2", ...)
  startDay: number; // Sequential day index 1..N
  endDay: number;   // Sequential day index 1..N
  type: AbsenceType;
  scope: AbsenceScope;
  note?: string;
}

export interface CcnlConstraints {
  forbidAfternoonToMorning: boolean; // Vietato Pomeriggio -> Mattina/Bar (11h riposo)
  maxConsecutiveDays: number;        // Default 6
  maxConsecutiveAfternoons?: number; // Default 3 (Hard limit: non più di 3 pomeriggi consecutivi)
  preferredConsecutiveAfternoons?: number; // Default 2 (Soft target: preferibilmente 2 pomeriggi consecutivi)
  allowEmergencyAfternoonOverflow?: boolean; // Se true, l'utente ha confermato l'eccezione >3 pomeriggi ove indispensabile
  minWeeklyRestDays: number;         // Default 1 (Lun-Dom)
  weightMorningAfternoonBalance: number; // 1..5
  weightSundayRotation: number;          // 1..5
  weightMonthlyHoursEquity: number;      // 1..5
  useHistoricalEquity?: boolean;         // Tiene conto dello storico confermato (domeniche, festivi, mattine/pomeriggi, ore)
}

export type PeriodMode = 'MONTHLY' | 'CUSTOM_RANGE';

export type AssignedShiftType = 'BAR' | 'MORNING' | 'AFTERNOON' | 'OFF';

export interface CellAssignment {
  shiftType: AssignedShiftType;
  label: string; // e.g. "6-12", "7-13", "14-20", or ""
  hours: number; // e.g. 6, 7, or 0
}

export interface DiagnosticMessage {
  level: 'INFO' | 'WARNING' | 'ERROR';
  day?: number;
  dateStr?: string;
  message: string;
}

export interface WorkerSummaryStats {
  workerId: string; // Immutable numeric ID ("1", "2", ...)
  workerName: string;
  totalHours: number;
  targetHours: number;
  hoursDelta: number;
  barCount: number;
  morningCount: number;
  afternoonCount: number;
  barHours: number;
  morningHours: number;
  afternoonHours: number;
  hourlyRate: number;
  holidayHours?: number; // Ore lavorate in giornate festive (isHoliday === true)
  holidaySurchargePct?: number; // % maggiorazione festivi (solo Fisse)
  holidaySurchargeCost?: number; // Quota extra (€) derivante dalla maggiorazione festivi
  barCost: number;
  morningCost: number;
  afternoonCost: number;
  totalCost: number;
  workedDays: number;
  availableDays: number;
  absenceDays: number;
  sundaysWorked: number;
  holidaysWorked?: number;
  // Historical cumulative metrics (from past confirmed schedules in localStorage / File System)
  historicalMonthsCount?: number;
  historicalHours?: number;
  historicalAvgMonthlyHours?: number;
  historicalTargetDelta?: number; // Cumulative delta vs 160h/month target across past months
  historicalMorningCount?: number;
  historicalAfternoonCount?: number;
  historicalBarCount?: number;
  historicalSundaysWorked?: number;
  historicalHolidaysWorked?: number;
  historicalAbsenceDays?: number;
}

export interface HistoricalWorkerStats {
  workerId: string; // Immutable numeric ID ("1", "2", ...)
  workerName: string;
  totalHours: number;
  targetHours?: number;
  barCount: number;
  morningCount: number;
  afternoonCount: number;
  barHours?: number;
  morningHours?: number;
  afternoonHours?: number;
  hourlyRate?: number;
  holidayHours?: number;
  holidaySurchargePct?: number;
  holidaySurchargeCost?: number;
  totalCost?: number;
  workedDays: number;
  absenceDays?: number;
  sundaysWorked: number;
  holidaysWorked: number;
}

export interface ConfirmedScheduleEntry {
  id: string;
  confirmedAt: string; // ISO timestamp
  periodLabel: string; // e.g. "Novembre 2026 (01-nov – 30-nov)"
  customRangeLabel?: string; // e.g. "01/11/2026 - 30/11/2026"
  month: number;
  year: number;
  numDays: number;
  calendar?: DailyRequirement[];
  shiftConfig?: ShiftScheduleConfig;
  shiftExceptions?: ShiftDateException[];
  assignments?: Record<number, Record<string, CellAssignment>>;
  workerStats: Record<string, HistoricalWorkerStats>;
}

export interface PreSolverDayIssue {
  day: number;
  dateStr: string;
  dayAbbr: string;
  severity: 'CRITICAL' | 'WARNING';
  shiftType?: 'BAR' | 'MORNING' | 'AFTERNOON' | 'TOTAL';
  required: number;
  available: number;
  availableNames: string[];
  blockedDetails: string[];
  message: string;
}

export interface PreSolverValidationResult {
  isMathematicallyFeasible: boolean;
  criticalCount: number;
  warningCount: number;
  issues: PreSolverDayIssue[];
}

export interface AppConfig {
  month: number; // 1..12 (11 = Novembre)
  year: number;  // e.g., 2026
  periodMode?: PeriodMode;
  customStartDate?: string; // YYYY-MM-DD
  customEndDate?: string;   // YYYY-MM-DD
  extraDaysAfterMonth?: number; // e.g., 0..14 days into next month
  workers: Worker[];
  shiftConfig: ShiftScheduleConfig;
  shiftExceptions?: ShiftDateException[];
  calendar: DailyRequirement[];
  absences: AbsenceRecord[];
  constraints: CcnlConstraints;
  history?: ConfirmedScheduleEntry[];
}

export type ConflictConstraintCategory =
  | 'STAFF_UNAVAILABILITY'
  | 'MAX_WEEKLY_HOURS'
  | 'WEEKLY_REST_DAYS'
  | 'MAX_CONSECUTIVE_DAYS'
  | 'CCNL_11H_REST'
  | 'SKILL_MISMATCH'
  | 'INACTIVE_WORKER'
  | 'EXCESS_DEMAND';

export interface WorkerConstraintBlocker {
  workerId: string;
  workerName: string;
  workerType: WorkerRoleType;
  category: ConflictConstraintCategory;
  constraintLabel: string; // e.g., "Limite 36h/settimana raggiunto (34h + 6h > 36h)"
  absenceId?: string;
  hoursShortfall?: number; // e.g. 4 means +4h needed on maxWeeklyHours
}

export type RemediationActionType =
  | 'INCREASE_MAX_WEEKLY_HOURS'
  | 'REDUCE_SHIFT_DEMAND'
  | 'REMOVE_ABSENCE_ON_DAY'
  | 'CONVERT_ABSENCE_TO_PARTIAL'
  | 'ENABLE_WORKER_SKILL'
  | 'ACTIVATE_WORKER'
  | 'INCREASE_MAX_CONSECUTIVE_DAYS'
  | 'REDUCE_MIN_WEEKLY_REST'
  | 'DISABLE_11H_REST_RULE';

export interface SolveRemediationSuggestion {
  id: string;
  actionType: RemediationActionType;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string; // e.g. "Increase max weekly hours for Sabrina by 4h (36h → 40h)"
  description: string; // Explains why this unlocks feasibility
  impactSummary: string; // e.g. "Sblocca 1 turno Mattina il 14-nov senza usare sostitute"
  day?: number;
  dateStr?: string;
  workerId?: string;
  workerName?: string;
  shiftType?: 'BAR' | 'MORNING' | 'AFTERNOON';
  newMaxWeeklyHours?: number;
  deltaHours?: number;
  newDemandValue?: number;
  absenceId?: string;
  newAbsenceScope?: AbsenceScope;
  newMaxConsecutiveDays?: number;
  newMinWeeklyRestDays?: number;
}

export interface SolveConflictItem {
  id: string;
  day: number;
  dateStr: string;
  dayAbbr: string;
  weekIndex: number;
  shiftType: 'BAR' | 'MORNING' | 'AFTERNOON';
  shiftLabel: string; // "6-12", "7-13", "14-20"
  shiftHours: number;
  requiredSlots: number;
  assignedSlots: number;
  missingSlots: number;
  primaryCauseCategory: ConflictConstraintCategory;
  summaryMessage: string;
  workerBlockers: WorkerConstraintBlocker[];
  suggestions: SolveRemediationSuggestion[];
}

export interface SolveInsightsReport {
  hasConflicts: boolean;
  totalUncoveredShifts: number;
  affectedDaysCount: number;
  conflicts: SolveConflictItem[];
  topSuggestions: SolveRemediationSuggestion[];
  unsatCoreSummary: string[];
}

export interface IndispensableAfternoonException {
  day: number;
  dateStr: string;
  dayAbbr: string;
  workerId: string;
  workerName: string;
  consecutiveCount: number;
}

export interface ScheduleSolution {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'PARTIAL_WITH_DIAGNOSTICS';
  solveTimeMs: number;
  objectiveScore: number;
  // assignments[day][workerId]
  assignments: Record<number, Record<string, CellAssignment>>;
  diagnostics: DiagnosticMessage[];
  workerStats: Record<string, WorkerSummaryStats>;
  hoursSpreadFisse: number; // Max - Min hours among full-availability Fisso workers
  morningSpreadFisse: number; // Max - Min morning shifts among non-Ioana Fisso workers
  afternoonSpreadFisse: number; // Max - Min afternoon shifts among non-Ioana Fisso workers
  solveInsights: SolveInsightsReport;
  requiresAfternoonOverflowConfirmation?: boolean;
  indispensableAfternoonExceptions?: IndispensableAfternoonException[];
}
