import React, { useState, useMemo, useRef, useEffect, useDeferredValue } from 'react';
import {
  Users,
  Clock,
  Calendar,
  UserX,
  Sliders,
  Play,
  FileSpreadsheet,
  Image as ImageIcon,
  Download,
  Upload,
  Plus,
  Trash2,
  Code2,
  CheckCircle2,
  AlertTriangle,
  Info,
  RotateCcw,
  Edit3,
  Scale,
  CalendarRange,
  ShieldAlert,
  History,
  Euro,
  Save,
} from 'lucide-react';
import {
  AbsenceRecord,
  AbsenceScope,
  AbsenceType,
  AppConfig,
  ConfirmedScheduleEntry,
  DayBand,
  PeriodMode,
  ShiftDateException,
  SolveRemediationSuggestion,
  Worker,
  WorkerRoleType,
} from './types';
import {
  formatPeriodLabel,
  generateCalendarForMonth,
  generateCalendarFromDateRange,
  getMonthDateBounds,
  getNextWorkerNumericId,
  INITIAL_APP_CONFIG,
  ITALIAN_MONTHS,
  loadPersistedAppConfig,
  normalizeAndMigrateAppConfig,
  savePersistedAppConfig,
} from './defaultData';
import {
  applyRemediationSuggestion,
  getDayBand,
  solveWorkforceSchedule,
} from './services/solverEngine';
import { exportScheduleToExcel } from './services/excelExporter';
import { exportScheduleToJpeg } from './services/imageExporter';
import { SchedulePaperTable } from './components/SchedulePaperTable';
import { PythonDeliverableView } from './components/PythonDeliverableView';
import { HistoricalAnalyticsSection } from './components/HistoricalAnalyticsSection';
import { ScheduleHistoryTab } from './components/ScheduleHistoryTab';
import { EconomicAnalysisSection } from './components/EconomicAnalysisSection';
import { SolveInsightsModal } from './components/SolveInsightsModal';
import { GlobalTooltipSystem } from './components/GlobalTooltipSystem';
import {
  GuideTabKey,
  HelpGuideButton,
  TabHelpModal,
} from './components/TabHelpModal';
import {
  HighlightedScheduleTarget,
  ScheduleConflictInspector,
} from './components/ScheduleConflictInspector';
import { HOTEL_LOGO_DATA_URI, HOTEL_LOGO_PATH } from './hotelLogoAsset';
import { getShiftSpec } from './services/solverEngine';
import { downloadPythonWindowsSuiteZip } from './services/pythonSuiteGenerator';

type ActiveTab =
  | 'TAB_1_STAFF'
  | 'TAB_2_SHIFTS'
  | 'TAB_3_CALENDAR'
  | 'TAB_4_ABSENCES'
  | 'TAB_5_CCNL'
  | 'TAB_6_SOLVE'
  | 'TAB_HISTORY'
  | 'TAB_ECONOMICS'
  | 'TAB_7_WINDOWS_CODE';

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => loadPersistedAppConfig());
  const deferredConfig = useDeferredValue(config);
  const [isBooting, setIsBooting] = useState<boolean>(true);
  const [bootProgress, setBootProgress] = useState<number>(25);
  const [bootStepLabel, setBootStepLabel] = useState<string>(
    'Caricamento configurazione e anagrafica lavoratrici...'
  );

  const [activeTab, setActiveTab] = useState<ActiveTab>('TAB_6_SOLVE');
  const [isSolving, setIsSolving] = useState(false);
  const [isInsightsModalOpen, setIsInsightsModalOpen] = useState(false);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [activeGuideKey, setActiveGuideKey] = useState<GuideTabKey>('TAB_6_SOLVE');
  const [highlightedTarget, setHighlightedTarget] =
    useState<HighlightedScheduleTarget | null>(null);
  const [manualCellOverrides, setManualCellOverrides] = useState<
    Record<number, Record<string, 'OFF' | 'BAR' | 'MORNING' | 'AFTERNOON'>>
  >({});
  const [lastAutoSaveTime, setLastAutoSaveTime] = useState<string>(() =>
    new Date().toLocaleTimeString('it-IT')
  );

  // Progressive Startup Sequence so initial paint is instant and smooth
  useEffect(() => {
    let cancelled = false;
    const t1 = window.setTimeout(() => {
      if (cancelled) return;
      setBootProgress(55);
      setBootStepLabel('Lettura archivio storico turni e rotazione domeniche...');
    }, 90);

    const t2 = window.setTimeout(() => {
      if (cancelled) return;
      setBootProgress(85);
      setBootStepLabel('Calcolo turnazione ottimale e verifica vincoli CCNL...');
    }, 200);

    const t3 = window.setTimeout(() => {
      if (cancelled) return;
      // Warm up solver cache right before completing boot
      solveWorkforceSchedule(config);
      setBootProgress(100);
      setBootStepLabel('Avvio completato!');
    }, 320);

    const t4 = window.setTimeout(() => {
      if (cancelled) return;
      setIsBooting(false);
    }, 460);

    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenGuide = (key: GuideTabKey) => {
    setActiveGuideKey(key);
    setIsHelpModalOpen(true);
  };

  // Debounced auto-save to localStorage (250ms) + flush on page unload to eliminate synchronous JSON.stringify freezes on every keystroke
  const latestConfigRef = useRef<AppConfig>(config);
  latestConfigRef.current = config;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      savePersistedAppConfig(config);
      setLastAutoSaveTime(new Date().toLocaleTimeString('it-IT'));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      savePersistedAppConfig(latestConfigRef.current);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Compute optimized schedule reactively using deferredConfig (and structural caching for instant name/rate edits)
  const baseSolution = useMemo(
    () => solveWorkforceSchedule(deferredConfig),
    [deferredConfig]
  );

  // Apply any manual cell edits on top of the solver's base solution so real-time conflict inspection works
  const solution = useMemo(() => {
    if (Object.keys(manualCellOverrides).length === 0) return baseSolution;
    const clonedAssignments: typeof baseSolution.assignments = {};
    for (const dayReq of config.calendar) {
      const d = dayReq.day;
      clonedAssignments[d] = { ...(baseSolution.assignments[d] || {}) };
      const dayOverrides = manualCellOverrides[d];
      if (dayOverrides) {
        for (const [wId, sType] of Object.entries(dayOverrides)) {
          if (sType === 'OFF') {
            clonedAssignments[d][wId] = { shiftType: 'OFF', label: '', hours: 0 };
          } else {
            const spec = getShiftSpec(config, dayReq, sType);
            clonedAssignments[d][wId] = {
              shiftType: sType,
              label: spec.label,
              hours: spec.hours,
            };
          }
        }
      }
    }
    return {
      ...baseSolution,
      assignments: clonedAssignments,
    };
  }, [baseSolution, manualCellOverrides, config]);

  const [isAfternoonOverflowModalOpen, setIsAfternoonOverflowModalOpen] = useState(false);
  const [pendingManualAfternoon, setPendingManualAfternoon] = useState<{
    day: number;
    dateStr: string;
    workerId: string;
    workerName: string;
    consecutiveCount: number;
  } | null>(null);

  const handleManualCellChange = (
    day: number,
    workerId: string,
    newShiftType: 'OFF' | 'BAR' | 'MORNING' | 'AFTERNOON'
  ) => {
    if (newShiftType === 'AFTERNOON') {
      const maxAllowed = Math.min(3, Math.max(2, config.constraints.maxConsecutiveAfternoons ?? 3));
      const totalDays = config.calendar.length;
      let streak = 1;
      let d = day - 1;
      while (d >= 1 && solution.assignments[d]?.[workerId]?.shiftType === 'AFTERNOON') {
        streak++;
        d--;
      }
      d = day + 1;
      while (d <= totalDays && solution.assignments[d]?.[workerId]?.shiftType === 'AFTERNOON') {
        streak++;
        d++;
      }
      if (streak > maxAllowed) {
        const wObj = config.workers.find((w) => w.id === workerId);
        const dayObj = config.calendar.find((c) => c.day === day);
        setPendingManualAfternoon({
          day,
          dateStr: dayObj ? `${dayObj.dateStr} (${dayObj.dayAbbr})` : `Giorno ${day}`,
          workerId,
          workerName: wObj?.name || `ID #${workerId}`,
          consecutiveCount: streak,
        });
        return;
      }
    }

    setManualCellOverrides((prev) => ({
      ...prev,
      [day]: {
        ...(prev[day] || {}),
        [workerId]: newShiftType,
      },
    }));
  };

  // Auto-open confirmation modal if solver detects that >3 consecutive afternoons is indispensable for coverage
  useEffect(() => {
    if (
      solution.requiresAfternoonOverflowConfirmation &&
      solution.indispensableAfternoonExceptions &&
      solution.indispensableAfternoonExceptions.length > 0
    ) {
      setIsAfternoonOverflowModalOpen(true);
    }
  }, [
    solution.requiresAfternoonOverflowConfirmation,
    solution.indispensableAfternoonExceptions?.length,
  ]);

  // Auto-open Solve Insights modal whenever the optimizer detects infeasible constraints
  useEffect(() => {
    if (solution.solveInsights.hasConflicts && !solution.requiresAfternoonOverflowConfirmation) {
      setIsInsightsModalOpen(true);
    }
  }, [
    solution.solveInsights.hasConflicts,
    solution.solveInsights.totalUncoveredShifts,
    solution.requiresAfternoonOverflowConfirmation,
  ]);

  // New Worker Form State
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerType, setNewWorkerType] = useState<WorkerRoleType>('Fisso');
  const [newWorkerPriority, setNewWorkerPriority] = useState(1);
  const [newWorkerBar, setNewWorkerBar] = useState(false);
  const [newWorkerMorning, setNewWorkerMorning] = useState(true);
  const [newWorkerAfternoon, setNewWorkerAfternoon] = useState(true);
  const [newWorkerHours, setNewWorkerHours] = useState(40);
  const [newWorkerRate, setNewWorkerRate] = useState(12.5);
  const [newWorkerHolidayPct, setNewWorkerHolidayPct] = useState(20);
  const [focusedWorkerId, setFocusedWorkerId] = useState<string | null>(null);

  // Calendar Shift Exceptions Form State (Scheda 2: Eccezioni Orarie di Calendario)
  const [exDay, setExDay] = useState<number>(3);
  const [exShiftType, setExShiftType] = useState<'BAR' | 'MORNING' | 'AFTERNOON'>('MORNING');
  const [exLabel, setExLabel] = useState<string>('7-12');
  const [exHours, setExHours] = useState<number>(5);
  const [exNote, setExNote] = useState<string>('');
  const [editingExceptionId, setEditingExceptionId] = useState<string | null>(null);

  // New Absence / Holiday / Specific Shift Unavailability Form State
  const [absMode, setAbsMode] = useState<'VACATION_PERIOD' | 'SINGLE_DAY_OR_SHIFT'>(
    'VACATION_PERIOD'
  );
  const [absWorkerId, setAbsWorkerId] = useState(config.workers[0]?.id || '1');
  const [absStartDay, setAbsStartDay] = useState(1);
  const [absEndDay, setAbsEndDay] = useState(5);
  const [absType, setAbsType] = useState<AbsenceType>('Ferie');
  const [absScope, setAbsScope] = useState<AbsenceScope>('FULL_DAY');
  const [absNote, setAbsNote] = useState('');
  const [editingAbsenceId, setEditingAbsenceId] = useState<string | null>(null);

  // Bulk Calendar Requirement State
  const [bulkBar, setBulkBar] = useState(1);
  const [bulkMorning, setBulkMorning] = useState(4);
  const [bulkAfternoon, setBulkAfternoon] = useState(2);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerNameInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Handlers for Scheda 1: Personale & Competenze
  const handleUpdateWorker = (id: string, patch: Partial<Worker>) => {
    setConfig((prev) => ({
      ...prev,
      workers: prev.workers.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));
  };

  const handleEqualizeFissoContracts = () => {
    setConfig((prev) => ({
      ...prev,
      workers: prev.workers.map((w) =>
        w.type === 'Fisso' ? { ...w, maxWeeklyHours: 40 } : w
      ),
    }));
  };

  const handleAddWorker = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWorkerName.trim()) return;
    setConfig((prev) => {
      const nextNumIdStr = getNextWorkerNumericId(prev.workers);
      const newW: Worker = {
        id: nextNumIdStr,
        numericId: parseInt(nextNumIdStr, 10),
        name: newWorkerName.trim(),
        type: newWorkerType,
        priority:
          newWorkerType === 'Sostituta'
            ? Math.max(1, Math.min(5, Number(newWorkerPriority) || 1))
            : 0,
        canBar: newWorkerBar,
        canMorning: newWorkerMorning,
        canAfternoon: newWorkerAfternoon,
        maxWeeklyHours: newWorkerHours,
        hourlyRate: Math.max(1, Number(newWorkerRate) || 12.5),
        holidaySurchargePct:
          newWorkerType === 'Fisso'
            ? Math.max(0, Math.min(200, Number(newWorkerHolidayPct) || 0))
            : 0,
        active: true,
      };
      return {
        ...prev,
        workers: [...prev.workers, newW],
      };
    });
    setNewWorkerName('');
  };

  const handleDeleteWorker = (id: string) => {
    setConfig((prev) => ({
      ...prev,
      workers: prev.workers.filter((w) => w.id !== id),
      absences: prev.absences.filter((a) => a.workerId !== id),
    }));
  };

  const handleUpdateWorkerHourlyRate = (workerId: string, newRate: number) => {
    handleUpdateWorker(workerId, { hourlyRate: Math.max(1, newRate) });
  };

  const handleApplyBulkHourlyRate = (
    roleType: 'ALL' | 'Fisso' | 'Sostituta',
    rate: number
  ) => {
    setConfig((prev) => ({
      ...prev,
      workers: prev.workers.map((w) =>
        roleType === 'ALL' || w.type === roleType
          ? { ...w, hourlyRate: Math.max(1, rate) }
          : w
      ),
    }));
  };

  const handleUpdateWorkerHolidaySurcharge = (workerId: string, pct: number) => {
    handleUpdateWorker(workerId, {
      holidaySurchargePct: Math.max(0, Math.min(200, pct)),
    });
  };

  const handleApplyBulkHolidaySurcharge = (pct: number) => {
    const clampedPct = Math.max(0, Math.min(200, pct));
    setConfig((prev) => ({
      ...prev,
      workers: prev.workers.map((w) =>
        w.type === 'Fisso' ? { ...w, holidaySurchargePct: clampedPct } : w
      ),
    }));
  };

  // Handlers for Scheda 2: Orari dei Turni & Eccezioni Orarie di Calendario
  const handleUpdateShiftBand = (
    role: 'bar' | 'morning' | 'afternoon',
    band: DayBand,
    field: 'label' | 'hours',
    value: string | number
  ) => {
    setConfig((prev) => ({
      ...prev,
      shiftConfig: {
        ...prev.shiftConfig,
        [role]: {
          ...prev.shiftConfig[role],
          [band]: {
            ...prev.shiftConfig[role][band],
            [field]: field === 'hours' ? Math.max(1, Number(value) || 0) : String(value),
          },
        },
      },
    }));
  };

  const handleSelectExceptionDayOrShift = (
    dayNum: number,
    sType: 'BAR' | 'MORNING' | 'AFTERNOON'
  ) => {
    setExDay(dayNum);
    setExShiftType(sType);
    const dayObj = config.calendar.find((c) => c.day === dayNum);
    if (dayObj) {
      const band = getDayBand(dayObj);
      const key = sType.toLowerCase() as 'bar' | 'morning' | 'afternoon';
      const baseSpec = config.shiftConfig[key][band];
      // Suggest a 1h shorter shift by default when selecting a new day/shift
      const parts = baseSpec.label.split('-');
      const suggestedLabel =
        parts.length === 2 && !Number.isNaN(Number(parts[1]))
          ? `${parts[0]}-${Math.max(Number(parts[0]) + 1, Number(parts[1]) - 1)}`
          : baseSpec.label;
      setExLabel(suggestedLabel);
      setExHours(Math.max(1, baseSpec.hours - 1));
    }
  };

  const handleSaveShiftException = (e: React.FormEvent) => {
    e.preventDefault();
    const dayObj = config.calendar.find((c) => c.day === exDay) || config.calendar[0];
    if (!dayObj || !exLabel.trim()) return;

    const newException: ShiftDateException = {
      id: editingExceptionId || `ex-${Date.now()}`,
      day: dayObj.day,
      dateStr: dayObj.dateStr,
      isoDate: dayObj.isoDate,
      shiftType: exShiftType,
      label: exLabel.trim(),
      hours: Math.max(1, Number(exHours) || 1),
      note: exNote.trim(),
    };

    setConfig((prev) => {
      const existingList = prev.shiftExceptions || [];
      const filtered = existingList.filter(
        (x) =>
          x.id !== editingExceptionId &&
          !(x.day === newException.day && x.shiftType === newException.shiftType)
      );
      return {
        ...prev,
        shiftExceptions: [...filtered, newException].sort((a, b) => a.day - b.day),
      };
    });

    setEditingExceptionId(null);
    setExNote('');
  };

  const handleEditShiftException = (ex: ShiftDateException) => {
    setEditingExceptionId(ex.id);
    setExDay(ex.day);
    setExShiftType(ex.shiftType);
    setExLabel(ex.label);
    setExHours(ex.hours);
    setExNote(ex.note || '');
  };

  const handleDeleteShiftException = (id: string) => {
    setConfig((prev) => ({
      ...prev,
      shiftExceptions: (prev.shiftExceptions || []).filter((x) => x.id !== id),
    }));
    if (editingExceptionId === id) {
      setEditingExceptionId(null);
    }
  };

  // Handlers for Scheda 3: Periodo, Calendario & Fabbisogno Giornaliero
  const handleMonthYearOrExtraChange = (
    newMonth: number,
    newYear: number,
    extraDays: number
  ) => {
    const clampedExtra = Math.max(0, Math.min(31, extraDays));
    const bounds = getMonthDateBounds(newMonth, newYear, clampedExtra);
    const newCal = generateCalendarForMonth(
      newMonth,
      newYear,
      bulkBar,
      bulkMorning,
      bulkAfternoon,
      clampedExtra,
      config.calendar
    );
    setConfig((prev) => ({
      ...prev,
      month: newMonth,
      year: newYear,
      periodMode: 'MONTHLY',
      extraDaysAfterMonth: clampedExtra,
      customStartDate: bounds.startDate,
      customEndDate: bounds.endDate,
      calendar: newCal,
      absences: prev.absences.map((a) => ({
        ...a,
        startDay: Math.min(a.startDay, newCal.length),
        endDay: Math.min(a.endDay, newCal.length),
      })),
    }));
  };

  const handleCustomDateRangeChange = (startIso: string, endIso: string) => {
    const newCal = generateCalendarFromDateRange(
      startIso,
      endIso,
      bulkBar,
      bulkMorning,
      bulkAfternoon,
      config.calendar
    );
    const [sy, sm] = startIso.split('-').map(Number);
    setConfig((prev) => ({
      ...prev,
      month: sm || prev.month,
      year: sy || prev.year,
      periodMode: 'CUSTOM_RANGE',
      customStartDate: startIso,
      customEndDate: endIso,
      calendar: newCal,
      absences: prev.absences.map((a) => ({
        ...a,
        startDay: Math.min(a.startDay, newCal.length),
        endDay: Math.min(a.endDay, newCal.length),
      })),
    }));
  };

  const handlePeriodModeSwitch = (mode: PeriodMode) => {
    if (mode === 'MONTHLY') {
      handleMonthYearOrExtraChange(
        config.month,
        config.year,
        config.extraDaysAfterMonth || 0
      );
    } else {
      const bounds = getMonthDateBounds(
        config.month,
        config.year,
        config.extraDaysAfterMonth || 6
      );
      handleCustomDateRangeChange(
        config.customStartDate || bounds.startDate,
        config.customEndDate || bounds.endDate
      );
    }
  };

  const handleExtendToCompleteSundayWeek = () => {
    // Automatically calculate how many days after month end are needed to reach Sunday
    const lastOfMonth = new Date(config.year, config.month, 0);
    const dow = lastOfMonth.getDay(); // 0 = Sunday
    const neededExtra = dow === 0 ? 0 : 7 - dow;
    handleMonthYearOrExtraChange(config.month, config.year, neededExtra);
  };

  const handleApplyBulkRequirements = () => {
    setConfig((prev) => ({
      ...prev,
      calendar: prev.calendar.map((d) => ({
        ...d,
        reqBar: bulkBar,
        reqMorning: bulkMorning,
        reqAfternoon: bulkAfternoon,
      })),
    }));
  };

  const handleUpdateCalendarDay = (
    day: number,
    patch: Partial<{ reqBar: number; reqMorning: number; reqAfternoon: number; isHoliday: boolean }>
  ) => {
    setConfig((prev) => ({
      ...prev,
      calendar: prev.calendar.map((d) => (d.day === day ? { ...d, ...patch } : d)),
    }));
  };

  // Handlers for Scheda 4: Assenze, Ferie e Indisponibilità
  const handleSelectAbsMode = (mode: 'VACATION_PERIOD' | 'SINGLE_DAY_OR_SHIFT') => {
    setAbsMode(mode);
    if (mode === 'VACATION_PERIOD') {
      setAbsType('Ferie');
      setAbsScope('FULL_DAY');
    } else {
      setAbsEndDay(absStartDay);
      setAbsType('Indisponibilità generica');
      setAbsScope('ONLY_MORNING');
    }
  };

  const handleSaveAbsence = (e: React.FormEvent) => {
    e.preventDefault();
    if (!absWorkerId) return;
    const effectiveEndDay =
      absMode === 'SINGLE_DAY_OR_SHIFT' ? absStartDay : Math.max(absStartDay, absEndDay);
    const sDay = Math.min(absStartDay, effectiveEndDay);
    const eDay = Math.max(absStartDay, effectiveEndDay);

    if (editingAbsenceId) {
      setConfig((prev) => ({
        ...prev,
        absences: prev.absences.map((a) =>
          a.id === editingAbsenceId
            ? {
                ...a,
                workerId: absWorkerId,
                startDay: sDay,
                endDay: eDay,
                type: absType,
                scope: absScope,
                note: absNote.trim(),
              }
            : a
        ),
      }));
      setEditingAbsenceId(null);
    } else {
      const newAbs: AbsenceRecord = {
        id: `abs-${Date.now()}`,
        workerId: absWorkerId,
        startDay: sDay,
        endDay: eDay,
        type: absType,
        scope: absScope,
        note: absNote.trim(),
      };
      setConfig((prev) => ({
        ...prev,
        absences: [...prev.absences, newAbs],
      }));
    }
    setAbsNote('');
  };

  const handleEditAbsence = (rec: AbsenceRecord) => {
    setEditingAbsenceId(rec.id);
    setAbsWorkerId(rec.workerId);
    setAbsStartDay(rec.startDay);
    setAbsEndDay(rec.endDay);
    setAbsType(rec.type);
    setAbsScope(rec.scope);
    setAbsNote(rec.note || '');
    if (rec.startDay === rec.endDay && rec.scope !== 'FULL_DAY') {
      setAbsMode('SINGLE_DAY_OR_SHIFT');
    } else {
      setAbsMode('VACATION_PERIOD');
    }
  };

  const handleDeleteAbsence = (id: string) => {
    setConfig((prev) => ({
      ...prev,
      absences: prev.absences.filter((a) => a.id !== id),
    }));
    if (editingAbsenceId === id) {
      setEditingAbsenceId(null);
    }
  };

  // Handlers for JSON Profile Save / Load
  const handleSaveProfileJson = () => {
    const jsonStr = JSON.stringify(config, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `profilo_turni_${config.month}_${config.year}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleLoadProfileJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.target?.result)) as Partial<AppConfig>;
        if (parsed && Array.isArray(parsed.workers) && Array.isArray(parsed.calendar)) {
          setConfig(normalizeAndMigrateAppConfig(parsed));
        }
      } catch {
        // Ignore invalid JSON
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleRecalculateTrigger = () => {
    setIsSolving(true);
    setManualCellOverrides({});
    setHighlightedTarget(null);
    setTimeout(() => {
      setIsSolving(false);
      setActiveTab('TAB_6_SOLVE');
      if (
        solution.requiresAfternoonOverflowConfirmation &&
        solution.indispensableAfternoonExceptions &&
        solution.indispensableAfternoonExceptions.length > 0
      ) {
        setIsAfternoonOverflowModalOpen(true);
      } else if (solution.solveInsights.hasConflicts) {
        setIsInsightsModalOpen(true);
      }
    }, 150);
  };

  const handleApplySuggestion = (suggestion: SolveRemediationSuggestion) => {
    setConfig((prev) => applyRemediationSuggestion(prev, suggestion));
  };

  const handleApplyAllSuggestions = (suggestions: SolveRemediationSuggestion[]) => {
    setConfig((prev) => {
      let next = prev;
      for (const s of suggestions) {
        next = applyRemediationSuggestion(next, s);
      }
      return next;
    });
  };

  const handleSimulateConflictDemo = () => {
    // Uses immutable numeric IDs ("2" = Sabrina, "3" = Ilaria, "4" = Elena, "5" = Maria)
    setConfig((prev) => ({
      ...prev,
      workers: prev.workers.map((w) =>
        w.id === '2' || w.id === '3' ? { ...w, maxWeeklyHours: 32 } : w
      ),
      calendar: prev.calendar.map((d) =>
        d.day === 14 ? { ...d, reqMorning: 6, reqAfternoon: 3 } : d
      ),
      absences: [
        ...prev.absences.filter((a) => !a.id.startsWith('demo-conf-')),
        {
          id: 'demo-conf-1',
          workerId: '4',
          startDay: 14,
          endDay: 14,
          type: 'Ferie',
          scope: 'FULL_DAY',
          note: 'Ferie concomitanti giorno ad alta occupazione',
        },
        {
          id: 'demo-conf-2',
          workerId: '5',
          startDay: 14,
          endDay: 14,
          type: 'Permesso ROL',
          scope: 'ONLY_MORNING',
          note: 'Indisponibile turno mattina 14-nov',
        },
      ],
    }));
    setIsInsightsModalOpen(true);
  };

  const scopeLabelMap: Record<AbsenceScope, string> = {
    FULL_DAY: 'Intera giornata (nessun turno assegnabile)',
    ONLY_MORNING: 'Solo turno Mattina (disponibile per Pomeriggio)',
    ONLY_AFTERNOON: 'Solo turno Pomeriggio (disponibile per Mattina)',
    ONLY_BAR: 'Solo turno Bar (disponibile altri reparti)',
  };

  const fissoWorkersList = config.workers.filter((w) => w.active && w.type === 'Fisso');

  if (isBooting) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 text-slate-900 p-6">
        <div className="bg-white border border-slate-200 rounded-2xl shadow-xl p-8 sm:p-10 max-w-lg w-full text-center space-y-6">
          {/* Logo dell'Hotel in Grande su Sfondo Bianco */}
          <div className="bg-white p-4 rounded-xl border border-slate-100 inline-flex items-center justify-center mx-auto">
            <img
              src={HOTEL_LOGO_DATA_URI}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = HOTEL_LOGO_PATH;
              }}
              alt="Logo Airport Motel Malpensa 4 Stelle"
              className="h-32 sm:h-36 w-auto object-contain bg-white"
            />
          </div>

          <div className="space-y-1">
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
              Turni di Lavoro RT
            </h1>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Airport Motel Malpensa · Sistema Ottimizzazione Turni
            </p>
          </div>

          {/* Barra Progressiva Stato Avvio */}
          <div className="space-y-2.5 text-left">
            <div className="flex items-center justify-between text-xs font-bold text-slate-700">
              <span>{bootStepLabel}</span>
              <span className="font-mono text-slate-900">{bootProgress}%</span>
            </div>
            <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden border border-slate-300/60">
              <div
                className="h-full bg-slate-900 rounded-full transition-all duration-150 ease-out"
                style={{ width: `${bootProgress}%` }}
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
            <span>Memoria Permanente Attiva</span>
            <span className="font-semibold text-slate-700">Creato da Raffaele Tarallo</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-3 bg-white border-b border-slate-200 sticky top-0 z-30">
        {/* Zone 1: Hotel Logo (Airport Motel Malpensa) + Brand Title */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('TAB_6_SOLVE');
          }}
          className="inline-flex items-center gap-3 text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          <img
            src={HOTEL_LOGO_DATA_URI}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = HOTEL_LOGO_PATH;
            }}
            alt="Logo Airport Motel Malpensa 4 Stelle"
            className="h-12 w-auto rounded-md object-contain bg-white px-2 py-1 shadow-xs border border-slate-200"
          />
          <div className="flex flex-col">
            <span className="leading-tight">Turni di Lavoro RT</span>
            <span className="text-[11px] font-medium text-slate-500 leading-tight">
              Airport Motel Malpensa · Gestione Turni
            </span>
          </div>
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav className="hidden xl:flex items-center gap-6 text-xs font-medium text-slate-600">
          <button
            onClick={() => setActiveTab('TAB_1_STAFF')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_1_STAFF'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            1. Personale & Nomi
          </button>
          <button
            onClick={() => setActiveTab('TAB_3_CALENDAR')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_3_CALENDAR'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            2. Periodo & Fabbisogno
          </button>
          <button
            onClick={() => setActiveTab('TAB_2_SHIFTS')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_2_SHIFTS'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            3. Orari & Eccezioni
          </button>
          <button
            onClick={() => setActiveTab('TAB_4_ABSENCES')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_4_ABSENCES'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            4. Ferie & Indisponibilità
          </button>
          <button
            onClick={() => setActiveTab('TAB_5_CCNL')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_5_CCNL'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            5. Vincoli & Pareggio Ore
          </button>
          <button
            onClick={() => setActiveTab('TAB_HISTORY')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_HISTORY'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            Storico Turni
          </button>
          <button
            onClick={() => setActiveTab('TAB_ECONOMICS')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_ECONOMICS'
                ? 'text-slate-900 font-bold underline underline-offset-8'
                : ''
            }`}
          >
            Analisi Costi (€)
          </button>
        </nav>

        {/* Zone 3: Auto-Save Status + Guida Scheda + 1 Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          <span
            title="Salvataggio automatico attivo su memoria permanente (localStorage / disco)"
            className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-700"
          >
            <Save className="w-3.5 h-3.5" />
            Auto-Save ({lastAutoSaveTime})
          </span>
          <HelpGuideButton tabKey={activeTab} onOpenGuide={handleOpenGuide} />
          <button
            onClick={handleRecalculateTrigger}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            Calcola Turni Ottimizzati
          </button>
        </div>
      </header>

      {/* Secondary Workspace Tab Bar & Profile Toolbar */}
      <div className="bg-white border-b border-slate-200 px-6 py-2.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            onClick={() => setActiveTab('TAB_1_STAFF')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_1_STAFF'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Scheda 1: Personale & Costi ({config.workers.filter((w) => w.active).length})
          </button>

          <button
            onClick={() => setActiveTab('TAB_3_CALENDAR')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_3_CALENDAR'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            Scheda 2: Periodo & Fabbisogno ({config.calendar.length} gg)
          </button>

          <button
            onClick={() => setActiveTab('TAB_2_SHIFTS')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_2_SHIFTS'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            Scheda 3: Orari & Eccezioni ({(config.shiftExceptions || []).length})
          </button>

          <button
            onClick={() => setActiveTab('TAB_4_ABSENCES')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_4_ABSENCES'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <UserX className="w-3.5 h-3.5" />
            Scheda 4: Ferie & Indisponibilità ({config.absences.length})
          </button>

          <button
            onClick={() => setActiveTab('TAB_5_CCNL')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_5_CCNL'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            Scheda 5: Vincoli CCNL & Equità
          </button>

          <button
            onClick={() => setActiveTab('TAB_6_SOLVE')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_6_SOLVE'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Scheda 6: Anteprima & Esportazione
          </button>

          <button
            onClick={() => setActiveTab('TAB_HISTORY')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_HISTORY'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            Storico Turni ({(config.history || []).length})
          </button>

          <button
            onClick={() => setActiveTab('TAB_ECONOMICS')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_ECONOMICS'
                ? 'bg-white text-slate-900 shadow-xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Euro className="w-3.5 h-3.5" />
            Analisi Costi (€)
          </button>

          <button
            onClick={() => setActiveTab('TAB_7_WINDOWS_CODE')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TAB_7_WINDOWS_CODE'
                ? 'bg-slate-900 text-white shadow-xs font-semibold'
                : 'text-slate-700 hover:text-slate-900'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            Sorgente Python Windows (.exe)
          </button>
        </div>

        {/* Profile JSON Save / Load Controls */}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleLoadProfileJson}
            className="hidden"
          />
          <button
            onClick={() => downloadPythonWindowsSuiteZip(config)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-emerald-700 rounded-md hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Scarica Programma Windows (.zip)
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Carica Profilo (.json)
          </button>
          <button
            onClick={handleSaveProfileJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Salva Profilo (.json)
          </button>
          <button
            onClick={() => setConfig(INITIAL_APP_CONFIG)}
            title="Ripristina valori predefiniti"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
      </div>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6">
        {/* SCHEDA 1: PERSONALE, NOMI & COMPETENZE */}
        {activeTab === 'TAB_1_STAFF' && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-slate-200 rounded-lg p-5">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  Scheda 1: Anagrafica Personale (ID Numerici Immutabili), Competenze & Costo Orario
                </h1>
                <p className="text-sm text-slate-600">
                  Ogni dipendente è identificata da un{' '}
                  <strong className="text-slate-900">ID numerico progressivo immutabile (#1, #2, ...)</strong>.
                  Cambiando il nome o il costo orario (€/h), le modifiche vengono salvate
                  istantaneamente in memoria permanente senza mai alterare i legami con assenze,
                  vincoli o storico turni.
                </p>
              </div>
              <div className="shrink-0 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleEqualizeFissoContracts}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Scale className="w-3.5 h-3.5" />
                  Imposta tutte le Fisse a 40h (Pari Contratto)
                </button>
                <HelpGuideButton tabKey="TAB_1_STAFF" onOpenGuide={handleOpenGuide} />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-200 text-xs font-semibold text-slate-700">
                      <th className="py-3 px-2.5 text-center">ID #</th>
                      <th className="py-3 px-2.5">Attiva</th>
                      <th className="py-3 px-3.5">Nome Lavoratrice (Modificabile)</th>
                      <th className="py-3 px-2.5">Tipologia</th>
                      <th className="py-3 px-3 text-center">Priorità Sostituta (1–5)</th>
                      <th className="py-3 px-2 text-center">Abil. Bar</th>
                      <th className="py-3 px-2 text-center">Abil. Mattina</th>
                      <th className="py-3 px-2 text-center">Abil. Pom.</th>
                      <th className="py-3 px-2.5 text-right">Max Ore Sett.</th>
                      <th className="py-3 px-3 text-right">Costo Orario (€/h)</th>
                      <th className="py-3 px-3 text-right text-emerald-900 bg-emerald-50/70">
                        Magg. Festivi (%) — Fisse
                      </th>
                      <th className="py-3 px-2.5 text-right">Azioni</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {config.workers.map((w) => {
                      const baseRate = w.hourlyRate ?? (w.type === 'Sostituta' ? 13.0 : 12.5);
                      const holPct =
                        w.type === 'Fisso'
                          ? typeof w.holidaySurchargePct === 'number' &&
                            !Number.isNaN(w.holidaySurchargePct)
                            ? w.holidaySurchargePct
                            : 20
                          : 0;
                      const festiveRate = Math.round(baseRate * (1 + holPct / 100) * 100) / 100;
                      const currentPrio = Math.max(1, Math.min(5, w.priority || 1));

                      return (
                        <tr
                          key={w.id}
                          className={`hover:bg-slate-50 transition-colors ${
                            !w.active ? 'opacity-50 bg-slate-50' : ''
                          } ${focusedWorkerId === w.id ? 'bg-slate-100/80' : ''}`}
                        >
                          <td className="py-2.5 px-2.5 text-center font-mono text-xs font-bold text-slate-500">
                            #{w.id}
                          </td>
                          <td className="py-2.5 px-2.5">
                            <input
                              type="checkbox"
                              checked={w.active}
                              onChange={(e) =>
                                handleUpdateWorker(w.id, { active: e.target.checked })
                              }
                              className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 cursor-pointer"
                            />
                          </td>
                          <td className="py-2.5 px-3.5">
                            <div className="flex items-center gap-2">
                              <input
                                ref={(el) => {
                                  workerNameInputRefs.current[w.id] = el;
                                }}
                                type="text"
                                value={w.name}
                                onFocus={() => setFocusedWorkerId(w.id)}
                                onBlur={() => setFocusedWorkerId(null)}
                                onChange={(e) =>
                                  handleUpdateWorker(w.id, { name: e.target.value })
                                }
                                placeholder="Inserisci nome..."
                                className="w-full max-w-[180px] px-2.5 py-1.5 text-sm font-bold text-slate-900 bg-white border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const input = workerNameInputRefs.current[w.id];
                                  if (input) {
                                    input.focus();
                                    input.select();
                                  }
                                }}
                                title="Modifica nome lavoratrice"
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 hover:text-slate-900 rounded transition-colors cursor-pointer shrink-0"
                              >
                                <Edit3 className="w-3 h-3" />
                                Rinomina
                              </button>
                            </div>
                          </td>
                          <td className="py-2.5 px-2.5">
                            <select
                              value={w.type}
                              onChange={(e) => {
                                const newType = e.target.value as WorkerRoleType;
                                handleUpdateWorker(w.id, {
                                  type: newType,
                                  priority:
                                    newType === 'Sostituta'
                                      ? Math.max(1, Math.min(5, w.priority || 1))
                                      : 0,
                                  holidaySurchargePct:
                                    newType === 'Fisso'
                                      ? w.holidaySurchargePct ?? 20
                                      : 0,
                                });
                              }}
                              className="px-2 py-1 text-xs font-medium bg-white border border-slate-300 rounded focus:outline-none focus:border-slate-900"
                            >
                              <option value="Fisso">Fisso (Organico Base)</option>
                              <option value="Sostituta">Sostituta (Chiamata)</option>
                            </select>
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            {w.type === 'Sostituta' ? (
                              <select
                                value={currentPrio}
                                onChange={(e) =>
                                  handleUpdateWorker(w.id, {
                                    priority: Math.max(1, Math.min(5, Number(e.target.value) || 1)),
                                  })
                                }
                                title="Seleziona la priorità per la sostituta da 1 (Massima) a 4 (Minima), oppure 5 per non tenerla proprio in considerazione"
                                className={`px-2.5 py-1 text-xs font-bold rounded border cursor-pointer focus:outline-none ${
                                  currentPrio === 5
                                    ? 'bg-red-50 text-red-800 border-red-300'
                                    : currentPrio === 1
                                    ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                                    : 'bg-white text-slate-900 border-slate-300'
                                }`}
                              >
                                <option value={1}>1 — Priorità Massima (1ª scelta)</option>
                                <option value={2}>2 — Priorità Alta (2ª scelta)</option>
                                <option value={3}>3 — Priorità Media (3ª scelta)</option>
                                <option value={4}>4 — Priorità Minima (Ultima scelta)</option>
                                <option value={5}>5 — Non considerare (Esclusa)</option>
                              </select>
                            ) : (
                              <span className="text-xs text-slate-400 font-mono">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={w.canBar}
                              onChange={(e) =>
                                handleUpdateWorker(w.id, { canBar: e.target.checked })
                              }
                              className="w-4 h-4 rounded border-slate-300 text-amber-600 focus:ring-amber-600 cursor-pointer"
                            />
                          </td>
                          <td className="py-2.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={w.canMorning}
                              onChange={(e) =>
                                handleUpdateWorker(w.id, { canMorning: e.target.checked })
                              }
                              className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-600 cursor-pointer"
                            />
                          </td>
                          <td className="py-2.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={w.canAfternoon}
                              onChange={(e) =>
                                handleUpdateWorker(w.id, { canAfternoon: e.target.checked })
                              }
                              className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 cursor-pointer"
                            />
                          </td>
                          <td className="py-2.5 px-2.5 text-right">
                            <div className="inline-flex items-center gap-1">
                              <input
                                type="number"
                                min={6}
                                max={48}
                                value={w.maxWeeklyHours}
                                onChange={(e) =>
                                  handleUpdateWorker(w.id, {
                                    maxWeeklyHours: Math.max(6, Number(e.target.value) || 40),
                                  })
                                }
                                className="w-14 px-2 py-1 text-right font-mono text-xs bg-white border border-slate-300 rounded"
                              />
                              <span className="text-xs text-slate-500 font-mono">h</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <input
                                type="number"
                                step="0.25"
                                min={1}
                                max={100}
                                value={baseRate}
                                onChange={(e) =>
                                  handleUpdateWorker(w.id, {
                                    hourlyRate: Math.max(1, Number(e.target.value) || 12.5),
                                  })
                                }
                                className="w-18 px-2 py-1 text-right font-mono text-xs font-bold text-slate-900 bg-white border border-slate-300 rounded"
                              />
                              <span className="text-xs text-slate-500 font-mono">€/h</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right bg-emerald-50/40">
                            {w.type === 'Fisso' ? (
                              <div className="flex flex-col items-end gap-0.5">
                                <div className="inline-flex items-center gap-1">
                                  <span className="text-xs font-bold text-emerald-800">+</span>
                                  <input
                                    type="number"
                                    step="1"
                                    min={0}
                                    max={200}
                                    value={holPct}
                                    onChange={(e) =>
                                      handleUpdateWorker(w.id, {
                                        holidaySurchargePct: Math.max(
                                          0,
                                          Math.min(200, Number(e.target.value) || 0)
                                        ),
                                      })
                                    }
                                    title="Maggiorazione percentuale applicata alle ore lavorate durante i giorni festivi per questa lavoratrice fissa"
                                    className="w-14 px-1.5 py-1 text-right font-mono text-xs font-bold text-emerald-950 bg-white border border-emerald-300 rounded focus:outline-none focus:border-emerald-700"
                                  />
                                  <span className="text-xs font-mono font-bold text-emerald-800">
                                    %
                                  </span>
                                </div>
                                <span className="text-[10px] font-mono text-emerald-700">
                                  ({festiveRate.toFixed(2).replace('.', ',')} €/h fest.)
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400 font-mono">— (Solo Fisse)</span>
                            )}
                          </td>
                          <td className="py-2.5 px-2.5 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteWorker(w.id)}
                              title="Elimina lavoratrice dall'organico"
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Elimina
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Add Worker Bar */}
              <form
                onSubmit={handleAddWorker}
                className="p-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-end gap-4"
              >
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nuova Lavoratrice (ID #{getNextWorkerNumericId(config.workers)})
                  </label>
                  <input
                    type="text"
                    placeholder="Es. Roberta"
                    value={newWorkerName}
                    onChange={(e) => setNewWorkerName(e.target.value)}
                    className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Tipologia
                  </label>
                  <select
                    value={newWorkerType}
                    onChange={(e) => {
                      const t = e.target.value as WorkerRoleType;
                      setNewWorkerType(t);
                      setNewWorkerRate(t === 'Sostituta' ? 13.0 : 12.5);
                    }}
                    className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
                  >
                    <option value="Fisso">Fisso</option>
                    <option value="Sostituta">Sostituta</option>
                  </select>
                </div>
                {newWorkerType === 'Sostituta' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Priorità Sostituta (1–5)
                    </label>
                    <select
                      value={newWorkerPriority}
                      onChange={(e) =>
                        setNewWorkerPriority(Math.max(1, Math.min(5, Number(e.target.value) || 1)))
                      }
                      className="px-2.5 py-1.5 text-xs font-bold bg-white border border-slate-300 rounded-md"
                    >
                      <option value={1}>1 — Massima (1ª scelta)</option>
                      <option value={2}>2 — Alta (2ª scelta)</option>
                      <option value={3}>3 — Media (3ª scelta)</option>
                      <option value={4}>4 — Minima (Ultima scelta)</option>
                      <option value={5}>5 — Non considerare (Esclusa)</option>
                    </select>
                  </div>
                )}
                <div className="flex items-center gap-4 py-1.5">
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newWorkerBar}
                      onChange={(e) => setNewWorkerBar(e.target.checked)}
                    />
                    Bar
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newWorkerMorning}
                      onChange={(e) => setNewWorkerMorning(e.target.checked)}
                    />
                    Mattina
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newWorkerAfternoon}
                      onChange={(e) => setNewWorkerAfternoon(e.target.checked)}
                    />
                    Pomeriggio
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Max Ore Sett.
                  </label>
                  <input
                    type="number"
                    min={6}
                    max={48}
                    value={newWorkerHours}
                    onChange={(e) => setNewWorkerHours(Number(e.target.value) || 40)}
                    className="w-20 px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Costo Orario (€/h)
                  </label>
                  <input
                    type="number"
                    step="0.25"
                    min={1}
                    max={100}
                    value={newWorkerRate}
                    onChange={(e) => setNewWorkerRate(Number(e.target.value) || 12.5)}
                    className="w-20 px-2.5 py-1.5 text-xs font-mono font-bold bg-white border border-slate-300 rounded-md"
                  />
                </div>
                {newWorkerType === 'Fisso' && (
                  <div>
                    <label className="block text-xs font-medium text-emerald-800 mb-1">
                      Magg. Festivi (%)
                    </label>
                    <div className="inline-flex items-center gap-1">
                      <input
                        type="number"
                        step="1"
                        min={0}
                        max={200}
                        value={newWorkerHolidayPct}
                        onChange={(e) =>
                          setNewWorkerHolidayPct(
                            Math.max(0, Math.min(200, Number(e.target.value) || 0))
                          )
                        }
                        className="w-16 px-2.5 py-1.5 text-xs font-mono font-bold text-emerald-950 bg-white border border-emerald-300 rounded-md"
                      />
                      <span className="text-xs font-mono font-bold text-emerald-800">%</span>
                    </div>
                  </div>
                )}
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Aggiungi Lavoratrice
                </button>
              </form>
            </div>
          </div>
        )}

        {/* SCHEDA 3: ORARI DEI TURNI, CALCOLO ORE & ECCEZIONI DI CALENDARIO */}
        {activeTab === 'TAB_2_SHIFTS' && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-slate-200 rounded-lg p-5">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  Scheda 3: Orari & Eccezioni (Calcolo Ore & Eccezioni di Calendario)
                </h1>
                <p className="text-sm text-slate-600">
                  Personalizza gli orari standard per fascia settimanale oppure definisci{' '}
                  <strong className="text-slate-900">Eccezioni Orarie di Calendario</strong> per una
                  data specifica e un singolo turno (es. <code className="font-mono">03-nov</code>{' '}
                  solo Mattina da <code className="font-mono">7-13</code> [6h] a{' '}
                  <code className="font-mono">7-12</code> [5h]).
                </p>
              </div>
              <HelpGuideButton tabKey="TAB_2_SHIFTS" onOpenGuide={handleOpenGuide} />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3 bg-slate-100 border-b border-slate-200 text-xs font-bold uppercase tracking-wider text-slate-800">
                1. Configurazione Standard Orari per Fasce Settimanali (Lun-Mer, Gio-Sab, Dom/Festivi)
              </div>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                    <th className="py-3.5 px-5">Reparto / Mansione</th>
                    <th className="py-3.5 px-5">Fascia Lunedì – Mercoledì</th>
                    <th className="py-3.5 px-5">Fascia Giovedì – Sabato</th>
                    <th className="py-3.5 px-5">Fascia Domenica o Festivi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {(
                    [
                      {
                        key: 'bar',
                        title: 'Turno BAR',
                        subtitle: 'Cella con sfondo GIALLO pastello',
                        badgeBg: 'bg-[#FEF08A] text-slate-950 font-bold border border-amber-300',
                      },
                      {
                        key: 'morning',
                        title: 'Turno Pulizie MATTINA',
                        subtitle: 'Testo ROSSO carico su sfondo bianco',
                        badgeBg: 'bg-white text-[#DC2626] font-semibold border border-red-200',
                      },
                      {
                        key: 'afternoon',
                        title: 'Turno Pulizie POMERIGGIO',
                        subtitle: 'Testo NERO in GRASSETTO marcato',
                        badgeBg: 'bg-white text-black font-bold border border-slate-300',
                      },
                    ] as const
                  ).map((row) => (
                    <tr key={row.key} className="hover:bg-slate-50/60">
                      <td className="py-4 px-5">
                        <div className="font-bold text-slate-900">{row.title}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{row.subtitle}</div>
                      </td>
                      {(['MON_WED', 'THU_SAT', 'SUN_HOL'] as DayBand[]).map((band) => {
                        const spec = config.shiftConfig[row.key][band];
                        return (
                          <td key={band} className="py-4 px-5">
                            <div className="flex items-center gap-3">
                              <div>
                                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                                  Stringa Orario
                                </label>
                                <input
                                  type="text"
                                  value={spec.label}
                                  onChange={(e) =>
                                    handleUpdateShiftBand(row.key, band, 'label', e.target.value)
                                  }
                                  className={`w-24 px-2.5 py-1.5 text-center font-mono text-xs rounded ${row.badgeBg}`}
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                                  Ore Retribuite
                                </label>
                                <div className="inline-flex items-center gap-1">
                                  <input
                                    type="number"
                                    min={1}
                                    max={12}
                                    value={spec.hours}
                                    onChange={(e) =>
                                      handleUpdateShiftBand(row.key, band, 'hours', e.target.value)
                                    }
                                    className="w-16 px-2.5 py-1.5 text-center font-mono text-xs bg-white border border-slate-300 rounded"
                                  />
                                  <span className="text-xs font-mono text-slate-500">h</span>
                                </div>
                              </div>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 2. Eccezioni Orarie di Calendario (Giorno & Turno Specifici) */}
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden space-y-0">
              <div className="px-5 py-3.5 bg-slate-900 text-white flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wider">
                    2. Eccezioni Orarie di Calendario (Per Data e Turno Specifico)
                  </h2>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Sovrascrive l&apos;orario e le ore retribuite di un singolo turno in una data
                    precisa (applicato automaticamente a Solver, Griglia Turni, Totali Ore ed
                    Excel/JPEG).
                  </p>
                </div>
                <span className="text-xs font-mono text-amber-300">
                  {(config.shiftExceptions || []).length} eccezioni attive
                </span>
              </div>

              <form
                onSubmit={handleSaveShiftException}
                className="p-5 bg-slate-50 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 items-end"
              >
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Data Specifica
                  </label>
                  <select
                    value={exDay}
                    onChange={(e) =>
                      handleSelectExceptionDayOrShift(Number(e.target.value), exShiftType)
                    }
                    className="w-full px-3 py-2 text-xs font-mono font-semibold bg-white border border-slate-300 rounded-md"
                  >
                    {config.calendar.map((c) => (
                      <option key={c.day} value={c.day}>
                        {c.dateStr}-{config.year} ({c.dayAbbr})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Turno Specifico
                  </label>
                  <select
                    value={exShiftType}
                    onChange={(e) =>
                      handleSelectExceptionDayOrShift(
                        exDay,
                        e.target.value as 'BAR' | 'MORNING' | 'AFTERNOON'
                      )
                    }
                    className="w-full px-3 py-2 text-xs font-semibold bg-white border border-slate-300 rounded-md"
                  >
                    <option value="MORNING">Solo Turno MATTINA</option>
                    <option value="AFTERNOON">Solo Turno POMERIGGIO</option>
                    <option value="BAR">Solo Turno BAR</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Nuova Stringa Orario
                  </label>
                  <input
                    type="text"
                    value={exLabel}
                    onChange={(e) => setExLabel(e.target.value)}
                    placeholder="Es. 7-12"
                    className="w-full px-3 py-2 text-xs font-mono font-bold text-center bg-white border border-slate-300 rounded-md"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Nuove Ore Retribuite
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={exHours}
                      onChange={(e) => setExHours(Math.max(1, Number(e.target.value) || 1))}
                      className="w-full px-3 py-2 text-xs font-mono font-bold text-center bg-white border border-slate-300 rounded-md"
                    />
                    <span className="text-xs font-mono text-slate-600">ore</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Motivo / Nota (Opz.)
                  </label>
                  <input
                    type="text"
                    value={exNote}
                    onChange={(e) => setExNote(e.target.value)}
                    placeholder="Es. Chiusura anticipata"
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {editingExceptionId ? 'Aggiorna Eccezione' : 'Salva Eccezione'}
                  </button>
                  {editingExceptionId && (
                    <button
                      type="button"
                      onClick={() => setEditingExceptionId(null)}
                      className="px-2.5 py-2 text-xs text-slate-600 bg-slate-200 rounded-md hover:bg-slate-300 cursor-pointer"
                    >
                      Annulla
                    </button>
                  )}
                </div>
              </form>

              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200 font-semibold text-slate-700">
                    <th className="py-3 px-4">Data Calendario</th>
                    <th className="py-3 px-4">Turno Modificato</th>
                    <th className="py-3 px-4">Orario Default Fascia</th>
                    <th className="py-3 px-4">Nuovo Orario Speciale</th>
                    <th className="py-3 px-4">Ore Retribuite</th>
                    <th className="py-3 px-4">Note</th>
                    <th className="py-3 px-4 text-right">Azioni</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {(config.shiftExceptions || []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-slate-500">
                        Nessuna eccezione oraria configurata. Tutti i giorni usano gli orari
                        standard delle fasce settimanali.
                      </td>
                    </tr>
                  ) : (
                    (config.shiftExceptions || []).map((ex) => {
                      const dObj = config.calendar.find((c) => c.day === ex.day);
                      const band = dObj ? getDayBand(dObj) : 'MON_WED';
                      const roleKey = ex.shiftType.toLowerCase() as
                        | 'bar'
                        | 'morning'
                        | 'afternoon';
                      const defaultSpec = config.shiftConfig[roleKey][band];
                      const shiftNameIt =
                        ex.shiftType === 'BAR'
                          ? 'Turno BAR'
                          : ex.shiftType === 'MORNING'
                          ? 'Pulizie MATTINA'
                          : 'Pulizie POMERIGGIO';
                      return (
                        <tr key={ex.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono font-bold text-slate-900">
                            {dObj?.dateStr || ex.dateStr}-{config.year} ({dObj?.dayAbbr || ''})
                          </td>
                          <td className="py-3 px-4 font-bold text-slate-800">{shiftNameIt}</td>
                          <td className="py-3 px-4 font-mono text-slate-500 line-through">
                            {defaultSpec.label} ({defaultSpec.hours}h)
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-emerald-800">
                            {ex.label}
                          </td>
                          <td className="py-3 px-4 font-mono font-bold text-slate-950">
                            {ex.hours} ore
                          </td>
                          <td className="py-3 px-4 text-slate-600">{ex.note || '—'}</td>
                          <td className="py-3 px-4 text-right space-x-2">
                            <button
                              type="button"
                              onClick={() => handleEditShiftException(ex)}
                              className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 cursor-pointer"
                            >
                              Modifica
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteShiftException(ex.id)}
                              className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 cursor-pointer"
                            >
                              Elimina
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
        )}

        {/* SCHEDA 2: PERIODO DI PIANIFICAZIONE, CALENDARIO & FABBISOGNO GIORNALIERO */}
        {activeTab === 'TAB_3_CALENDAR' && (
          <div className="space-y-6">
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h1 className="text-xl font-bold text-slate-900">
                    Scheda 2: Periodo & Fabbisogno (Mensile o Oltre Fine Mese)
                  </h1>
                  <p className="text-sm text-slate-600">
                    Di base la pianificazione è mensile, ma puoi aggiungere giorni extra del mese
                    successivo (es. per chiudere la settimana alla Domenica) oppure scegliere un
                    intervallo di date personalizzato <strong className="text-slate-800">Dal → Al</strong>.
                  </p>
                </div>

                {/* Mode Switcher + Guida Scheda */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePeriodModeSwitch('MONTHLY')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        config.periodMode !== 'CUSTOM_RANGE'
                          ? 'bg-white text-slate-900 shadow-xs font-semibold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Mese + Giorni Extra (Oltre Fine Mese)
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePeriodModeSwitch('CUSTOM_RANGE')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        config.periodMode === 'CUSTOM_RANGE'
                          ? 'bg-white text-slate-900 shadow-xs font-semibold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Intervallo Date Libero (Dal → Al)
                    </button>
                  </div>
                  <HelpGuideButton tabKey="TAB_3_CALENDAR" onOpenGuide={handleOpenGuide} />
                </div>
              </div>

              {/* Period Configuration Controls */}
              <div className="pt-4 border-t border-slate-200 flex flex-wrap items-end justify-between gap-4">
                {config.periodMode !== 'CUSTOM_RANGE' ? (
                  <div className="flex flex-wrap items-end gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Mese Base
                      </label>
                      <select
                        value={config.month}
                        onChange={(e) =>
                          handleMonthYearOrExtraChange(
                            Number(e.target.value),
                            config.year,
                            config.extraDaysAfterMonth || 0
                          )
                        }
                        className="px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-md"
                      >
                        {ITALIAN_MONTHS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.name} ({m.abbr})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Anno</label>
                      <input
                        type="number"
                        min={2024}
                        max={2035}
                        value={config.year}
                        onChange={(e) =>
                          handleMonthYearOrExtraChange(
                            config.month,
                            Number(e.target.value) || 2026,
                            config.extraDaysAfterMonth || 0
                          )
                        }
                        className="w-24 px-3 py-1.5 text-xs font-mono font-semibold bg-white border border-slate-300 rounded-md"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Giorni oltre fine mese (Mese successivo)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={31}
                          value={config.extraDaysAfterMonth || 0}
                          onChange={(e) =>
                            handleMonthYearOrExtraChange(
                              config.month,
                              config.year,
                              Number(e.target.value) || 0
                            )
                          }
                          className="w-20 px-3 py-1.5 text-xs font-mono font-bold bg-white border border-slate-300 rounded-md"
                        />
                        <button
                          type="button"
                          onClick={handleExtendToCompleteSundayWeek}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <CalendarRange className="w-3.5 h-3.5" />
                          Estendi fino a Domenica successiva
                        </button>
                        {(config.extraDaysAfterMonth || 0) > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              handleMonthYearOrExtraChange(config.month, config.year, 0)
                            }
                            className="px-2.5 py-1.5 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                          >
                            Solo mese (0 extra)
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Data Inizio Turnazione
                      </label>
                      <input
                        type="date"
                        value={config.customStartDate || '2026-11-01'}
                        onChange={(e) =>
                          handleCustomDateRangeChange(
                            e.target.value,
                            config.customEndDate || '2026-12-06'
                          )
                        }
                        className="px-3 py-1.5 text-xs font-mono font-semibold bg-white border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Data Fine Turnazione (anche mese successivo)
                      </label>
                      <input
                        type="date"
                        value={config.customEndDate || '2026-12-06'}
                        onChange={(e) =>
                          handleCustomDateRangeChange(
                            config.customStartDate || '2026-11-01',
                            e.target.value
                          )
                        }
                        className="px-3 py-1.5 text-xs font-mono font-semibold bg-white border border-slate-300 rounded-md"
                      />
                    </div>
                    <div className="text-xs text-slate-600 py-1.5">
                      Periodo attivo:{' '}
                      <strong className="font-mono text-slate-900">
                        {formatPeriodLabel(config)}
                      </strong>
                    </div>
                  </div>
                )}

                {/* Bulk Daily Staffing Controls */}
                <div className="flex items-end gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Bar
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={bulkBar}
                      onChange={(e) => setBulkBar(Number(e.target.value) || 0)}
                      className="w-14 px-2 py-1.5 text-xs font-mono text-center bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Mattina
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={bulkMorning}
                      onChange={(e) => setBulkMorning(Number(e.target.value) || 0)}
                      className="w-14 px-2 py-1.5 text-xs font-mono text-center bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Pomeriggio
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={bulkAfternoon}
                      onChange={(e) => setBulkAfternoon(Number(e.target.value) || 0)}
                      className="w-14 px-2 py-1.5 text-xs font-mono text-center bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <button
                    onClick={handleApplyBulkRequirements}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    Applica a Tutto il Periodo
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="overflow-x-auto max-h-[560px]">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 text-xs font-semibold text-slate-700 z-10">
                    <tr>
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">Data</th>
                      <th className="py-3 px-4">Giorno</th>
                      <th className="py-3 px-4 text-center">Festività Speciale</th>
                      <th className="py-3 px-4 text-center">Fabbisogno BAR</th>
                      <th className="py-3 px-4 text-center">Fabbisogno MATTINA</th>
                      <th className="py-3 px-4 text-center">Fabbisogno POMERIGGIO</th>
                      <th className="py-3 px-4 text-right">Totale Operatrici Giorno</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs font-mono tabular-nums">
                    {config.calendar.map((d) => {
                      const isSun = d.dayOfWeek === 0;
                      return (
                        <tr
                          key={d.day}
                          className={`${
                            isSun
                              ? 'bg-emerald-50/30 border-b-2 border-b-[#14532D]'
                              : 'hover:bg-slate-50'
                          }`}
                        >
                          <td className="py-2 px-4 text-slate-400">{d.day}</td>
                          <td className="py-2 px-4 font-bold text-slate-900">{d.dateStr}</td>
                          <td
                            className={`py-2 px-4 font-sans ${
                              isSun || d.isHoliday ? 'font-bold text-[#14532D]' : 'text-slate-700'
                            }`}
                          >
                            {d.dayAbbr}
                          </td>
                          <td className="py-2 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={d.isHoliday}
                              onChange={(e) =>
                                handleUpdateCalendarDay(d.day, { isHoliday: e.target.checked })
                              }
                              className="w-4 h-4 rounded border-slate-300 text-emerald-700 cursor-pointer"
                            />
                          </td>
                          <td className="py-2 px-4 text-center">
                            <input
                              type="number"
                              min={0}
                              max={5}
                              value={d.reqBar}
                              onChange={(e) =>
                                handleUpdateCalendarDay(d.day, {
                                  reqBar: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                              className="w-16 px-2 py-1 text-center bg-[#FEF08A]/50 border border-amber-300 rounded font-bold"
                            />
                          </td>
                          <td className="py-2 px-4 text-center">
                            <input
                              type="number"
                              min={0}
                              max={10}
                              value={d.reqMorning}
                              onChange={(e) =>
                                handleUpdateCalendarDay(d.day, {
                                  reqMorning: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                              className="w-16 px-2 py-1 text-center text-[#DC2626] bg-white border border-slate-300 rounded font-bold"
                            />
                          </td>
                          <td className="py-2 px-4 text-center">
                            <input
                              type="number"
                              min={0}
                              max={10}
                              value={d.reqAfternoon}
                              onChange={(e) =>
                                handleUpdateCalendarDay(d.day, {
                                  reqAfternoon: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                              className="w-16 px-2 py-1 text-center text-black bg-white border border-slate-300 rounded font-bold"
                            />
                          </td>
                          <td className="py-2 px-4 text-right font-bold text-slate-800">
                            {d.reqBar + d.reqMorning + d.reqAfternoon}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* SCHEDA 4: FERIE PER PERIODO & INDISPONIBILITÀ PER GIORNO O TURNO SPECIFICO */}
        {activeTab === 'TAB_4_ABSENCES' && (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  Scheda 4: Periodi di Ferie e Indisponibilità per Giorno o Turno Specifico
                </h1>
                <p className="text-sm text-slate-600">
                  Scegli se inserire un <strong className="text-slate-900">Periodo di Ferie / Assenza plurigiornaliera</strong> per una lavoratrice oppure una{' '}
                  <strong className="text-slate-900">Indisponibilità in un giorno specifico / per un turno specifico</strong> (Bar, Mattina, Pomeriggio o Intera giornata).
                </p>
              </div>

              {/* Quick Mode Switcher + Guida Scheda */}
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <div className="flex items-center gap-1 p-1 bg-slate-200/80 rounded-lg shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSelectAbsMode('VACATION_PERIOD')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      absMode === 'VACATION_PERIOD'
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-700 hover:text-slate-900'
                    }`}
                  >
                    Periodo di Ferie / Assenza (Dal → Al)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectAbsMode('SINGLE_DAY_OR_SHIFT')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      absMode === 'SINGLE_DAY_OR_SHIFT'
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-700 hover:text-slate-900'
                    }`}
                  >
                    Indisponibilità Giorno / Turno Specifico
                  </button>
                </div>
                <HelpGuideButton tabKey="TAB_4_ABSENCES" onOpenGuide={handleOpenGuide} />
              </div>
            </div>

            {/* Surgical Absence / Vacation Form */}
            <form
              onSubmit={handleSaveAbsence}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
                <div className="md:col-span-1">
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Lavoratrice Specifica
                  </label>
                  <select
                    value={absWorkerId}
                    onChange={(e) => setAbsWorkerId(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-semibold bg-white border border-slate-300 rounded-md"
                  >
                    {config.workers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.type})
                      </option>
                    ))}
                  </select>
                </div>

                {absMode === 'VACATION_PERIOD' ? (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-slate-800 mb-1">
                        Data Inizio Periodo
                      </label>
                      <select
                        value={absStartDay}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setAbsStartDay(val);
                          if (absEndDay < val) setAbsEndDay(val);
                        }}
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-md"
                      >
                        {config.calendar.map((d) => (
                          <option key={d.day} value={d.day}>
                            {d.dateStr} ({d.dayAbbr})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-800 mb-1">
                        Data Fine Periodo
                      </label>
                      <select
                        value={absEndDay}
                        onChange={(e) => setAbsEndDay(Number(e.target.value))}
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-md"
                      >
                        {config.calendar.map((d) => (
                          <option key={d.day} value={d.day}>
                            {d.dateStr} ({d.dayAbbr})
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <div className="md:col-span-2">
                    <label className="block text-xs font-semibold text-slate-800 mb-1">
                      Giorno Specifico
                    </label>
                    <select
                      value={absStartDay}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setAbsStartDay(val);
                        setAbsEndDay(val);
                      }}
                      className="w-full px-3 py-2 text-xs font-mono font-semibold bg-white border border-slate-300 rounded-md"
                    >
                      {config.calendar.map((d) => (
                        <option key={d.day} value={d.day}>
                          Giorno {d.dateStr} — {d.dayAbbr}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Causale / Tipologia
                  </label>
                  <select
                    value={absType}
                    onChange={(e) => setAbsType(e.target.value as AbsenceType)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md"
                  >
                    <option value="Ferie">Ferie</option>
                    <option value="Indisponibilità generica">Indisponibilità specifica</option>
                    <option value="Riposo richiesto">Riposo richiesto</option>
                    <option value="Permesso ROL">Permesso ROL</option>
                    <option value="Malattia">Malattia</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1">
                    Turno / Ambito Vietato
                  </label>
                  <select
                    value={absScope}
                    onChange={(e) => setAbsScope(e.target.value as AbsenceScope)}
                    className="w-full px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-md"
                  >
                    <option value="FULL_DAY">Intera Giornata (Nessun turno)</option>
                    <option value="ONLY_MORNING">Solo Turno Mattina (Può Pomeriggio)</option>
                    <option value="ONLY_AFTERNOON">Solo Turno Pomeriggio (Può Mattina)</option>
                    <option value="ONLY_BAR">Solo Turno Bar</option>
                  </select>
                </div>

                <div>
                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {editingAbsenceId ? 'Salva Modifica' : 'Aggiungi Vincolo'}
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2 border-t border-slate-100">
                <input
                  type="text"
                  placeholder="Nota facoltativa (es. Ferie autorizzate, oppure impegno medico mattutino disponibile pomeriggio)..."
                  value={absNote}
                  onChange={(e) => setAbsNote(e.target.value)}
                  className="flex-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-md"
                />
                {editingAbsenceId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingAbsenceId(null);
                      setAbsNote('');
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-md hover:bg-slate-200 cursor-pointer"
                  >
                    Annulla Modifica
                  </button>
                )}
              </div>
            </form>

            {/* Summary Table of Absences */}
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200 text-xs font-semibold text-slate-700">
                    <th className="py-3 px-4">Lavoratrice</th>
                    <th className="py-3 px-4">Giorno / Periodo</th>
                    <th className="py-3 px-4">Tipologia</th>
                    <th className="py-3 px-4">Turno / Ambito Bloccato</th>
                    <th className="py-3 px-4">Note</th>
                    <th className="py-3 px-4 text-right">Azioni</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {config.absences.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        Nessuna ferie o indisponibilità registrata per questo periodo.
                      </td>
                    </tr>
                  ) : (
                    config.absences.map((a) => {
                      const w = config.workers.find((x) => x.id === a.workerId);
                      const dStart = config.calendar.find((c) => c.day === a.startDay)?.dateStr;
                      const dEnd = config.calendar.find((c) => c.day === a.endDay)?.dateStr;
                      const numDays = a.endDay - a.startDay + 1;
                      return (
                        <tr key={a.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-bold text-slate-900">
                            {w?.name || a.workerId}
                          </td>
                          <td className="py-3 px-4 font-mono">
                            {a.startDay === a.endDay ? (
                              <span className="font-semibold text-slate-900">
                                {dStart || `Giorno ${a.startDay}`} (1 gg)
                              </span>
                            ) : (
                              <span className="font-semibold text-slate-900">
                                {dStart} → {dEnd} ({numDays} gg)
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-800">{a.type}</td>
                          <td className="py-3 px-4 text-slate-700 font-medium">
                            {scopeLabelMap[a.scope]}
                          </td>
                          <td className="py-3 px-4 text-slate-500">{a.note || '—'}</td>
                          <td className="py-3 px-4 text-right space-x-2">
                            <button
                              onClick={() => handleEditAbsence(a)}
                              className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 cursor-pointer"
                            >
                              Modifica
                            </button>
                            <button
                              onClick={() => handleDeleteAbsence(a.id)}
                              className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 cursor-pointer"
                            >
                              Elimina
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
        )}

        {/* SCHEDA 5: VINCOLI CCNL & PESI DI EQUITÀ */}
        {activeTab === 'TAB_5_CCNL' && (
          <div className="space-y-6 max-w-4xl">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-slate-200 rounded-lg p-5">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  Scheda 5: Vincoli CCNL & Pareggio Carico di Lavoro
                </h1>
                <p className="text-sm text-slate-600">
                  Regola i vincoli normativi obbligatori (riposo minimo 11 ore tra turni, riposo
                  settimanale, giorni consecutivi) e i pesi della funzione obiettivo CP-SAT.
                </p>
              </div>
              <HelpGuideButton tabKey="TAB_5_CCNL" onOpenGuide={handleOpenGuide} />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-200">
              {/* Toggle Pomeriggio -> Mattina */}
              <div className="p-5 flex items-center justify-between gap-6">
                <div>
                  <div className="text-sm font-bold text-slate-900">
                    Regola CCNL &quot;Pomeriggio → Mattina/Bar vietata&quot; (11 ore di riposo)
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    Impedisce di assegnare un turno Mattina (<code className="font-mono">7-13</code>/
                    <code className="font-mono">7-14</code>) o Bar (
                    <code className="font-mono">6-12</code>/<code className="font-mono">6-13</code>)
                    se il giorno precedente la lavoratrice ha svolto il turno Pomeriggio (
                    <code className="font-mono">14-20</code>/<code className="font-mono">14-21</code>
                    ).
                  </div>
                </div>
                <label className="inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={config.constraints.forbidAfternoonToMorning}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          forbidAfternoonToMorning: e.target.checked,
                        },
                      }))
                    }
                    className="w-5 h-5 rounded border-slate-300 text-slate-900 cursor-pointer"
                  />
                  <span className="ml-2 text-xs font-bold text-slate-900">
                    {config.constraints.forbidAfternoonToMorning ? 'ATTIVA' : 'DISATTIVATA'}
                  </span>
                </label>
              </div>

              {/* Max consecutive days & Weekly rest */}
              <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-900 mb-2">
                    <span>Massimo giorni consecutivi lavorabili</span>
                    <span className="font-mono">
                      {config.constraints.maxConsecutiveDays} giorni
                    </span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={10}
                    value={config.constraints.maxConsecutiveDays}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          maxConsecutiveDays: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                  <div className="text-[11px] text-slate-500 mt-1">
                    Default CCNL Turismo: 6 giorni consecutivi massimi.
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-900 mb-2">
                    <span>Minimo giorni di riposo settimanali (Lun-Dom)</span>
                    <span className="font-mono">
                      {config.constraints.minWeeklyRestDays} gg / sett.
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={2}
                    value={config.constraints.minWeeklyRestDays}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          minWeeklyRestDays: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                  <div className="text-[11px] text-slate-500 mt-1">
                    Garantisce almeno 1 (o 2) giorni di riposo in ogni settimana completa Lun-Dom.
                  </div>
                </div>
              </div>

              {/* Limite Pomeriggi Consecutivi (Max 3 invalicabile, Preferibilmente 2) */}
              <div className="p-5 bg-amber-50/40 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-900 mb-2">
                    <span>Limite massimo Pomeriggi consecutivi (Vincolo Rigido)</span>
                    <span className="font-mono text-red-700 font-bold">
                      Max {config.constraints.maxConsecutiveAfternoons ?? 3} Pomeriggi
                    </span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={3}
                    value={config.constraints.maxConsecutiveAfternoons ?? 3}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          maxConsecutiveAfternoons: val,
                          preferredConsecutiveAfternoons: Math.min(
                            val,
                            prev.constraints.preferredConsecutiveAfternoons ?? 2
                          ),
                        },
                      }));
                    }}
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                  <div className="text-[11px] text-slate-600 mt-1">
                    Regola invalicabile: nessuna lavoratrice può mai fare più di{' '}
                    <strong>{config.constraints.maxConsecutiveAfternoons ?? 3} pomeriggi consecutivi</strong>.
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-bold text-slate-900 mb-2">
                    <span>Target ideale Pomeriggi consecutivi (Preferenza Ottimizzatore)</span>
                    <span className="font-mono text-emerald-800 font-bold">
                      Preferibilmente {config.constraints.preferredConsecutiveAfternoons ?? 2}{' '}
                      Pomeriggi
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={config.constraints.maxConsecutiveAfternoons ?? 3}
                    value={config.constraints.preferredConsecutiveAfternoons ?? 2}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          preferredConsecutiveAfternoons: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                  <div className="text-[11px] text-slate-600 mt-1">
                    Il solver assegna preferibilmente blocchi da{' '}
                    <strong>{config.constraints.preferredConsecutiveAfternoons ?? 2} pomeriggi consecutivi</strong>{' '}
                    prima del riposo, arrivando a 3 solo se indispensabile per coprire il turno.
                  </div>
                </div>
              </div>

              {/* Equity Sliders 1..5 */}
              <div className="p-5 space-y-5">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Pesi Funzione Obiettivo di Equità (Sliders da 1 a 5)
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-900 mb-1.5">
                    <span>
                      Pareggio rigoroso ore totali tra le lavoratrici Fisse (a parità di giorni
                      disponibili)
                    </span>
                    <span className="font-mono">
                      Peso: {config.constraints.weightMonthlyHoursEquity} / 5
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={config.constraints.weightMonthlyHoursEquity}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          weightMonthlyHoursEquity: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-900 mb-1.5">
                    <span>Bilanciamento carico Mattine / Pomeriggi tra le Fisse</span>
                    <span className="font-mono">
                      Peso: {config.constraints.weightMorningAfternoonBalance} / 5
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={config.constraints.weightMorningAfternoonBalance}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          weightMorningAfternoonBalance: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-900 mb-1.5">
                    <span>Rotazione Domeniche libere</span>
                    <span className="font-mono">
                      Peso: {config.constraints.weightSundayRotation} / 5
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={config.constraints.weightSundayRotation}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          weightSundayRotation: Number(e.target.value),
                        },
                      }))
                    }
                    className="w-full accent-slate-900 cursor-pointer"
                  />
                </div>
              </div>

              {/* Historical Balancing Toggle */}
              <div className="p-5 flex items-center justify-between gap-6 bg-slate-50/70">
                <div>
                  <div className="text-sm font-bold text-slate-900">
                    Bilanciamento Storico Multi-Mese (Ferie, Domeniche e Rotazioni Turni)
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    Il solver accede allo storico delle pianificazioni salvate in{' '}
                    <code className="font-mono">localStorage</code> / File System per compensare i
                    giorni di ferie pregressi, ruotare le domeniche/festività e pareggiare le ore
                    rispetto al target di 160h/mese.
                  </div>
                </div>
                <label className="inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={config.constraints.useHistoricalEquity !== false}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        constraints: {
                          ...prev.constraints,
                          useHistoricalEquity: e.target.checked,
                        },
                      }))
                    }
                    className="w-5 h-5 rounded border-slate-300 text-slate-900 cursor-pointer"
                  />
                  <span className="ml-2 text-xs font-bold text-slate-900">
                    {config.constraints.useHistoricalEquity !== false ? 'ATTIVO' : 'DISATTIVATO'}
                  </span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* SCHEDA 6: GENERAZIONE, ANTEPRIMA & ESPORTAZIONE */}
        {activeTab === 'TAB_6_SOLVE' && (
          <div className="space-y-6">
            {/* Action Bar */}
            <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  <h1 className="text-xl font-bold text-slate-900">
                    Scheda 6: Generazione, Bilanciamento Mattine/Pomeriggi & Esportazione
                  </h1>
                  <span className="text-xs font-mono text-slate-500">
                    ({solution.solveTimeMs} ms · {config.calendar.length} giorni)
                  </span>
                </div>
                <p className="text-sm text-slate-600">
                  Periodo pianificato:{' '}
                  <strong className="text-slate-900">{formatPeriodLabel(config)}</strong>. Esporta
                  il file <strong className="text-slate-900">JPEG per le lavoratrici</strong>{' '}
                  (pulito, senza la tabella del calcolo ore in fondo) oppure il file{' '}
                  <strong className="text-slate-900">Excel (.xlsx)</strong> gestionale.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  onClick={handleRecalculateTrigger}
                  disabled={isSolving}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  {isSolving ? 'Ricalcolo...' : 'Ricalcola Turni'}
                </button>

                <button
                  onClick={() => setIsInsightsModalOpen(true)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    solution.solveInsights.hasConflicts
                      ? 'bg-red-600 text-white hover:bg-red-700 animate-pulse'
                      : 'bg-slate-100 text-slate-800 border border-slate-300 hover:bg-slate-200'
                  }`}
                >
                  <ShieldAlert className="w-4 h-4" />
                  Solve Insights
                  {solution.solveInsights.hasConflicts && (
                    <span className="px-1.5 py-0.5 text-[10px] bg-white text-red-700 rounded font-mono">
                      {solution.solveInsights.totalUncoveredShifts} conflitti
                    </span>
                  )}
                </button>

                <button
                  onClick={() =>
                    exportScheduleToJpeg(config, solution, { includeSummaryFooter: false })
                  }
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-slate-950 bg-[#FEF08A] border border-amber-400 rounded-lg hover:bg-amber-200 transition-colors cursor-pointer whitespace-nowrap shadow-2xs"
                >
                  <ImageIcon className="w-4 h-4" />
                  Esporta JPEG Lavoratrici (Senza Tabella Ore)
                </button>

                <button
                  onClick={() =>
                    exportScheduleToJpeg(config, solution, { includeSummaryFooter: true })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  JPEG Completo (Con Totali)
                </button>

                <button
                  onClick={() => exportScheduleToExcel(config, solution)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Esporta Excel (.xlsx)
                </button>

                <HelpGuideButton tabKey="TAB_6_SOLVE" onOpenGuide={handleOpenGuide} />
              </div>
            </div>

            {/* Interactive Alert & Conflict Inspection System ([ 🔍 Vai al Problema ] / [ 👁️ Mostra Dettaglio ]) */}
            <ScheduleConflictInspector
              config={config}
              solution={solution}
              onInspectTargetInTable={(target) => {
                setHighlightedTarget(target);
              }}
              onApplySuggestion={handleApplySuggestion}
              onManualCellChange={handleManualCellChange}
              onSimulateConflictDemo={handleSimulateConflictDemo}
            />

            {/* Workload Equity & Balance Table for Fisso Workers */}
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Scale className="w-4 h-4 text-slate-800" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    Controllo Equità Ore, Mattine, Pomeriggi & Domenica Libera (Tutte le Lavoratrici Fisse inclusa Ioana)
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 font-mono">
                  <span>
                    Scarto Max Ore (inclusa Ioana):{' '}
                    <strong className="text-emerald-700">{solution.hoursSpreadFisse}h</strong>
                  </span>
                  <span>
                    Scarto Mattine/Diurni:{' '}
                    <strong className="text-emerald-700">
                      max {solution.morningSpreadFisse} turno
                    </strong>
                  </span>
                  <span>
                    Scarto Pomeriggi:{' '}
                    <strong className="text-emerald-700">
                      max {solution.afternoonSpreadFisse} turno
                    </strong>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold">
                    ≥ 1 Dom. Libera / Mese Garantita
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-2.5">
                {fissoWorkersList.map((w) => {
                  const st = solution.workerStats[w.id];
                  const hasAbs = (st?.absenceDays || 0) > 0;
                  const sundayDays = config.calendar.filter((c) => c.dayOfWeek === 0);
                  const freeSundays = sundayDays
                    .filter((c) => solution.assignments[c.day]?.[w.id]?.shiftType === 'OFF')
                    .map((c) => c.day);
                  return (
                    <div
                      key={w.id}
                      className="p-2.5 rounded border border-slate-200 bg-slate-50/70 flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold text-slate-900 truncate">{w.name}</span>
                        <span className="text-[10px] font-mono text-slate-500">
                          {w.maxWeeklyHours}h/s
                        </span>
                      </div>
                      <div className="my-1.5 flex items-baseline justify-between">
                        <span className="text-base font-mono font-bold text-slate-950">
                          {st?.totalHours || 0}h
                        </span>
                        <span className="text-[11px] font-mono text-slate-600">
                          {st?.workedDays || 0} turni
                        </span>
                      </div>
                      <div className="text-[11px] font-mono flex items-center justify-between border-t border-slate-200/80 pt-1.5">
                        <span className="text-[#DC2626] font-semibold">
                          Mat:{st?.morningCount || 0}
                        </span>
                        <span className="text-black font-bold">
                          Pom:{st?.afternoonCount || 0}
                        </span>
                        {(st?.barCount || 0) > 0 && (
                          <span className="bg-[#FEF08A] text-slate-950 px-1 rounded-xs font-bold">
                            Bar:{st?.barCount}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 pt-1 border-t border-slate-200/60 flex items-center justify-between text-[10px] font-mono">
                        <span className="text-slate-600">Dom. Libera:</span>
                        <span
                          className={`font-bold px-1.5 py-0.2 rounded ${
                            freeSundays.length >= 1
                              ? 'bg-emerald-100 text-emerald-900'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {freeSundays.length > 0
                            ? `Dom ${freeSundays.join(', ')}`
                            : 'Nessuna'}
                        </span>
                      </div>
                      {hasAbs && (
                        <div className="mt-1 text-[10px] text-amber-700 font-mono font-semibold">
                          Assenze: {st?.absenceDays} gg
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Diagnostic Log Panel */}
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Log Diagnostico Ottimizzatore & Copertura Giornaliera
                </span>
                <span className="text-xs text-slate-500">
                  Stato:{' '}
                  {solution.status === 'OPTIMAL'
                    ? 'Ottimale (100% Copertura)'
                    : 'Conflitto Rilevato'}
                </span>
              </div>
              <div className="space-y-1.5">
                {solution.diagnostics.map((diag, idx) => (
                  <div
                    key={idx}
                    className={`flex items-start gap-2.5 text-xs p-2.5 rounded border ${
                      diag.level === 'ERROR'
                        ? 'bg-red-50 border-red-200 text-red-900'
                        : diag.level === 'WARNING'
                        ? 'bg-amber-50 border-amber-200 text-amber-900'
                        : 'bg-slate-50 border-slate-200 text-slate-800'
                    }`}
                  >
                    {diag.level === 'ERROR' ? (
                      <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    ) : diag.level === 'INFO' && idx === 0 ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    ) : (
                      <Info className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" />
                    )}
                    <span className="leading-relaxed">{diag.message}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Exact Paper Model Preview Table (Clean without bottom hours summary table) */}
            <SchedulePaperTable
              config={config}
              solution={solution}
              showSummaryFooter={false}
              highlightedTarget={highlightedTarget}
              onClearHighlight={() => setHighlightedTarget(null)}
              onManualCellChange={handleManualCellChange}
            />

            {/* Sezione Analisi Economica: Stima Costo Personale per Mese e Categoria */}
            <EconomicAnalysisSection
              config={config}
              solution={solution}
              onUpdateWorkerHourlyRate={handleUpdateWorkerHourlyRate}
              onApplyBulkHourlyRate={handleApplyBulkHourlyRate}
              onUpdateWorkerHolidaySurcharge={handleUpdateWorkerHolidaySurcharge}
              onApplyBulkHolidaySurcharge={handleApplyBulkHolidaySurcharge}
            />

            {/* Sezione Scheda 6: Modulo Grafico Recharts & Persistenza Storico (localStorage / File System) */}
            <HistoricalAnalyticsSection
              config={config}
              solution={solution}
              onUpdateHistory={(newHistory: ConfirmedScheduleEntry[]) =>
                setConfig((prev) => ({
                  ...prev,
                  history: newHistory,
                }))
              }
              onToggleHistoricalEquity={(enabled: boolean) =>
                setConfig((prev) => ({
                  ...prev,
                  constraints: {
                    ...prev.constraints,
                    useHistoricalEquity: enabled,
                  },
                }))
              }
            />
          </div>
        )}

        {/* SCHEDA DEDICATA: STORICO TURNI (ARCHIVIO CRONOLOGICO MENSILE) */}
        {activeTab === 'TAB_HISTORY' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-5 py-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Scheda 8: Storico Turni &amp; Archivio Mensile
              </div>
              <HelpGuideButton tabKey="TAB_HISTORY" onOpenGuide={handleOpenGuide} />
            </div>
            <ScheduleHistoryTab
              config={config}
              solution={solution}
              onUpdateHistory={(newHistory: ConfirmedScheduleEntry[]) =>
                setConfig((prev) => ({
                  ...prev,
                  history: newHistory,
                }))
              }
              onLoadHistoryEntryIntoWorkspace={(entryConfig: AppConfig) => {
                setConfig((prev) => ({
                  ...entryConfig,
                  workers: prev.workers, // Preserve current renamed worker names & numeric IDs
                  history: prev.history,
                }));
                setActiveTab('TAB_6_SOLVE');
              }}
            />
          </div>
        )}

        {/* SCHEDA DEDICATA: ANALISI ECONOMICA & STIMA COSTI PERSONALE */}
        {activeTab === 'TAB_ECONOMICS' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-5 py-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Scheda 7: Analisi Costi &amp; Stima Spesa Personale
              </div>
              <HelpGuideButton tabKey="TAB_ECONOMICS" onOpenGuide={handleOpenGuide} />
            </div>
            <EconomicAnalysisSection
              config={config}
              solution={solution}
              onUpdateWorkerHourlyRate={handleUpdateWorkerHourlyRate}
              onApplyBulkHourlyRate={handleApplyBulkHourlyRate}
              onUpdateWorkerHolidaySurcharge={handleUpdateWorkerHolidaySurcharge}
              onApplyBulkHolidaySurcharge={handleApplyBulkHolidaySurcharge}
            />
          </div>
        )}

        {/* SCHEDA 7: DELIVERABLE CODICE PYTHON WINDOWS (.EXE) */}
        {activeTab === 'TAB_7_WINDOWS_CODE' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-5 py-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Sorgente Desktop Windows (.exe) &amp; Installatore Automatico
              </div>
              <HelpGuideButton tabKey="TAB_7_WINDOWS_CODE" onOpenGuide={handleOpenGuide} />
            </div>
            <PythonDeliverableView config={config} />
          </div>
        )}
      </main>

      {/* Footer Fisso / A Fondo Pagina con Firma "Creato da Raffaele Tarallo" */}
      <footer className="bg-white border-t border-slate-200 px-6 py-3 mt-auto">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-700">Turni di Lavoro RT</span>
            <span>·</span>
            <span>Airport Motel Malpensa</span>
          </div>
          <div className="font-semibold text-slate-800 tracking-wide">
            Creato da Raffaele Tarallo
          </div>
        </div>
      </footer>

      {/* Solve Insights Modal (Appears automatically if optimizer fails or opened on-demand) */}
      <SolveInsightsModal
        isOpen={isInsightsModalOpen}
        onClose={() => setIsInsightsModalOpen(false)}
        insights={solution.solveInsights}
        onApplySuggestion={handleApplySuggestion}
        onApplyAllHighPriority={handleApplyAllSuggestions}
        onSimulateConflictDemo={handleSimulateConflictDemo}
      />

      {/* Confirmation Modal when > 3 Consecutive Afternoons is Indispensable or Manually Requested */}
      {(isAfternoonOverflowModalOpen || pendingManualAfternoon !== null) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
          <div className="bg-white border border-amber-300 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
            <div className="px-5 py-4 bg-amber-600 text-white flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-100 shrink-0" />
                <h3 className="text-sm font-bold">
                  Richiesta Conferma: Superamento Limite 3 Pomeriggi Consecutivi
                </h3>
              </div>
            </div>

            <div className="p-5 space-y-4 text-xs text-slate-700 leading-relaxed">
              {pendingManualAfternoon ? (
                <>
                  <p className="font-semibold text-slate-900">
                    Stai assegnando manualmente un turno di Pomeriggio che supera il limite massimo
                    di 3 pomeriggi consecutivi:
                  </p>
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1">
                    <div>
                      <strong>Lavoratrice:</strong> {pendingManualAfternoon.workerName}
                    </div>
                    <div>
                      <strong>Giorno selezionato:</strong> {pendingManualAfternoon.dateStr}
                    </div>
                    <div>
                      <strong>Pomeriggi consecutivi risultanti:</strong>{' '}
                      <span className="font-bold text-red-700">
                        {pendingManualAfternoon.consecutiveCount} pomeriggi di fila
                      </span>{' '}
                      (limite standard: massimo 3)
                    </div>
                  </div>
                  <p>
                    La regola prevede che nessuno svolga più di <strong>3 pomeriggi consecutivi</strong>{' '}
                    a meno che non sia strettamente indispensabile. Confermi di voler autorizzare
                    questa eccezione?
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-slate-900">
                    Durante la generazione dell&apos;orario è emerso che, per non lasciare turni di
                    Pomeriggio scoperti, è strettamente indispensabile superare i 3 pomeriggi
                    consecutivi nei seguenti casi:
                  </p>
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5 max-h-44 overflow-y-auto">
                    {(solution.indispensableAfternoonExceptions || []).map((ex, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2 border-b border-amber-200/60 last:border-0 pb-1 last:pb-0">
                        <span className="font-bold text-slate-900">
                          {ex.workerName} — {ex.dateStr} ({ex.dayAbbr})
                        </span>
                        <span className="px-2 py-0.5 bg-red-100 text-red-800 font-bold rounded">
                          {ex.consecutiveCount}° pomeriggio consecutivo
                        </span>
                      </div>
                    ))}
                  </div>
                  <p>
                    Nessun&apos;altra lavoratrice attiva può coprire questi turni rispettando ferie,
                    abilitazioni e riposo CCNL di 11 ore. Vuoi autorizzare in via eccezionale il
                    superamento dei 3 pomeriggi consecutivi solo per coprire questi turni indispensabili?
                  </p>
                </>
              )}
            </div>

            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  if (pendingManualAfternoon) {
                    setPendingManualAfternoon(null);
                  } else {
                    setIsAfternoonOverflowModalOpen(false);
                    setConfig((prev) => ({
                      ...prev,
                      constraints: {
                        ...prev.constraints,
                        allowEmergencyAfternoonOverflow: false,
                      },
                    }));
                  }
                }}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                No, mantieni blocco rigido (Max 3 Pomeriggi)
              </button>
              <button
                type="button"
                onClick={() => {
                  if (pendingManualAfternoon) {
                    const { day, workerId } = pendingManualAfternoon;
                    setManualCellOverrides((prev) => ({
                      ...prev,
                      [day]: {
                        ...(prev[day] || {}),
                        [workerId]: 'AFTERNOON',
                      },
                    }));
                    setPendingManualAfternoon(null);
                  } else {
                    setIsAfternoonOverflowModalOpen(false);
                    setConfig((prev) => ({
                      ...prev,
                      constraints: {
                        ...prev.constraints,
                        allowEmergencyAfternoonOverflow: true,
                      },
                    }));
                  }
                }}
                className="px-4 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-lg cursor-pointer"
              >
                Sì, confermo eccezione indispensabile (&gt; 3 Pomeriggi)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Help / Tutorial Modal for Every Tab ([ ❓ Guida Scheda ]) */}
      <TabHelpModal
        isOpen={isHelpModalOpen}
        activeGuideKey={activeGuideKey}
        onSelectGuideKey={(k) => setActiveGuideKey(k)}
        onClose={() => setIsHelpModalOpen(false)}
      />

      {/* Global Windows 11 Style Tooltip System (450ms hover delay on any control) */}
      <GlobalTooltipSystem />
    </div>
  );
}
