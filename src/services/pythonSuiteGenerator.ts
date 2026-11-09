import JSZip from 'jszip';
import { AppConfig } from '../types';
import { HOTEL_LOGO_BASE64, APP_ICON_BASE64 } from '../hotelLogoAsset';

export interface PythonDeliverableFile {
  filename: string;
  description: string;
  code: string;
}

export function getPythonSuiteFiles(config: AppConfig): PythonDeliverableFile[] {
  const defaultProfileJson = JSON.stringify(config, null, 2);

  const solverPy = `"""
solver.py — Motore di Ottimizzazione Matematica Turni (Google OR-Tools CP-SAT)
Risolve la pianificazione (mensile o multi-settimanale oltre fine mese) garantendo:
1. Copertura esatta giornaliera per Bar, Mattina e Pomeriggio.
2. Compatibilità mansioni abilitate per ciascuna lavoratrice.
3. Rispetto chirurgico di Periodi di Ferie, Malattia, ROL e Indisponibilità per giorno specifico o singolo turno (Bar, Mattina, Pomeriggio).
4. Regola CCNL 11 ore di riposo: vietato Turno Mattina/Bar se il giorno precedente si è svolto Pomeriggio.
5. Riposo settimanale minimo (Lun-Dom), max ore contrattuali settimanali e max giorni consecutivi.
6. Priorità organico rigorosa: le Sostitute (Caterina, SIG.RA PATRIZIA) vengono attivate solo se le Fisse non bastano.
7. PAREGGIO RIGOROSO DEL CARICO DI LAVORO (ORE E GIORNI) TRA LE LAVORATRICI FISSE:
   Minimizza lo scarto (Max - Min) e la deviazione assoluta rispetto al monte ore target proporzionale ai giorni di presenza effettiva.
"""

from typing import Dict, Any, List
from ortools.sat.python import cp_model


def get_day_band(day_req: Dict[str, Any]) -> str:
    if day_req.get("dayOfWeek") == 0 or day_req.get("isHoliday", False):
        return "SUN_HOL"
    if 1 <= day_req.get("dayOfWeek", 1) <= 3:
        return "MON_WED"
    return "THU_SAT"


def get_shift_spec(config: Dict[str, Any], day_req: Dict[str, Any], shift_type: str) -> Dict[str, Any]:
    for ex in config.get("shiftExceptions", []):
        if ex.get("shiftType") == shift_type and (
            ex.get("day") == day_req.get("day")
            or (ex.get("isoDate") and ex.get("isoDate") == day_req.get("isoDate"))
            or ex.get("dateStr") == day_req.get("dateStr")
        ):
            return {"label": str(ex.get("label", "")), "hours": int(ex.get("hours", 6))}
    band = get_day_band(day_req)
    key = shift_type.lower()
    return config["shiftConfig"][key][band]


def is_worker_blocked(worker: Dict[str, Any], day: int, shift_type: str, absences: List[Dict[str, Any]]) -> bool:
    if not worker.get("active", True):
        return True
    if worker.get("type") == "Sostituta" and int(worker.get("priority", 1)) >= 5:
        return True
    if shift_type == "BAR" and not worker.get("canBar", False):
        return True
    if shift_type == "MORNING" and not worker.get("canMorning", False):
        return True
    if shift_type == "AFTERNOON" and not worker.get("canAfternoon", False):
        return True

    for abs_rec in absences:
        if abs_rec["workerId"] == worker["id"] and abs_rec["startDay"] <= day <= abs_rec["endDay"]:
            scope = abs_rec["scope"]
            if scope == "FULL_DAY":
                return True
            if scope == "ONLY_BAR" and shift_type == "BAR":
                return True
            if scope == "ONLY_MORNING" and shift_type == "MORNING":
                return True
            if scope == "ONLY_AFTERNOON" and shift_type == "AFTERNOON":
                return True
    return False


def is_full_day_absent(worker_id: str, day: int, absences: List[Dict[str, Any]]) -> bool:
    for abs_rec in absences:
        if abs_rec["workerId"] == worker_id and abs_rec["scope"] == "FULL_DAY":
            if abs_rec["startDay"] <= day <= abs_rec["endDay"]:
                return True
    return False


def diagnose_conflicts(config: Dict[str, Any]) -> List[str]:
    """Analizza preventivamente se in qualche giorno le assenze superano la disponibilità fisica per turno."""
    diagnostics = []
    workers = [w for w in config["workers"] if w.get("active", True)]
    absences = config.get("absences", [])

    for day_req in config["calendar"]:
        d = day_req["day"]
        d_str = day_req["dateStr"]
        for s_type, req_key, label_it in [
            ("BAR", "reqBar", "Bar"),
            ("MORNING", "reqMorning", "Mattina"),
            ("AFTERNOON", "reqAfternoon", "Pomeriggio"),
        ]:
            needed = day_req.get(req_key, 0)
            avail = [w["name"] for w in workers if not is_worker_blocked(w, d, s_type, absences)]
            if len(avail) < needed:
                diagnostics.append(
                    f"Giorno {d_str}: fabbisogno {label_it} ({needed}) non copribile per troppe assenze/indisponibilità concomitanti (solo {len(avail)} abilitate disponibili)."
                )
        total_needed = day_req.get("reqBar", 0) + day_req.get("reqMorning", 0) + day_req.get("reqAfternoon", 0)
        any_avail = [
            w["name"]
            for w in workers
            if not (
                is_worker_blocked(w, d, "BAR", absences)
                and is_worker_blocked(w, d, "MORNING", absences)
                and is_worker_blocked(w, d, "AFTERNOON", absences)
            )
        ]
        if len(any_avail) < total_needed:
            diagnostics.append(
                f"Giorno {d_str}: fabbisogno totale ({total_needed} turni) superiore al totale lavoratrici presenti ({len(any_avail)})."
            )
    return diagnostics


def analyze_sunday_history_last_3_months(
    config: Dict[str, Any], workers: List[Dict[str, Any]]
) -> Dict[str, Dict[str, Any]]:
    """
    Analizza esplicitamente la storia delle domeniche lavorate negli ultimi 3 mesi
    tramite la lista 'history' (o '_history_records') presente nel config.
    Restituisce per ogni lavoratrice:
    - sundays_worked_3m: totale domeniche lavorate negli ultimi 3 mesi
    - total_sundays_3m: totale domeniche presenti negli ultimi 3 mesi analizzati
    - trailing_consec_sundays: domeniche consecutive lavorate a fine mese precedente (0..3)
    - last_free_sunday_slot: indice (0..3) dell'ultima domenica di riposo goduta
    - months_analyzed: numero di mesi storici analizzati (max 3)
    """
    raw_history = config.get("history") or config.get("_history_records") or []
    curr_m = int(config.get("month", 0))
    curr_y = int(config.get("year", 0))

    past_records = []
    for rec in raw_history:
        if not isinstance(rec, dict):
            continue
        rm = int(rec.get("month", rec.get("configSnapshot", {}).get("month", 0)))
        ry = int(rec.get("year", rec.get("configSnapshot", {}).get("year", 0)))
        if rm == curr_m and ry == curr_y:
            continue
        past_records.append((ry, rm, rec))

    # Ordina cronologicamente (dal più vecchio al più recente) e prendi gli ultimi 3 mesi
    past_records.sort(key=lambda item: (item[0], item[1]))
    last_3m = past_records[-3:]

    result: Dict[str, Dict[str, Any]] = {}
    for w_idx, w in enumerate(workers):
        wid = str(w["id"])
        sunday_timeline: List[int] = []  # 1 = Domenica lavorata, 0 = Domenica di riposo
        last_free_slot = (w_idx + len(last_3m)) % 4

        for m_idx, (ry, rm, rec) in enumerate(last_3m):
            cal_snap = rec.get("calendar") or rec.get("configSnapshot", {}).get("calendar") or []
            ass_snap = rec.get("assignments") or rec.get("solutionSnapshot", {}).get("assignments") or {}
            w_stats = rec.get("workerStats") or rec.get("solutionSnapshot", {}).get("workerStats") or {}

            sun_days_in_rec = [
                int(d_req["day"]) for d_req in cal_snap if int(d_req.get("dayOfWeek", -1)) == 0
            ]

            if sun_days_in_rec and ass_snap:
                for s_idx, s_day in enumerate(sun_days_in_rec):
                    day_map = ass_snap.get(s_day) or ass_snap.get(str(s_day)) or {}
                    cell = day_map.get(wid) or day_map.get(w["id"]) or {}
                    st_type = cell.get("shiftType", "OFF") if isinstance(cell, dict) else str(cell)
                    worked = 1 if st_type not in ("OFF", "", None) else 0
                    sunday_timeline.append(worked)
                    if worked == 0:
                        last_free_slot = s_idx % 4
            else:
                # Ricostruzione deterministica della rotazione domenicale dalle statistiche mensili
                st = w_stats.get(wid) or w_stats.get(w["id"]) or {}
                num_sun_m = len(sun_days_in_rec) if sun_days_in_rec else 4
                sun_worked = min(num_sun_m, max(0, int(st.get("sundaysWorked", 0))))
                rest_count = max(0, num_sun_m - sun_worked)
                free_slots = {
                    (w_idx + m_idx + r_i * 2) % num_sun_m for r_i in range(rest_count)
                }
                for s_idx in range(num_sun_m):
                    if s_idx in free_slots:
                        sunday_timeline.append(0)
                        last_free_slot = s_idx % 4
                    else:
                        sunday_timeline.append(1)

        trailing_consec = 0
        for val in reversed(sunday_timeline):
            if val == 1:
                trailing_consec += 1
            else:
                break

        result[wid] = {
            "sundays_worked_3m": sum(sunday_timeline),
            "total_sundays_3m": len(sunday_timeline),
            "trailing_consec_sundays": min(3, trailing_consec),
            "last_free_sunday_slot": last_free_slot,
            "months_analyzed": len(last_3m),
        }

    return result


def solve_schedule(config: Dict[str, Any], time_limit_sec: float = 2.8) -> Dict[str, Any]:
    pre_diag = diagnose_conflicts(config)
    model = cp_model.CpModel()

    workers = [w for w in config["workers"] if w.get("active", True)]
    workers.sort(key=lambda w: (0 if w["type"] == "Fisso" else 1, w.get("priority", 0)))

    calendar = config["calendar"]
    num_days = len(calendar)
    absences = config.get("absences", [])
    constraints_cfg = config["constraints"]
    shifts = ["BAR", "MORNING", "AFTERNOON"]

    # Variabili decisionali booleane: x[(w_id, day, shift)] in {0, 1}
    x = {}
    for w in workers:
        w_id = w["id"]
        for day_req in calendar:
            d = day_req["day"]
            for s in shifts:
                var = model.NewBoolVar(f"x_{w_id}_{d}_{s}")
                x[(w_id, d, s)] = var
                if is_worker_blocked(w, d, s, absences):
                    model.Add(var == 0)

    # 1. Al massimo 1 turno al giorno per ciascuna lavoratrice
    for w in workers:
        w_id = w["id"]
        for day_req in calendar:
            d = day_req["day"]
            model.Add(sum(x[(w_id, d, s)] for s in shifts) <= 1)

    # 2. Copertura esatta giornaliera per Bar, Mattina e Pomeriggio
    for day_req in calendar:
        d = day_req["day"]
        model.Add(sum(x[(w["id"], d, "BAR")] for w in workers) == day_req["reqBar"])
        model.Add(sum(x[(w["id"], d, "MORNING")] for w in workers) == day_req["reqMorning"])
        model.Add(sum(x[(w["id"], d, "AFTERNOON")] for w in workers) == day_req["reqAfternoon"])

    # 3. Sequenza CCNL 11 ore di riposo: vietato Pomeriggio (giorno d) -> Mattina o Bar (giorno d+1)
    if constraints_cfg.get("forbidAfternoonToMorning", True):
        for w in workers:
            w_id = w["id"]
            for idx in range(len(calendar) - 1):
                d_curr = calendar[idx]["day"]
                d_next = calendar[idx + 1]["day"]
                model.Add(
                    x[(w_id, d_curr, "AFTERNOON")]
                    + x[(w_id, d_next, "MORNING")]
                    + x[(w_id, d_next, "BAR")]
                    <= 1
                )

    # 4. Massimo giorni consecutivi lavorabili
    max_consec = int(constraints_cfg.get("maxConsecutiveDays", 6))
    window_size = max_consec + 1
    if len(calendar) >= window_size:
        for w in workers:
            w_id = w["id"]
            for start_idx in range(len(calendar) - window_size + 1):
                window_days = [calendar[start_idx + k]["day"] for k in range(window_size)]
                model.Add(
                    sum(x[(w_id, d, s)] for d in window_days for s in shifts) <= max_consec
                )

    # 4b. Massimo 3 Pomeriggi consecutivi (nessuno può avere più di 3 pomeriggi consecutivi
    #     a meno che non sia indispensabile e confermato dall'utente)
    max_consec_aft = min(3, max(2, int(constraints_cfg.get("maxConsecutiveAfternoons", 3))))
    allow_aft_overflow = bool(
        config.get("_allow_afternoon_overflow", False)
        or constraints_cfg.get("allowEmergencyAfternoonOverflow", False)
    )
    aft_win_size = max_consec_aft + 1
    aft_overflow_vars = []
    if len(calendar) >= aft_win_size:
        for w in workers:
            w_id = w["id"]
            for start_idx in range(len(calendar) - aft_win_size + 1):
                window_days = [calendar[start_idx + k]["day"] for k in range(aft_win_size)]
                if allow_aft_overflow:
                    ovf = model.NewIntVar(0, 1, f"aft_ovf_{w_id}_{start_idx}")
                    model.Add(
                        sum(x[(w_id, d, "AFTERNOON")] for d in window_days) <= max_consec_aft + ovf
                    )
                    aft_overflow_vars.append((w, calendar[start_idx + aft_win_size - 1], ovf))
                else:
                    model.Add(
                        sum(x[(w_id, d, "AFTERNOON")] for d in window_days) <= max_consec_aft
                    )

    # 5. Raggruppamento in settimane Lun-Dom per Ore Contrattuali Settimanali e Riposo Minimo
    weeks = []
    curr_week = []
    for day_req in calendar:
        curr_week.append(day_req)
        if day_req["dayOfWeek"] == 0:
            weeks.append(curr_week)
            curr_week = []
    if curr_week:
        weeks.append(curr_week)

    min_rest = int(constraints_cfg.get("minWeeklyRestDays", 1))
    for w in workers:
        w_id = w["id"]
        max_weekly_hours = int(w.get("maxWeeklyHours", 40))
        for wk in weeks:
            weekly_hours_expr = []
            for day_req in wk:
                d = day_req["day"]
                for s in shifts:
                    spec = get_shift_spec(config, day_req, s)
                    weekly_hours_expr.append(x[(w_id, d, s)] * int(spec["hours"]))
            model.Add(sum(weekly_hours_expr) <= max_weekly_hours)

            if len(wk) == 7:
                model.Add(
                    sum(x[(w_id, day_req["day"], s)] for day_req in wk for s in shifts)
                    <= 7 - min_rest
                )

    # 5b. Rotazione Domeniche Libere (ultimi 3 mesi da 'history') e Max 3 Domeniche Lavorate Consecutive
    sunday_days_all = [d["day"] for d in calendar if d["dayOfWeek"] == 0]
    fisso_all = [w for w in workers if w["type"] == "Fisso"]
    sun_history_3m = analyze_sunday_history_last_3_months(config, workers)
    use_hist_flag = bool(constraints_cfg.get("useHistoricalEquity", True))

    if len(sunday_days_all) >= 2:
        for w in workers:
            w_id = w["id"]
            model.Add(
                sum(x[(w_id, d, s)] for d in sunday_days_all for s in shifts)
                <= len(sunday_days_all) - 1
            )

    # Vincolo Rigido: Nessuna lavoratrice fissa può lavorare più di 3 domeniche consecutive
    # (in ogni finestra di 4 domeniche consecutive deve esserci almeno 1 domenica di riposo)
    if len(sunday_days_all) >= 4:
        for w in fisso_all:
            w_id = w["id"]
            for start_idx in range(len(sunday_days_all) - 3):
                win_sundays = sunday_days_all[start_idx : start_idx + 4]
                model.Add(
                    sum(x[(w_id, d, s)] for d in win_sundays for s in shifts) <= 3
                )

    # Continuità con gli ultimi 3 mesi ('history') e rotazione forzata delle domeniche libere tra le Fisse
    designated_free_sunday: Dict[str, int] = {}
    if sunday_days_all and fisso_all:
        num_sun = len(sunday_days_all)
        sunday_rest_load = {d: 0 for d in sunday_days_all}
        sunday_bar_rest_load = {d: 0 for d in sunday_days_all}

        # Calcola quante lavoratrici fisse possono riposare al massimo in ogni domenica senza scoprire il turno
        max_fisse_rest_per_sunday = {}
        for d_req in calendar:
            if d_req["dayOfWeek"] == 0:
                d_sun = d_req["day"]
                tot_req_sun = d_req.get("reqBar", 0) + d_req.get("reqMorning", 0) + d_req.get("reqAfternoon", 0)
                avail_fisse = [
                    w for w in fisso_all if not is_full_day_absent(w["id"], d_sun, absences)
                ]
                max_fisse_rest_per_sunday[d_sun] = max(1, len(avail_fisse) - tot_req_sun + 1)

        # Ordina le lavoratrici fisse dando priorità a chi ha più domeniche consecutive pregresse e più domeniche negli ultimi 3 mesi
        fisso_sorted_for_sun = sorted(
            fisso_all,
            key=lambda w: (
                -int(sun_history_3m.get(str(w["id"]), {}).get("trailing_consec_sundays", 0)),
                -int(sun_history_3m.get(str(w["id"]), {}).get("sundays_worked_3m", 0)),
                int(w["id"]) if str(w["id"]).isdigit() else 0,
            ),
        )

        # 1) Vincolo di confine mese precedente -> mese corrente basato su 'history' (max 3 settimane senza riposo domenicale)
        if use_hist_flag:
            boundary_rest_assigned = {d: 0 for d in sunday_days_all}
            for w in fisso_sorted_for_sun:
                w_id = w["id"]
                h_info = sun_history_3m.get(str(w_id), {})
                trailing_k = int(h_info.get("trailing_consec_sundays", 0))
                if trailing_k > 0 and h_info.get("months_analyzed", 0) > 0:
                    allowed_before_rest = max(1, 4 - trailing_k)  # Se trailing_k=3 -> deve riposare entro la 1ª domenica; se 2 -> entro le prime 2; se 1 -> entro le prime 3
                    win_bound = sunday_days_all[: min(num_sun, allowed_before_rest)]
                    # Verifica che ci sia capienza di riposo in almeno una domenica della finestra di confine
                    can_enforce_hard = any(
                        boundary_rest_assigned[d] < max_fisse_rest_per_sunday.get(d, 2)
                        for d in win_bound
                    )
                    if can_enforce_hard and len(win_bound) >= 1:
                        model.Add(
                            sum(x[(w_id, d, s)] for d in win_bound for s in shifts)
                            <= len(win_bound) - 1
                        )
                        best_bound_d = min(win_bound, key=lambda d: boundary_rest_assigned[d])
                        boundary_rest_assigned[best_bound_d] += 1

        # 2) Assegnazione a rotazione della Domenica Libera designata tra tutte le lavoratrici fisse
        for idx_f, w in enumerate(fisso_sorted_for_sun):
            w_id = w["id"]
            h_info = sun_history_3m.get(str(w_id), {})
            trailing_k = int(h_info.get("trailing_consec_sundays", 0)) if use_hist_flag else 0
            last_free_slot = int(h_info.get("last_free_sunday_slot", idx_f % num_sun))

            # Se ha già un'assenza a giornata intera di domenica, quella è la sua domenica libera
            absent_suns = [d for d in sunday_days_all if is_full_day_absent(w_id, d, absences)]
            if absent_suns:
                chosen_sun = absent_suns[0]
            else:
                # Limita le domeniche candidate alle prime (4 - trailing_k) se ha domeniche consecutive a fine mese scorso
                max_cand_idx = min(num_sun, max(1, 4 - trailing_k)) if trailing_k > 0 else num_sun
                candidate_sundays = sunday_days_all[:max_cand_idx]
                if not candidate_sundays:
                    candidate_sundays = sunday_days_all

                # Forza la rotazione rispetto all'ultima domenica libera goduta nello storico
                preferred_rot_slot = (last_free_slot + 1) % num_sun
                chosen_sun = min(
                    candidate_sundays,
                    key=lambda d: (
                        sunday_bar_rest_load[d] if w.get("canBar") else 0,
                        sunday_rest_load[d],
                        0 if sunday_days_all.index(d) == preferred_rot_slot else 1,
                        abs(sunday_days_all.index(d) - preferred_rot_slot),
                    ),
                )

            designated_free_sunday[w_id] = chosen_sun
            sunday_rest_load[chosen_sun] += 1
            if w.get("canBar"):
                sunday_bar_rest_load[chosen_sun] += 1

    # 6. Funzione Obiettivo: Priorità Fisse vs Sostitute + Preferenza 2 Pomeriggi Consecutivi + PAREGGIO RIGOROSO ORE TRA LE FISSE
    objective_terms = []

    # 6.0 Preferenza per massimo 2 Pomeriggi consecutivi (penalizza il 3° pomeriggio consecutivo così da preferire blocchi di 2 pomeriggi)
    pref_consec_aft = min(max_consec_aft, max(1, int(constraints_cfg.get("preferredConsecutiveAfternoons", 2))))
    pref_win_size = pref_consec_aft + 1
    if len(calendar) >= pref_win_size:
        for w in workers:
            w_id = w["id"]
            for start_idx in range(len(calendar) - pref_win_size + 1):
                win_days = [calendar[start_idx + k]["day"] for k in range(pref_win_size)]
                excess_aft = model.NewBoolVar(f"ex_aft_{w_id}_{start_idx}")
                model.Add(
                    sum(x[(w_id, d, "AFTERNOON")] for d in win_days) - pref_consec_aft <= excess_aft
                )
                objective_terms.append(excess_aft * 35000)

    # 6a. Penalità altissima per utilizzo sostitute (solo se strettamente necessario)
    for w in workers:
        w_id = w["id"]
        if w["type"] == "Sostituta":
            prio = int(w.get("priority", 1))
            penalty = 100000 * prio
            for day_req in calendar:
                d = day_req["day"]
                for s in shifts:
                    objective_terms.append(x[(w_id, d, s)] * penalty)

        # Preferenza leggera per l'operatrice dedicata Bar (Ioana) sul turno Bar così che raggiunga lo stesso monte ore delle colleghe
        if w.get("canBar") and not w.get("canMorning") and not w.get("canAfternoon"):
            for day_req in calendar:
                d = day_req["day"]
                objective_terms.append(x[(w_id, d, "BAR")] * (-40))

    # 6b. Pareggio Rigoroso Ore Totali tra TUTTE le lavoratrici Fisse (INCLUSA l'operatrice Bar Ioana!)
    fisso_all = [w for w in workers if w["type"] == "Fisso"]
    fisso_general = [
        w for w in workers if w["type"] == "Fisso" and (w.get("canMorning") or w.get("canAfternoon"))
    ]

    if len(fisso_all) >= 2:
        w_bal = int(constraints_cfg.get("weightMorningAfternoonBalance", 5))
        w_sun = int(constraints_cfg.get("weightSundayRotation", 4))
        w_hrs = int(constraints_cfg.get("weightMonthlyHoursEquity", 5))

        # Calcolo ore totali complessive (Bar + Mattina + Pomeriggio) da distribuire equamente tra tutte le Fisse (inclusa Ioana)
        total_dept_hours = sum(
            day_req["reqBar"] * int(get_shift_spec(config, day_req, "BAR")["hours"])
            + day_req["reqMorning"] * int(get_shift_spec(config, day_req, "MORNING")["hours"])
            + day_req["reqAfternoon"] * int(get_shift_spec(config, day_req, "AFTERNOON")["hours"])
            for day_req in calendar
        )

        capacities = {}
        for w in fisso_all:
            w_id = w["id"]
            avail_days = sum(1 for d in calendar if not is_full_day_absent(w_id, d["day"], absences))
            capacities[w_id] = max(1, avail_days * int(w.get("maxWeeklyHours", 40)))

        sum_cap = sum(capacities.values())

        monthly_hours_vars = []
        for w in fisso_all:
            w_id = w["id"]
            h_var = model.NewIntVar(0, num_days * 12, f"hrs_{w_id}")
            model.Add(
                h_var
                == sum(
                    x[(w_id, d["day"], s)] * int(get_shift_spec(config, d, s)["hours"])
                    for d in calendar
                    for s in shifts
                )
            )
            monthly_hours_vars.append(h_var)

            # Deviazione assoluta rispetto al target individuale proporzionale (inclusa Ioana)
            target_h = round(total_dept_hours * capacities[w_id] / max(1, sum_cap))
            dev_var = model.NewIntVar(0, num_days * 12, f"dev_hrs_{w_id}")
            model.AddAbsEquality(dev_var, h_var - target_h)
            objective_terms.append(dev_var * (400 * w_hrs))

        # Minimizzazione diretta dello spread (Max Ore - Min Ore) tra TUTTE le Fisse a piena disponibilità (inclusa Ioana)
        full_avail_vars = [
            monthly_hours_vars[idx]
            for idx, w in enumerate(fisso_all)
            if sum(1 for d in calendar if is_full_day_absent(w["id"], d["day"], absences)) == 0
        ]
        if len(full_avail_vars) >= 2:
            max_hrs = model.NewIntVar(0, num_days * 12, "max_hrs")
            min_hrs = model.NewIntVar(0, num_days * 12, "min_hrs")
            model.AddMaxEquality(max_hrs, full_avail_vars)
            model.AddMinEquality(min_hrs, full_avail_vars)
            objective_terms.append((max_hrs - min_hrs) * (1500 * w_hrs))

        # Bilanciamento Pomeriggi e Mattine (stesso numero di Pomeriggi e stesso numero di Mattine tra le Fisse)
        aft_counts = []
        morn_counts = []
        for w in fisso_general:
            w_id = w["id"]
            c_aft = model.NewIntVar(0, num_days, f"aft_{w_id}")
            model.Add(c_aft == sum(x[(w_id, d["day"], "AFTERNOON")] for d in calendar))
            aft_counts.append(c_aft)

            c_morn = model.NewIntVar(0, num_days, f"morn_{w_id}")
            model.Add(
                c_morn
                == sum(x[(w_id, d["day"], "MORNING")] + x[(w_id, d["day"], "BAR")] for d in calendar)
            )
            morn_counts.append(c_morn)

        max_aft = model.NewIntVar(0, num_days, "max_aft")
        min_aft = model.NewIntVar(0, num_days, "min_aft")
        model.AddMaxEquality(max_aft, aft_counts)
        model.AddMinEquality(min_aft, aft_counts)
        objective_terms.append((max_aft - min_aft) * (800 * w_bal))

        max_morn = model.NewIntVar(0, num_days, "max_morn")
        min_morn = model.NewIntVar(0, num_days, "min_morn")
        model.AddMaxEquality(max_morn, morn_counts)
        model.AddMinEquality(min_morn, morn_counts)
        objective_terms.append((max_morn - min_morn) * (800 * w_bal))

        # Rotazione Domeniche lavorate + Rotazione Domenica Libera Designata (ultimi 3 mesi da 'history')
        sunday_days = [d["day"] for d in calendar if d["dayOfWeek"] == 0]
        if sunday_days:
            sun_counts = []
            for w in fisso_all:
                w_id = w["id"]
                s_var = model.NewIntVar(0, len(sunday_days), f"sun_{w_id}")
                model.Add(s_var == sum(x[(w_id, d, s)] for d in sunday_days for s in shifts))
                sun_counts.append(s_var)

                # Incoraggia fortemente il riposo nella Domenica Libera designata dalla rotazione trimestrale
                des_sun = designated_free_sunday.get(w_id)
                if des_sun is not None:
                    for s in shifts:
                        objective_terms.append(x[(w_id, des_sun, s)] * (18000 * max(1, w_sun)))

                # Peso specifico basato sulle domeniche lavorate negli ultimi 3 mesi ('history')
                h3_info = sun_history_3m.get(str(w_id), {})
                sun_3m = int(h3_info.get("sundays_worked_3m", 0))
                trail_3m = int(h3_info.get("trailing_consec_sundays", 0))
                if use_hist_flag and (sun_3m > 0 or trail_3m > 0):
                    for idx_s, d_sun in enumerate(sunday_days):
                        # Penalità più alta sulle prime domeniche del mese per chi viene da domeniche consecutive lavorate
                        early_urgency = max(0, 3 - idx_s) * trail_3m * 1200 * max(1, w_sun)
                        hist_3m_weight = sun_3m * 350 * max(1, w_sun) + early_urgency
                        for s in shifts:
                            objective_terms.append(x[(w_id, d_sun, s)] * hist_3m_weight)

            max_sun = model.NewIntVar(0, len(sunday_days), "max_sun")
            min_sun = model.NewIntVar(0, len(sunday_days), "min_sun")
            model.AddMaxEquality(max_sun, sun_counts)
            model.AddMinEquality(min_sun, sun_counts)
            objective_terms.append((max_sun - min_sun) * (450 * max(1, w_sun)))

        # 6c. Bilanciamento Plurimensile con lo Storico Turni (Weekend/Festività, Ore e Turni Mattina/Pomeriggio)
        hist_records = config.get("history") or config.get("_history_records") or []
        if hist_records and constraints_cfg.get("useHistoricalEquity", True):
            hist_sun = {w["id"]: 0 for w in workers}
            hist_hol = {w["id"]: 0 for w in workers}
            hist_hrs = {w["id"]: 0 for w in workers}
            hist_morn = {w["id"]: 0 for w in workers}
            hist_aft = {w["id"]: 0 for w in workers}
            for rec in hist_records:
                sol_snap = rec.get("solutionSnapshot", rec)
                w_stats_snap = sol_snap.get("workerStats", {})
                for w in workers:
                    wid = str(w["id"])
                    st = w_stats_snap.get(wid) or w_stats_snap.get(w["id"]) or {}
                    hist_sun[wid] += int(st.get("sundaysWorked", 0))
                    hist_hol[wid] += int(st.get("holidaysWorked", 0))
                    hist_hrs[wid] += int(st.get("totalHours", 0))
                    hist_morn[wid] += int(st.get("morningCount", 0)) + int(st.get("barCount", 0))
                    hist_aft[wid] += int(st.get("afternoonCount", 0))

            avg_hist_hrs = sum(hist_hrs[w["id"]] for w in fisso_all) / max(1, len(fisso_all))
            for idx_w, w in enumerate(fisso_all):
                wid = w["id"]
                delta_h = int(round(hist_hrs[wid] - avg_hist_hrs))
                if delta_h != 0:
                    objective_terms.append(monthly_hours_vars[idx_w] * (delta_h * 35 * w_hrs))
                for d_req in calendar:
                    d = d_req["day"]
                    is_sun = d_req.get("dayOfWeek") == 0
                    is_sat = d_req.get("dayOfWeek") == 6
                    is_hol = bool(d_req.get("isHoliday", False))
                    if is_sun or is_sat or is_hol:
                        wk_weight = (hist_sun[wid] * 90 + hist_hol[wid] * 110) * w_sun
                        if wk_weight > 0:
                            for s in shifts:
                                objective_terms.append(x[(wid, d, s)] * wk_weight)
                    if hist_aft[wid] > hist_morn[wid]:
                        objective_terms.append(x[(wid, d, "AFTERNOON")] * ((hist_aft[wid] - hist_morn[wid]) * 45 * w_bal))
                    elif hist_morn[wid] > hist_aft[wid]:
                        objective_terms.append(x[(wid, d, "MORNING")] * ((hist_morn[wid] - hist_aft[wid]) * 45 * w_bal))

    # Se l'utente ha autorizzato l'eccezione >3 pomeriggi solo ove indispensabile, penalizza enormemente ogni overflow
    for _w_ovf, _d_ovf, ovf_var in aft_overflow_vars:
        objective_terms.append(ovf_var * 50_000_000)

    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_sec
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Verifica se il piano diventa fattibile permettendo >3 pomeriggi consecutivi ove strettamente indispensabile
        if not allow_aft_overflow and not config.get("_checking_aft_overflow", False):
            test_cfg = dict(config)
            test_cfg["_allow_afternoon_overflow"] = True
            test_cfg["_checking_aft_overflow"] = True
            test_sol = solve_schedule(test_cfg, time_limit_sec=min(8.0, time_limit_sec))
            if test_sol.get("status") in ("OPTIMAL", "FEASIBLE") and test_sol.get("indispensableAfternoonExceptions"):
                return {
                    "status": "INFEASIBLE",
                    "requiresAfternoonOverflowConfirmation": True,
                    "indispensableAfternoonExceptions": test_sol["indispensableAfternoonExceptions"],
                    "diagnostics": [
                        "Attenzione: per coprire tutti i turni senza scoperture è strettamente indispensabile superare i 3 pomeriggi consecutivi in almeno un caso. È richiesta la conferma dell'utente."
                    ],
                    "assignments": {},
                    "workerStats": {},
                }
        return {
            "status": "INFEASIBLE",
            "diagnostics": pre_diag
            or [
                "Impossibile soddisfare contemporaneamente tutti i vincoli CCNL e i fabbisogni richiesti. Verifica le ferie concomitanti o riduci il fabbisogno nei giorni critici."
            ],
            "assignments": {},
            "workerStats": {},
        }

    indispensable_aft_exceptions = []
    for w_ovf, d_ovf, ovf_var in aft_overflow_vars:
        if solver.Value(ovf_var) > 0:
            indispensable_aft_exceptions.append({
                "workerId": w_ovf["id"],
                "workerName": w_ovf["name"],
                "day": d_ovf["day"],
                "dateStr": d_ovf["dateStr"],
                "dayAbbr": d_ovf.get("dayAbbr", ""),
            })
            pre_diag.append(
                f"Eccezione confermata dall'utente: {w_ovf['name']} svolge > {max_consec_aft} pomeriggi consecutivi il {d_ovf['dateStr']} poiché indispensabile."
            )

    # Estrazione soluzione
    assignments: Dict[int, Dict[str, Any]] = {}
    worker_stats: Dict[str, Any] = {
        w["id"]: {
            "workerId": w["id"],
            "workerName": w["name"],
            "totalHours": 0,
            "barCount": 0,
            "morningCount": 0,
            "afternoonCount": 0,
            "workedDays": 0,
            "sundaysWorked": 0,
            "holidaysWorked": 0,
            "holidayHours": 0,
            "holidaySurchargePct": float(w.get("holidaySurchargePct", 20.0 if w.get("type") == "Fisso" else 0.0)),
            "holidaySurchargeCost": 0.0,
        }
        for w in workers
    }

    for day_req in calendar:
        d = day_req["day"]
        assignments[d] = {}
        for w in workers:
            w_id = w["id"]
            assigned = "OFF"
            label = ""
            hours = 0
            for s in shifts:
                if solver.Value(x[(w_id, d, s)]) == 1:
                    assigned = s
                    spec = get_shift_spec(config, day_req, s)
                    label = spec["label"]
                    hours = int(spec["hours"])
                    break
            assignments[d][w_id] = {"shiftType": assigned, "label": label, "hours": hours}
            if assigned != "OFF":
                st = worker_stats[w_id]
                st["totalHours"] += hours
                st["workedDays"] += 1
                if assigned == "BAR":
                    st["barCount"] += 1
                elif assigned == "MORNING":
                    st["morningCount"] += 1
                elif assigned == "AFTERNOON":
                    st["afternoonCount"] += 1
                if day_req["dayOfWeek"] == 0:
                    st["sundaysWorked"] += 1
                if day_req.get("isHoliday", False):
                    st["holidaysWorked"] += 1
                    st["holidayHours"] += hours

    for w in workers:
        w_id = w["id"]
        st = worker_stats[w_id]
        rate = float(w.get("hourlyRate", 12.5 if w.get("type") == "Fisso" else 13.0))
        hol_pct = float(w.get("holidaySurchargePct", 20.0 if w.get("type") == "Fisso" else 0.0)) if w.get("type") == "Fisso" else 0.0
        st["holidaySurchargePct"] = hol_pct
        st["holidaySurchargeCost"] = round(st["holidayHours"] * rate * (hol_pct / 100.0), 2) if w.get("type") == "Fisso" else 0.0
        st["totalCost"] = round(st["totalHours"] * rate + st["holidaySurchargeCost"], 2)

    diag_msgs = list(pre_diag) + [
        "Ottimizzazione CP-SAT completata con successo: ore, mattine e pomeriggi pareggiati tra le fisse (max 3 pomeriggi consecutivi).",
        "Vincolo Rotazione Domeniche attivo: massimo 3 domeniche lavorate consecutive (almeno 1 domenica libera ogni 4 settimane).",
    ]
    active_history_list = config.get("history") or config.get("_history_records") or []
    if active_history_list:
        months_3m = min(3, len(active_history_list))
        diag_msgs.append(
            f"Analisi Storica Domeniche (ultimi {months_3m} mesi da 'history') applicata per ruotare i riposi domenicali tra tutte le lavoratrici fisse."
        )

    return {
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "diagnostics": diag_msgs,
        "assignments": assignments,
        "workerStats": worker_stats,
        "indispensableAfternoonExceptions": indispensable_aft_exceptions,
    }
`;

  const configManagerPy = `"""
config_manager.py — Gestione salvataggio automatico permanente (%APPDATA%), storico turni (con importazione da Excel .xlsx) e generazione calendario
"""

import json
import os
import re
import calendar
from datetime import date, datetime, timedelta
from typing import Dict, Any, List
import openpyxl

ITALIAN_MONTHS_ABBR = {
    1: "gen", 2: "feb", 3: "mar", 4: "apr", 5: "mag", 6: "giu",
    7: "lug", 8: "ago", 9: "set", 10: "ott", 11: "nov", 12: "dic"
}

ITALIAN_MONTHS_FULL = {
    1: "Gennaio", 2: "Febbraio", 3: "Marzo", 4: "Aprile", 5: "Maggio", 6: "Giugno",
    7: "Luglio", 8: "Agosto", 9: "Settembre", 10: "Ottobre", 11: "Novembre", 12: "Dicembre"
}

PYTHON_WEEKDAY_TO_ABBR = {
    0: ("Lun", 1),
    1: ("Mar", 2),
    2: ("Mer", 3),
    3: ("Gio", 4),
    4: ("Ven", 5),
    5: ("Sab", 6),
    6: ("Dom", 0),
}


def generate_calendar_from_dates(
    start_date: date,
    end_date: date,
    req_bar: int = 1,
    req_morning: int = 4,
    req_afternoon: int = 2,
) -> List[Dict[str, Any]]:
    days_list = []
    curr = start_date
    seq = 1
    while curr <= end_date and seq <= 90:
        m_abbr = ITALIAN_MONTHS_ABBR.get(curr.month, "nov")
        day_abbr, js_dow = PYTHON_WEEKDAY_TO_ABBR[curr.weekday()]
        days_list.append({
            "day": seq,
            "isoDate": curr.isoformat(),
            "dateStr": f"{curr.day:02d}-{m_abbr}",
            "dayOfWeek": js_dow,
            "dayAbbr": day_abbr,
            "reqBar": req_bar,
            "reqMorning": req_morning,
            "reqAfternoon": req_afternoon,
            "isHoliday": (curr.month == 11 and curr.day == 1)
            or (curr.month == 12 and curr.day in (8, 25, 26))
            or (curr.month == 1 and curr.day in (1, 6)),
        })
        curr += timedelta(days=1)
        seq += 1
    return days_list


def generate_calendar_for_month(
    month: int,
    year: int,
    req_bar: int = 1,
    req_morning: int = 4,
    req_afternoon: int = 2,
    extra_days_after_month: int = 0,
) -> List[Dict[str, Any]]:
    _, num_days = calendar.monthrange(year, month)
    start_d = date(year, month, 1)
    end_d = date(year, month, num_days) + timedelta(days=max(0, extra_days_after_month))
    return generate_calendar_from_dates(start_d, end_d, req_bar, req_morning, req_afternoon)


class ConfigManager:
    DEFAULT_CONFIG: Dict[str, Any] = json.loads(r'''${defaultProfileJson}''')

    @classmethod
    def get_appdata_dir(cls) -> str:
        base_dir = os.environ.get("APPDATA") or os.path.expanduser("~")
        app_dir = os.path.join(base_dir, "TurniDonnePulizieRT")
        os.makedirs(app_dir, exist_ok=True)
        return app_dir

    @classmethod
    def get_appdata_path(cls) -> str:
        return os.path.join(cls.get_appdata_dir(), "config.json")

    @classmethod
    def get_history_path(cls) -> str:
        return os.path.join(cls.get_appdata_dir(), "history.json")

    @classmethod
    def _normalize_config(cls, cfg: Dict[str, Any]) -> Dict[str, Any]:
        legacy_map = {}
        workers = cfg.get("workers", [])
        for idx, w in enumerate(workers):
            old_id = str(w.get("id", idx + 1))
            num_id = w.get("numericId") if isinstance(w.get("numericId"), int) else (idx + 1)
            new_id = str(num_id)
            legacy_map[old_id] = new_id
            w["id"] = new_id
            w["numericId"] = num_id
            if "hourlyRate" not in w or w["hourlyRate"] is None:
                w["hourlyRate"] = 12.5 if w.get("type") == "Fisso" else 13.0
            if w.get("type") == "Sostituta":
                try:
                    p_val = int(w.get("priority", 1) or 1)
                except (ValueError, TypeError):
                    p_val = 1
                w["priority"] = max(1, min(5, p_val))
                w["holidaySurchargePct"] = 0
            else:
                w["priority"] = 0
                if "holidaySurchargePct" not in w or w["holidaySurchargePct"] is None:
                    w["holidaySurchargePct"] = 20
        for a in cfg.get("absences", []):
            wid = str(a.get("workerId", ""))
            if wid in legacy_map:
                a["workerId"] = legacy_map[wid]
        cfg.setdefault("shiftExceptions", [])
        return cfg

    @classmethod
    def load_config(cls, filepath: str = "") -> Dict[str, Any]:
        appdata_file = cls.get_appdata_path()
        if filepath and os.path.exists(filepath) and os.path.basename(filepath) != "profilo_turni.json":
            target = filepath
        elif os.path.exists(appdata_file):
            target = appdata_file
        elif filepath and os.path.exists(filepath):
            target = filepath
        else:
            cfg = cls._normalize_config(json.loads(json.dumps(cls.DEFAULT_CONFIG)))
            cls.save_config(cfg)
            return cfg
        try:
            with open(target, "r", encoding="utf-8") as f:
                cfg = cls._normalize_config(json.load(f))
            cls.save_config(cfg)
            return cfg
        except Exception:
            cfg = cls._normalize_config(json.loads(json.dumps(cls.DEFAULT_CONFIG)))
            cls.save_config(cfg)
            return cfg

    @classmethod
    def save_config(cls, config: Dict[str, Any], filepath: str = "") -> None:
        clean_cfg = {k: v for k, v in config.items() if not k.startswith("_")}
        appdata_target = cls.get_appdata_path()
        with open(appdata_target, "w", encoding="utf-8") as f:
            json.dump(clean_cfg, f, indent=2, ensure_ascii=False)
        if filepath and os.path.abspath(filepath) != os.path.abspath(appdata_target):
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(clean_cfg, f, indent=2, ensure_ascii=False)

    @classmethod
    def _normalize_history_record(cls, rec: Dict[str, Any], base_cfg: Dict[str, Any]) -> Dict[str, Any]:
        m = int(rec.get("month") or rec.get("configSnapshot", {}).get("month") or 10)
        y = int(rec.get("year") or rec.get("configSnapshot", {}).get("year") or 2026)
        cfg_snap = rec.get("configSnapshot")
        if not isinstance(cfg_snap, dict) or not cfg_snap.get("calendar"):
            cal_days = rec.get("calendar")
            if not isinstance(cal_days, list) or not cal_days:
                cal_days = generate_calendar_for_month(m, y, 1, 4, 2, 0)
            cfg_snap = json.loads(json.dumps({k: v for k, v in base_cfg.items() if not k.startswith("_") and k != "history"}))
            cfg_snap["month"] = m
            cfg_snap["year"] = y
            cfg_snap["calendar"] = cal_days
            cfg_snap["absences"] = []
        cal_days = cfg_snap.get("calendar", [])
        num_days = int(rec.get("numDays") or len(cal_days) or 30)
        date_range = (
            rec.get("dateRangeLabel")
            or rec.get("customRangeLabel")
            or (f"{cal_days[0]['dateStr']} - {cal_days[-1]['dateStr']}" if cal_days else f"{m:02d}/{y}")
        )
        period_lbl = rec.get("periodLabel") or f"{ITALIAN_MONTHS_FULL.get(m, 'Mese')} {y} ({date_range})"
        raw_saved = str(rec.get("savedAt") or rec.get("confirmedAt") or f"{y}-{m:02d}-28 18:00:00")
        saved_at = raw_saved[:19].replace("T", " ")

        sol_snap = rec.get("solutionSnapshot")
        w_stats = rec.get("workerStats") or (sol_snap.get("workerStats") if isinstance(sol_snap, dict) else None) or {}
        raw_assign = rec.get("assignments") or (sol_snap.get("assignments") if isinstance(sol_snap, dict) else None) or {}

        workers = [w for w in cfg_snap.get("workers", base_cfg.get("workers", [])) if w.get("active", True)]
        fisse = [w for w in workers if w.get("type") == "Fisso"]
        if not raw_assign and cal_days and fisse:
            synth_assign: Dict[int, Dict[str, Any]] = {}
            other_fisse = [w for w in fisse if w["id"] != "1"] or fisse
            for idx_d, d_req in enumerate(cal_days):
                d_num = int(d_req.get("day", idx_d + 1))
                is_sun_hol = d_req.get("dayOfWeek") == 0 or d_req.get("isHoliday", False)
                is_thu_sat = d_req.get("dayOfWeek", 1) >= 4
                hrs = 7 if (is_sun_hol or is_thu_sat) else 6
                lbl_bar = f"6-{6 + hrs}"
                lbl_mat = f"7-{7 + hrs}"
                lbl_pom = f"14-{14 + hrs}"
                day_map: Dict[str, Any] = {w["id"]: {"shiftType": "OFF", "label": "", "hours": 0} for w in workers}
                bar_rest = (idx_d % 7) == 2
                if not bar_rest:
                    day_map["1"] = {"shiftType": "BAR", "label": lbl_bar, "hours": hrs}
                pool = [other_fisse[(idx_d + k) % len(other_fisse)] for k in range(len(other_fisse))]
                if bar_rest and pool:
                    b_w = next((pw for pw in pool if pw.get("canBar")), pool[0])
                    day_map[b_w["id"]] = {"shiftType": "BAR", "label": lbl_bar, "hours": hrs}
                    pool = [pw for pw in pool if pw["id"] != b_w["id"]]
                for m_w in pool[:4]:
                    day_map[m_w["id"]] = {"shiftType": "MORNING", "label": lbl_mat, "hours": hrs}
                for p_w in pool[4:6]:
                    day_map[p_w["id"]] = {"shiftType": "AFTERNOON", "label": lbl_pom, "hours": hrs}
                synth_assign[d_num] = day_map
            raw_assign = synth_assign

        if not isinstance(sol_snap, dict):
            sol_snap = {
                "status": "OPTIMAL",
                "diagnostics": [f"Orario storico archiviato: {period_lbl}"],
                "assignments": raw_assign,
                "workerStats": w_stats,
            }
        else:
            sol_snap.setdefault("assignments", raw_assign)
            sol_snap.setdefault("workerStats", w_stats)

        return {
            "id": str(rec.get("id") or f"hist-{y}-{m:02d}"),
            "month": m,
            "year": y,
            "numDays": num_days,
            "periodLabel": period_lbl,
            "dateRangeLabel": date_range,
            "customRangeLabel": date_range,
            "savedAt": saved_at,
            "confirmedAt": rec.get("confirmedAt") or saved_at,
            "workerStats": w_stats,
            "configSnapshot": cfg_snap,
            "solutionSnapshot": sol_snap,
        }

    @classmethod
    def load_history(cls) -> List[Dict[str, Any]]:
        h_path = cls.get_history_path()
        base_cfg = cls._normalize_config(json.loads(json.dumps(cls.DEFAULT_CONFIG)))
        raw_items: List[Dict[str, Any]] = []
        if os.path.exists(h_path):
            try:
                with open(h_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, list) and len(loaded) > 0:
                    raw_items = loaded
            except Exception:
                raw_items = []
        if not raw_items:
            default_hist = cls.DEFAULT_CONFIG.get("history", [])
            if isinstance(default_hist, list) and len(default_hist) > 0:
                raw_items = default_hist
        items = [cls._normalize_history_record(r, base_cfg) for r in raw_items if isinstance(r, dict)]
        items.sort(
            key=lambda x: (
                int(x.get("year", 0)),
                int(x.get("month", 0)),
                str(x.get("savedAt", "")),
            ),
            reverse=True,
        )
        if not os.path.exists(h_path) and items:
            try:
                with open(h_path, "w", encoding="utf-8") as f:
                    json.dump(items, f, indent=2, ensure_ascii=False)
            except Exception:
                pass
        return items

    @classmethod
    def save_history_record(
        cls,
        config: Dict[str, Any],
        solution: Dict[str, Any],
        period_label: str = "",
        custom_date_range: str = "",
    ) -> List[Dict[str, Any]]:
        history = cls.load_history()
        clean_cfg = {k: v for k, v in config.items() if not k.startswith("_") and k != "history"}
        m = int(clean_cfg.get("month", 11))
        y = int(clean_cfg.get("year", 2026))
        cal = clean_cfg.get("calendar", [])
        date_range = custom_date_range.strip() or (
            f"{cal[0]['dateStr']} – {cal[-1]['dateStr']}" if cal else f"{m:02d}/{y}"
        )
        title_part = period_label.strip() or f"{ITALIAN_MONTHS_FULL.get(m, 'Mese')} {y}"
        full_period_label = f"{title_part} ({date_range})" if "(" not in title_part else title_part
        now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        record = cls._normalize_history_record(
            {
                "id": f"hist-{y}-{m:02d}-{int(datetime.now().timestamp() * 1000)}",
                "month": m,
                "year": y,
                "numDays": len(cal),
                "periodLabel": full_period_label,
                "dateRangeLabel": date_range,
                "customRangeLabel": date_range,
                "savedAt": now_iso,
                "confirmedAt": now_iso,
                "workerStats": json.loads(json.dumps(solution.get("workerStats", {}))),
                "configSnapshot": json.loads(json.dumps(clean_cfg)),
                "solutionSnapshot": json.loads(json.dumps(solution)),
            },
            clean_cfg,
        )
        existing_idx = next(
            (
                idx
                for idx, h in enumerate(history)
                if int(h.get("month", 0)) == m
                and int(h.get("year", 0)) == y
                and str(h.get("periodLabel", "")).lower() == full_period_label.lower()
            ),
            -1,
        )
        if existing_idx >= 0:
            history[existing_idx] = record
        else:
            history.insert(0, record)
        history.sort(
            key=lambda x: (
                int(x.get("year", 0)),
                int(x.get("month", 0)),
                str(x.get("savedAt", "")),
            ),
            reverse=True,
        )
        with open(cls.get_history_path(), "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2, ensure_ascii=False)
        return history

    @classmethod
    def import_history_from_excel(cls, xlsx_path: str, current_config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Importa uno o più fogli turni da un file Excel (.xlsx) direttamente nello Storico Turni permanente."""
        wb = openpyxl.load_workbook(xlsx_path, data_only=False)
        history = cls.load_history()
        workers = [w for w in current_config.get("workers", []) if w.get("active", True)]
        abbr_to_month = {v.lower(): k for k, v in ITALIAN_MONTHS_ABBR.items()}

        for ws in wb.worksheets:
            if "costi" in ws.title.lower() or "analisi" in ws.title.lower():
                continue
            c_a1 = str(ws.cell(1, 1).value or "").strip().lower()
            if c_a1 != "data":
                continue

            col_to_wid = {}
            max_col = ws.max_column
            for col in range(3, max_col + 1, 2):
                raw_name = str(ws.cell(1, col).value or "").strip()
                if not raw_name:
                    continue
                norm = re.sub(r"^#\d+\s*", "", raw_name).strip().lower()
                matched = next(
                    (
                        w
                        for w in workers
                        if w["name"].strip().lower() == norm
                        or norm in w["name"].strip().lower()
                        or w["name"].strip().lower() in norm
                    ),
                    None,
                )
                if matched:
                    col_to_wid[col] = matched["id"]

            if not col_to_wid:
                continue

            cal_days = []
            assignments = {}
            w_stats = {
                w["id"]: {
                    "workerId": w["id"],
                    "workerName": w["name"],
                    "totalHours": 0,
                    "barCount": 0,
                    "morningCount": 0,
                    "afternoonCount": 0,
                    "workedDays": 0,
                    "sundaysWorked": 0,
                    "holidaysWorked": 0,
                }
                for w in workers
            }

            year_guess = int(current_config.get("year", 2026))
            ym_match = re.search(r"(20\d{2})", ws.title + " " + os.path.basename(xlsx_path))
            if ym_match:
                year_guess = int(ym_match.group(1))
            month_guess = int(current_config.get("month", 11))

            seq = 1
            for r in range(3, ws.max_row + 1):
                d_str = str(ws.cell(r, 1).value or "").strip()
                day_abbr = str(ws.cell(r, 2).value or "").strip()
                if not d_str or "totale" in d_str.lower() or "giorni" in d_str.lower() or "turni" in d_str.lower():
                    break
                m_parts = d_str.split("-")
                if len(m_parts) == 2 and m_parts[1].lower()[:3] in abbr_to_month and seq == 1:
                    month_guess = abbr_to_month[m_parts[1].lower()[:3]]
                is_sun = day_abbr.lower().startswith("dom")
                is_hol = d_str.lower() in ("01-nov", "08-dic", "25-dic", "26-dic", "01-gen", "06-gen")
                cal_days.append({
                    "day": seq,
                    "dateStr": d_str,
                    "dayAbbr": day_abbr or ("Dom" if is_sun else "Lun"),
                    "dayOfWeek": 0 if is_sun else (6 if day_abbr.lower().startswith("sab") else 1),
                    "reqBar": 1,
                    "reqMorning": 4,
                    "reqAfternoon": 2,
                    "isHoliday": is_hol,
                })
                assignments[seq] = {w["id"]: {"shiftType": "OFF", "label": "", "hours": 0} for w in workers}
                for col, wid in col_to_wid.items():
                    s_lbl = str(ws.cell(r, col).value or "").strip()
                    if not s_lbl or s_lbl.startswith("="):
                        continue
                    hrs = 6
                    m_hr = re.match(r"^(\d{1,2})\s*-\s*(\d{1,2})$", s_lbl)
                    s_type = "MORNING"
                    if m_hr:
                        st_h, end_h = int(m_hr.group(1)), int(m_hr.group(2))
                        hrs = max(1, end_h - st_h)
                        if st_h <= 6:
                            s_type = "BAR"
                        elif st_h >= 13:
                            s_type = "AFTERNOON"
                    assignments[seq][wid] = {"shiftType": s_type, "label": s_lbl, "hours": hrs}
                    st_w = w_stats[wid]
                    st_w["totalHours"] += hrs
                    st_w["workedDays"] += 1
                    if s_type == "BAR":
                        st_w["barCount"] += 1
                    elif s_type == "MORNING":
                        st_w["morningCount"] += 1
                    elif s_type == "AFTERNOON":
                        st_w["afternoonCount"] += 1
                    if is_sun:
                        st_w["sundaysWorked"] += 1
                    if is_hol:
                        st_w["holidaysWorked"] += 1
                seq += 1

            if not cal_days:
                continue

            date_range = f"{cal_days[0]['dateStr']} -> {cal_days[-1]['dateStr']}"
            p_label = f"{ITALIAN_MONTHS_FULL.get(month_guess, 'Mese')} {year_guess} ({date_range})"
            cfg_snap = json.loads(json.dumps({k: v for k, v in current_config.items() if not k.startswith("_")}))
            cfg_snap["month"] = month_guess
            cfg_snap["year"] = year_guess
            cfg_snap["calendar"] = cal_days
            sol_snap = {
                "status": "OPTIMAL",
                "diagnostics": [f"Orario importato da file Excel ({os.path.basename(xlsx_path)})."],
                "assignments": assignments,
                "workerStats": w_stats,
            }
            history.insert(
                0,
                cls._normalize_history_record(
                    {
                        "id": f"hist-xlsx-{year_guess}-{month_guess:02d}-{int(datetime.now().timestamp() * 1000)}",
                        "month": month_guess,
                        "year": year_guess,
                        "numDays": len(cal_days),
                        "periodLabel": p_label,
                        "dateRangeLabel": date_range,
                        "customRangeLabel": date_range,
                        "savedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "workerStats": w_stats,
                        "configSnapshot": cfg_snap,
                        "solutionSnapshot": sol_snap,
                    },
                    cfg_snap,
                ),
            )

        history.sort(
            key=lambda x: (
                int(x.get("year", 0)),
                int(x.get("month", 0)),
                str(x.get("savedAt", "")),
            ),
            reverse=True,
        )
        with open(cls.get_history_path(), "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2, ensure_ascii=False)
        return history

    @classmethod
    def delete_history_record(cls, record_id: str) -> List[Dict[str, Any]]:
        history = [r for r in cls.load_history() if r.get("id") != record_id]
        with open(cls.get_history_path(), "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2, ensure_ascii=False)
        return history
`;

  const exporterExcelPy = `"""
exporter_excel.py — Esportazione Foglio Excel (.xlsx) con openpyxl
Clona fedelmente il modello cartaceo:
- Colonna A: Data (01-nov, 02-nov... incluse eventuali date oltre fine mese es. 01-dic)
- Colonna B: Giorno abbreviato (Dom, Lun, Mar...)
- Coppia di colonne per ciascuna lavoratrice (Turno + Ore) con intestazione unita
- Sfondo Giallo pastello (#FEF08A) per Turno BAR (6-12, 6-13)
- Testo Rosso (#DC2626) per Turno MATTINA (7-13, 7-14)
- Testo Nero Grassetto (#000000) per Turno POMERIGGIO (14-20, 14-21)
- Celle completamente vuote per Riposo / Assenza
- Bordo orizzontale spesso VERDE BOSCO (#14532D) sotto ogni Domenica
- Formule native Excel (SOMMA, CONTA.NUMERI, CONTA.SE) nei totali di fine periodo
"""

from typing import Dict, Any, List
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter


def _populate_schedule_worksheet(ws, config: Dict[str, Any], solution: Dict[str, Any]) -> int:
    workers = [w for w in config["workers"] if w.get("active", True)]
    workers.sort(key=lambda w: (0 if w["type"] == "Fisso" else 1, w.get("priority", 0)))

    thin_side = Side(border_style="thin", color="475569")
    green_thick_side = Side(border_style="medium", color="14532D")
    header_bottom_side = Side(border_style="medium", color="0F172A")

    fill_header = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")
    fill_sub = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    fill_bar_yellow = PatternFill(start_color="FEF08A", end_color="FEF08A", fill_type="solid")

    font_header = Font(name="Calibri", size=11, bold=True, color="0F172A")
    font_sub = Font(name="Calibri", size=9, bold=True, color="334155")
    font_bar = Font(name="Calibri", size=10, bold=True, color="0F172A")
    font_morning = Font(name="Calibri", size=10, bold=False, color="DC2626")
    font_afternoon = Font(name="Calibri", size=10, bold=True, color="000000")
    font_hours = Font(name="Calibri", size=10, bold=False, color="334155")

    align_center = Alignment(horizontal="center", vertical="center")

    ws.merge_cells(start_row=1, start_column=1, end_row=2, end_column=1)
    ws.merge_cells(start_row=1, start_column=2, end_row=2, end_column=2)
    ws.cell(1, 1, "Data").font = font_header
    ws.cell(1, 1).fill = fill_header
    ws.cell(1, 1).alignment = align_center
    ws.cell(1, 2, "Giorno").font = font_header
    ws.cell(1, 2).fill = fill_header
    ws.cell(1, 2).alignment = align_center

    ws.column_dimensions["A"].width = 11
    ws.column_dimensions["B"].width = 8

    for idx, w in enumerate(workers):
        col_shift = 3 + idx * 2
        col_hours = 4 + idx * 2
        ws.merge_cells(start_row=1, start_column=col_shift, end_row=1, end_column=col_hours)
        c_name = ws.cell(1, col_shift, w["name"])
        c_name.font = font_header
        c_name.fill = fill_header
        c_name.alignment = align_center

        c_t = ws.cell(2, col_shift, "Turno")
        c_t.font = font_sub
        c_t.fill = fill_sub
        c_t.alignment = align_center

        c_o = ws.cell(2, col_hours, "Ore")
        c_o.font = font_sub
        c_o.fill = fill_sub
        c_o.alignment = align_center

        ws.column_dimensions[get_column_letter(col_shift)].width = 10
        ws.column_dimensions[get_column_letter(col_hours)].width = 5.5

    total_cols = 2 + len(workers) * 2
    for r in (1, 2):
        for c in range(1, total_cols + 1):
            ws.cell(r, c).border = Border(
                top=thin_side,
                left=thin_side,
                right=thin_side,
                bottom=header_bottom_side if r == 2 else thin_side,
            )

    start_row = 3
    calendar_days = config["calendar"]
    assignments = solution["assignments"]

    for idx, day_req in enumerate(calendar_days):
        r = start_row + idx
        d = day_req["day"]
        is_sun = day_req["dayOfWeek"] == 0
        b_bottom = green_thick_side if is_sun else thin_side
        row_border = Border(top=thin_side, left=thin_side, right=thin_side, bottom=b_bottom)

        c_date = ws.cell(r, 1, day_req["dateStr"])
        c_date.alignment = align_center
        c_date.font = Font(name="Calibri", size=10, bold=is_sun, color="14532D" if is_sun else "0F172A")
        c_date.border = row_border

        c_day = ws.cell(r, 2, day_req["dayAbbr"])
        c_day.alignment = align_center
        c_day.font = Font(name="Calibri", size=10, bold=is_sun, color="14532D" if is_sun else "334155")
        c_day.border = row_border

        day_assign = assignments.get(d) or assignments.get(str(d)) or {}

        for w_idx, w in enumerate(workers):
            col_shift = 3 + w_idx * 2
            col_hours = 4 + w_idx * 2
            s_let = get_column_letter(col_shift)
            s_cell_ref = f"{s_let}{r}"
            cell_data = day_assign.get(w["id"], {"shiftType": "OFF"})

            c_s = ws.cell(r, col_shift)
            c_h = ws.cell(r, col_hours)
            c_s.alignment = align_center
            c_h.alignment = align_center
            c_s.border = row_border
            c_h.border = row_border
            c_h.font = font_hours

            s_type = cell_data.get("shiftType", "OFF")
            if s_type != "OFF":
                c_s.value = cell_data["label"]
                if s_type == "BAR":
                    c_s.fill = fill_bar_yellow
                    c_s.font = font_bar
                elif s_type == "MORNING":
                    c_s.font = font_morning
                elif s_type == "AFTERNOON":
                    c_s.font = font_afternoon

            c_h.value = (
                f'=IF(TRIM({s_cell_ref})="","",'
                f'IFERROR(VALUE(MID({s_cell_ref},FIND("-",{s_cell_ref})+1,10))-'
                f'VALUE(LEFT({s_cell_ref},FIND("-",{s_cell_ref})-1)),0))'
            )

    end_row = start_row + len(calendar_days) - 1
    tot_ore_mensili_row = end_row + 2

    summary_defs = [
        (tot_ore_mensili_row, "Totale Ore Mensili", lambda s_rng, h_rng: f"=SUM({h_rng})"),
        (end_row + 3, "GIORNI LAVORATI", lambda s_rng, h_rng: f"=COUNT({h_rng})"),
        (end_row + 4, "TURNI MATTINA", lambda s_rng, h_rng: f'=COUNTIF({s_rng},"7-*")'),
        (end_row + 5, "TURNI POMERIGGIO", lambda s_rng, h_rng: f'=COUNTIF({s_rng},"14-*")'),
        (end_row + 6, "TURNI BAR", lambda s_rng, h_rng: f'=COUNTIF({s_rng},"6-*")'),
    ]

    for r_sum, title, formula_fn in summary_defs:
        ws.merge_cells(start_row=r_sum, start_column=1, end_row=r_sum, end_column=2)
        lbl = ws.cell(r_sum, 1, title)
        lbl.font = Font(name="Calibri", size=10 if r_sum == tot_ore_mensili_row else 9, bold=True, color="0F172A")
        lbl.fill = fill_header
        ws.cell(r_sum, 1).border = Border(top=thin_side, left=thin_side, right=thin_side, bottom=thin_side)
        ws.cell(r_sum, 2).border = Border(top=thin_side, left=thin_side, right=thin_side, bottom=thin_side)

        for w_idx, _ in enumerate(workers):
            col_shift = 3 + w_idx * 2
            col_hours = 4 + w_idx * 2
            s_let = get_column_letter(col_shift)
            h_let = get_column_letter(col_hours)
            s_rng = f"{s_let}{start_row}:{s_let}{end_row}"
            h_rng = f"{h_let}{start_row}:{h_let}{end_row}"

            ws.merge_cells(start_row=r_sum, start_column=col_shift, end_row=r_sum, end_column=col_hours)
            f_cell = ws.cell(r_sum, col_shift, formula_fn(s_rng, h_rng))
            f_cell.font = Font(name="Calibri", size=11 if r_sum == tot_ore_mensili_row else 10, bold=True, color="0F172A")
            if r_sum == tot_ore_mensili_row:
                f_cell.fill = fill_header
            f_cell.alignment = align_center
            ws.cell(r_sum, col_shift).border = Border(top=thin_side, left=thin_side, right=thin_side, bottom=thin_side)
            ws.cell(r_sum, col_hours).border = Border(top=thin_side, left=thin_side, right=thin_side, bottom=thin_side)

    return tot_ore_mensili_row


def export_to_excel(config: Dict[str, Any], solution: Dict[str, Any], output_path: str) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f"Turni_{config['month']:02d}_{config['year']}"
    tot_ore_mensili_row = _populate_schedule_worksheet(ws, config, solution)

    workers = [w for w in config["workers"] if w.get("active", True)]
    workers.sort(key=lambda w: (0 if w["type"] == "Fisso" else 1, w.get("priority", 0)))
    fill_header = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")
    font_header = Font(name="Calibri", size=11, bold=True, color="0F172A")
    align_center = Alignment(horizontal="center", vertical="center")

    # Foglio 2: Analisi Economica Costi Personale (collegato dinamicamente al Totale Ore Mensili del Foglio 1 + Maggiorazione Festivi Fisse)
    ws_cost = wb.create_sheet(title="Analisi_Costi_Personale")
    headers_cost = [
        "ID #",
        "Dipendente",
        "Ruolo / Priorità",
        "Totale Ore Mensili",
        "Ore Festivi",
        "Tariffa Oraria (€/h)",
        "Magg. Festivi (%)",
        "Extra Festivi (€)",
        "Costo Totale Stimato (€)",
    ]
    for col_idx, h_text in enumerate(headers_cost, start=1):
        c = ws_cost.cell(1, col_idx, h_text)
        c.font = font_header
        c.fill = fill_header
        c.alignment = align_center
        ws_cost.column_dimensions[get_column_letter(col_idx)].width = 20

    w_stats_map = solution.get("workerStats", {})
    for idx_w, w in enumerate(workers, start=2):
        w_pos = idx_w - 2
        col_shift_sheet1 = get_column_letter(3 + w_pos * 2)
        rate = float(w.get("hourlyRate", 12.50))
        hol_pct = float(w.get("holidaySurchargePct", 20.0)) if w.get("type") == "Fisso" else 0.0
        st_w = w_stats_map.get(w["id"], {})
        hol_hrs = int(st_w.get("holidayHours", 0))
        role_lbl = (
            "Fisso (Organico)"
            if w.get("type") == "Fisso"
            else (
                "Sostituta (P5 Esclusa)"
                if int(w.get("priority", 1)) >= 5
                else f"Sostituta (P{int(w.get('priority', 1))})"
            )
        )
        ws_cost.cell(idx_w, 1, w["id"]).alignment = align_center
        ws_cost.cell(idx_w, 2, w["name"]).font = font_header
        ws_cost.cell(idx_w, 3, role_lbl).alignment = align_center
        c_hrs = ws_cost.cell(idx_w, 4, f"='{ws.title}'!{col_shift_sheet1}{tot_ore_mensili_row}")
        c_hrs.alignment = align_center
        c_hrs.font = font_header
        c_hol_h = ws_cost.cell(idx_w, 5, hol_hrs)
        c_hol_h.alignment = align_center
        c_rate = ws_cost.cell(idx_w, 6, rate)
        c_rate.number_format = "€ #,##0.00"
        c_pct = ws_cost.cell(idx_w, 7, hol_pct / 100.0)
        c_pct.number_format = "0%"
        c_pct.alignment = align_center
        c_extra = ws_cost.cell(idx_w, 8, f"=E{idx_w}*F{idx_w}*G{idx_w}")
        c_extra.number_format = "€ #,##0.00"
        c_tot = ws_cost.cell(idx_w, 9, f"=D{idx_w}*F{idx_w}+H{idx_w}")
        c_tot.number_format = "€ #,##0.00"
        c_tot.font = font_header

    tot_row = len(workers) + 2
    ws_cost.cell(tot_row, 2, "TOTALE GENERALE DEL MESE").font = font_header
    ws_cost.cell(tot_row, 4, f"=SUM(D2:D{tot_row - 1})").font = font_header
    ws_cost.cell(tot_row, 5, f"=SUM(E2:E{tot_row - 1})").font = font_header
    c_extra_tot = ws_cost.cell(tot_row, 8, f"=SUM(H2:H{tot_row - 1})")
    c_extra_tot.number_format = "€ #,##0.00"
    c_extra_tot.font = font_header
    c_grand = ws_cost.cell(tot_row, 9, f"=SUM(I2:I{tot_row - 1})")
    c_grand.number_format = "€ #,##0.00"
    c_grand.font = font_header

    wb.save(output_path)


def export_all_history_to_excel(config: Dict[str, Any], history_records: List[Dict[str, Any]], output_path: str) -> None:
    wb = openpyxl.Workbook()
    ws_sum = wb.active
    ws_sum.title = "Riepilogo_Storico_Globale"
    fill_header = PatternFill(start_color="E2E8F0", end_color="E2E8F0", fill_type="solid")
    font_header = Font(name="Calibri", size=11, bold=True, color="0F172A")
    align_center = Alignment(horizontal="center", vertical="center")

    headers = ["#", "Periodo Archiviato", "Mese/Anno", "Giorni", "Salvato il", "Monte Ore Totale"]
    for c_i, h_txt in enumerate(headers, start=1):
        c = ws_sum.cell(1, c_i, h_txt)
        c.font = font_header
        c.fill = fill_header
        c.alignment = align_center
        ws_sum.column_dimensions[get_column_letter(c_i)].width = 24

    used_titles = {"Riepilogo_Storico_Globale"}
    for idx, rec in enumerate(history_records, start=1):
        r = idx + 1
        m = int(rec.get("month", 1))
        y = int(rec.get("year", 2026))
        w_stats = rec.get("workerStats") or rec.get("solutionSnapshot", {}).get("workerStats", {})
        tot_h = sum(int(st.get("totalHours", 0)) for st in w_stats.values() if isinstance(st, dict))
        ws_sum.cell(r, 1, f"#{idx:02d}").alignment = align_center
        ws_sum.cell(r, 2, rec.get("periodLabel", "")).font = font_header
        ws_sum.cell(r, 3, f"{m:02d}/{y}").alignment = align_center
        ws_sum.cell(r, 4, int(rec.get("numDays", 30))).alignment = align_center
        ws_sum.cell(r, 5, str(rec.get("savedAt", ""))[:10]).alignment = align_center
        ws_sum.cell(r, 6, f"{tot_h}h").alignment = align_center

        base_title = f"Turni_{m:02d}_{y}"
        s_title = base_title
        cnt = 2
        while s_title in used_titles:
            s_title = f"{base_title}_{cnt}"
            cnt += 1
        used_titles.add(s_title)
        ws_m = wb.create_sheet(title=s_title[:31])
        cfg_snap = rec.get("configSnapshot", config)
        cfg_snap["workers"] = config.get("workers", cfg_snap.get("workers", []))
        sol_snap = rec.get("solutionSnapshot", {"assignments": {}, "workerStats": w_stats})
        _populate_schedule_worksheet(ws_m, cfg_snap, sol_snap)

    wb.save(output_path)
`;

  const exporterImagePy = `"""
exporter_image.py — Rendering Immagine JPEG ad Alta Definizione (300 DPI) tramite Pillow (PIL)
Genera il prospetto per le lavoratrici SENZA la tabella del calcolo ore in fondo (pronto per l'invio o la stampa in bacheca).
"""

from typing import Dict, Any
from PIL import Image, ImageDraw, ImageFont


def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = (
        ["arialbd.ttf", "calibrib.ttf", "DejaVuSans-Bold.ttf"]
        if bold
        else ["arial.ttf", "calibri.ttf", "DejaVuSans.ttf"]
    )
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def export_to_jpeg(
    config: Dict[str, Any],
    solution: Dict[str, Any],
    output_path: str,
    include_summary_footer: bool = False,
) -> None:
    workers = [w for w in config["workers"] if w.get("active", True)]
    workers.sort(key=lambda w: (0 if w["type"] == "Fisso" else 1, w.get("priority", 0)))

    scale = 3  # Fattore 300 DPI
    margin = 28 * scale
    header_h1 = 34 * scale
    header_h2 = 24 * scale
    row_h = 26 * scale

    col_date_w = 78 * scale
    col_day_w = 56 * scale
    col_shift_w = 74 * scale
    col_hours_w = 42 * scale
    pair_w = col_shift_w + col_hours_w

    num_days = len(config["calendar"])
    extra_rows = 1 if include_summary_footer else 0
    table_w = col_date_w + col_day_w + len(workers) * pair_w
    table_h = header_h1 + header_h2 + (num_days + extra_rows) * row_h

    img_w = table_w + margin * 2
    img_h = table_h + margin * 2

    img = Image.new("RGB", (img_w, img_h), "#FFFFFF")
    draw = ImageDraw.Draw(img)

    f_header = _load_font(12 * scale, bold=True)
    f_sub = _load_font(10 * scale, bold=True)
    f_reg = _load_font(11 * scale, bold=False)
    f_bold = _load_font(11 * scale, bold=True)

    sx, sy = margin, margin

    draw.rectangle([sx, sy, sx + col_date_w + col_day_w, sy + header_h1 + header_h2], fill="#E2E8F0", outline="#475569")
    draw.text((sx + col_date_w // 2, sy + (header_h1 + header_h2) // 2), "Data", fill="#0F172A", font=f_header, anchor="mm")
    draw.text((sx + col_date_w + col_day_w // 2, sy + (header_h1 + header_h2) // 2), "Giorno", fill="#0F172A", font=f_header, anchor="mm")

    for idx, w in enumerate(workers):
        wx = sx + col_date_w + col_day_w + idx * pair_w
        draw.rectangle([wx, sy, wx + pair_w, sy + header_h1], fill="#E2E8F0", outline="#475569")
        draw.text((wx + pair_w // 2, sy + header_h1 // 2), w["name"], fill="#0F172A", font=f_header, anchor="mm")

        draw.rectangle([wx, sy + header_h1, wx + col_shift_w, sy + header_h1 + header_h2], fill="#F8FAFC", outline="#475569")
        draw.text((wx + col_shift_w // 2, sy + header_h1 + header_h2 // 2), "Turno", fill="#334155", font=f_sub, anchor="mm")

        draw.rectangle([wx + col_shift_w, sy + header_h1, wx + pair_w, sy + header_h1 + header_h2], fill="#F8FAFC", outline="#475569")
        draw.text((wx + col_shift_w + col_hours_w // 2, sy + header_h1 + header_h2 // 2), "Ore", fill="#334155", font=f_sub, anchor="mm")

    body_y = sy + header_h1 + header_h2
    assignments = solution["assignments"]

    for r_idx, day_req in enumerate(config["calendar"]):
        ry = body_y + r_idx * row_h
        d = day_req["day"]
        is_sun = day_req["dayOfWeek"] == 0

        draw.rectangle([sx, ry, sx + col_date_w, ry + row_h], fill="#FFFFFF", outline="#94A3B8")
        draw.rectangle([sx + col_date_w, ry, sx + col_date_w + col_day_w, ry + row_h], fill="#FFFFFF", outline="#94A3B8")

        draw.text((sx + col_date_w // 2, ry + row_h // 2), day_req["dateStr"], fill="#14532D" if is_sun else "#0F172A", font=f_bold if is_sun else f_reg, anchor="mm")
        draw.text((sx + col_date_w + col_day_w // 2, ry + row_h // 2), day_req["dayAbbr"], fill="#14532D" if is_sun else "#334155", font=f_bold if is_sun else f_reg, anchor="mm")

        for w_idx, w in enumerate(workers):
            wx = sx + col_date_w + col_day_w + w_idx * pair_w
            cell = assignments.get(d, {}).get(w["id"], {"shiftType": "OFF"})
            s_type = cell.get("shiftType", "OFF")

            bg_shift = "#FEF08A" if s_type == "BAR" else "#FFFFFF"
            draw.rectangle([wx, ry, wx + col_shift_w, ry + row_h], fill=bg_shift, outline="#94A3B8")
            draw.rectangle([wx + col_shift_w, ry, wx + pair_w, ry + row_h], fill="#FFFFFF", outline="#94A3B8")

            if s_type != "OFF":
                txt_color = "#DC2626" if s_type == "MORNING" else "#000000"
                txt_font = f_bold if s_type in ("BAR", "AFTERNOON") else f_reg
                draw.text((wx + col_shift_w // 2, ry + row_h // 2), str(cell["label"]), fill=txt_color, font=txt_font, anchor="mm")
                draw.text((wx + col_shift_w + col_hours_w // 2, ry + row_h // 2), str(cell["hours"]), fill="#334155", font=f_reg, anchor="mm")

        if is_sun:
            draw.line([(sx, ry + row_h), (sx + table_w, ry + row_h)], fill="#14532D", width=3 * scale)

    if include_summary_footer:
        tot_y = body_y + num_days * row_h
        draw.rectangle([sx, tot_y, sx + col_date_w + col_day_w, tot_y + row_h], fill="#E2E8F0", outline="#475569")
        draw.text((sx + (col_date_w + col_day_w) // 2, tot_y + row_h // 2), "TOTALE ORE", fill="#0F172A", font=f_header, anchor="mm")

        for w_idx, w in enumerate(workers):
            wx = sx + col_date_w + col_day_w + w_idx * pair_w
            tot_h = solution["workerStats"].get(w["id"], {}).get("totalHours", 0)
            draw.rectangle([wx, tot_y, wx + pair_w, tot_y + row_h], fill="#E2E8F0", outline="#475569")
            draw.text((wx + pair_w // 2, tot_y + row_h // 2), str(tot_h), fill="#0F172A", font=f_header, anchor="mm")

    img.save(output_path, "JPEG", quality=98, dpi=(300, 300))
`;

  const appGuiPy = `"""
app_gui.py — Interfaccia Grafica Desktop Windows 10/11 (CustomTkinter)
Include tutte le 8 sezioni complete + Auto-Save Permanente su %APPDATA% + Sistema Universale Tooltip (450ms):
1. Personale & Nomi (Modifica, Aggiunta nuove lavoratrici con ID numerico progressivo, Eliminazione lavoratrici, Tariffa €/h)
2. Periodo & Fabbisogno (Mensile, oltre fine mese o intervallo personalizzato — 2° posto)
3. Orari & Eccezioni (Fasce settimanali + Eccezioni Orarie di Calendario per singolo giorno/turno — 3° posto)
4. Ferie & Indisponibilità (Legate all'ID numerico immutabile)
5. Vincoli CCNL & Equità (11h riposo, max giorni consecutivi, 1 domenica libera garantita)
6. Generazione & Export (CP-SAT con bilanciamento Storico + Archiviazione in Storico Turni + Export Excel/JPEG)
7. Storico Turni (Archivio cronologico decrescente in %APPDATA%, Importazione da Excel .xlsx, anteprima, caricamento ed export)
8. Analisi & Costi (Stima costo personale mensile per lavoratrice, mansione Bar/Mattina/Pomeriggio e Fisse vs Sostitute)
"""

import base64
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
import webbrowser
from datetime import date, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from tkinter import filedialog, messagebox, ttk
import customtkinter as ctk
from PIL import Image, ImageTk

from config_manager import (
    ConfigManager,
    generate_calendar_for_month,
    generate_calendar_from_dates,
    ITALIAN_MONTHS_FULL,
)
from solver import solve_schedule, diagnose_conflicts, get_shift_spec
from exporter_excel import export_to_excel, export_all_history_to_excel
from exporter_image import export_to_jpeg

ctk.set_appearance_mode("Light")
ctk.set_default_color_theme("blue")

# Logo Airport Motel Malpensa (con scritta nera originale) e Icona Programma (iconadef.png) in Base64
HOTEL_LOGO_B64 = "${HOTEL_LOGO_BASE64}"
APP_ICON_B64 = "${APP_ICON_BASE64}"

TAB_HELP_GUIDES = {
    "STAFF": (
        "❓ Guida: Gestione Organico e Competenze",
        "A cosa serve questa scheda:\\n"
        "Gestisci l'elenco delle lavoratrici fisse e delle sostitute a chiamata, le loro abilitazioni ai turni e il monte ore contrattuale.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Modifica Nome: Clicca sul campo di testo di qualsiasi lavoratrice o premi 'Rinomina'. La modifica aggiorna automaticamente l'intero programma, le esportazioni Excel/JPEG e lo storico, senza perdere i dati (grazie agli ID numerici interni).\\n"
        "2. Assegna Mansioni (Bar, Mattina, Pomeriggio): Spunta le caselle per definire quali turni la persona può ricoprire (es. Ioana al Bar; Sabrina e Ilaria sia Bar sia pulizie; Caterina solo Mattina).\\n"
        "3. Ore Contrattuali: Imposta il limite settimanale (default: 40h). Il solver rispetterà questo tetto evitando straordinari non concordati.\\n"
        "4. Aggiungi / Rimuovi Lavoratrice: Usa il tasto '+ Aggiungi Lavoratrice' per inserire nuovo personale, oppure disattiva una lavoratrice senza cancellarne lo storico pregresso.\\n\\n"
        "Regola d'oro:\\n"
        "Caterina e SIG.RA PATRIZIA sono impostate come 'Sostitute': il sistema le chiamerà solo ed esclusivamente se le fisse non bastano a coprire tutti i turni richiesti."
    ),
    "SHIFTS": (
        "❓ Guida: Configurazione Fasce Orarie ed Eccezioni",
        "A cosa serve questa scheda:\\n"
        "Definisce gli orari effettivi di ingresso/uscita e il conteggio delle ore lavorate per ciascun turno, sia a livello standard sia per singole giornate speciali.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Fasce Standard: Modifica gli orari predefiniti divisi per giorni (Lun-Mer: Bar 6-12 [6h], Mattina 7-13 [6h], Pomeriggio 14-20 [6h]; Gio-Dom: Bar 6-13 [7h], Mattina 7-14 [7h], Pomeriggio 14-21 [7h]). Puoi modificare sia la dicitura visiva sia il valore delle ore retribuite.\\n"
        "2. Eccezioni di Calendario: Se in un giorno specifico (es. 15 del mese) il turno di mattina dura 5 ore invece di 6 (es. 7-12 anziché 7-13), seleziona la data precisa e il turno nella sezione 'Eccezione Calendario' e imposta il nuovo orario.\\n\\n"
        "Regola d'oro:\\n"
        "Tutte le modifiche orarie si riflettono automaticamente sia nel calcolo dei totali ore sia nelle stime dei costi mensili."
    ),
    "CALENDAR": (
        "❓ Guida: Periodo di Lavoro e Numero Donne per Turno",
        "A cosa serve questa scheda:\\n"
        "Permette di stabilire il periodo da pianificare e quante operatrici devono essere presenti contemporaneamente in ogni singolo turno di ciascun giorno.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Selezione Mese/Periodo: Scegli il mese e l'anno. Se necessario, puoi estendere il piano oltre la fine del mese (es. per completare la settimana fino alla domenica successiva) oppure scegliere un intervallo libero di date (Dal -> Al).\\n"
        "2. Fabbisogno Giornaliero: Di base sono richieste: 1 Bar, 4 Mattine, 2 Pomeriggi.\\n"
        "3. Variazioni di Fabbisogno: Se in un giorno infrasettimanale ci sono meno camere da rifare, puoi abbassare le presenze del mattino da 4 a 3 o a 2 cliccando direttamente sulla casella di quel giorno.\\n\\n"
        "Regola d'oro:\\n"
        "Se aumenti il fabbisogno oltre la capienza oraria delle 8 fisse, il programma attiverà in automatico le sostitute per evitare turni scoperti."
    ),
    "ABSENCES": (
        "❓ Guida: Inserimento Ferie e Veti di Turno",
        "A cosa serve questa scheda:\\n"
        "Registra i giorni di assenza o indisponibilità garantendo che il solver non assegni turni non desiderati.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Periodo di Ferie / Malattia (Dal -> Al): Seleziona la dipendente, inserisci la data di partenza e di fine e scegli la causale (Ferie, Malattia, Permesso ROL, Riposo richiesto). Nessun turno le verrà assegnato in quell'intervallo.\\n"
        "2. Indisponibilità su Turno Specifico: Se una dipendente è disponibile solo parzialmente in un certo giorno (es. può lavorare al pomeriggio ma ha una visita la mattina), blocca selettivamente 'Solo Turno Mattina': il programma potrà comunque impiegarla al pomeriggio.\\n\\n"
        "Regola d'oro:\\n"
        "Inserisci le richieste prima di calcolare i turni. Se si verificano incompatibilità, il tasto alert ti mostrerà il giorno preciso e il turno da correggere."
    ),
    "CCNL": (
        "❓ Guida: Vincoli di Legge e Rotazione Equa",
        "A cosa serve questa scheda:\\n"
        "Regola i vincoli contrattuali vincolanti (CCNL Turismo) e i criteri matematici di equità tra le lavoratrici.\\n\\n"
        "Cosa puoi verificare e impostare:\\n"
        "1. Divieto Pomeriggio -> Mattina (11h di Riposo): Assicura che chi finisce alle 20:00 o 21:00 non sia mai messa in turno alle 06:00 o 07:00 del mattino seguente. Il giorno dopo farà un altro pomeriggio oppure sarà a riposo.\\n"
        "2. Limite 6 Giorni Consecutivi & 1 Riposo Settimanale: Obbliga almeno 1 giorno di riposo per settimana solare (Lun-Dom).\\n"
        "3. Obbligo 1 Domenica Libera al Mese: Garantisce che ogni lavoratrice abbia almeno una domenica di riposo nel mese (e mai più di 3 settimane consecutive senza riposo domenicale).\\n"
        "4. Target ~160 Ore & Parità Mattine/Pomeriggi: Il motore bilancia il carico affinché tutte le fisse abbiano un monte ore simile (~160h-163h) e lo stesso identico numero di pomeriggi (8-9) e mattine."
    ),
    "SOLVE": (
        "❓ Guida: Generazione e Salvataggio dei File",
        "A cosa serve questa scheda:\\n"
        "È la sezione in cui calcoli la turnazione, verifichi i conteggi, analizzi gli alert ed esporti i file.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Calcola Turni Ottimizzati: Avvia l'algoritmo per generare la turnazione ideale.\\n"
        "2. Verifica Indicatori & Alert: Controlla i badge di parità. Se appare un alert rosso/giallo, clicca su 'Vai al Problema' per visualizzare subito il giorno e il turno critico.\\n"
        "3. Esporta Excel (.xlsx): Scarica il file modificabile completo di formule native, celle bar in giallo pastello, mattine in rosso e separatori verdi alle domeniche.\\n"
        "4. Esporta JPEG Lavoratrici: Genera l'immagine pulita a 300 DPI per WhatsApp o stampa, senza la tabella inferiore delle ore e dei costi.\\n"
        "5. Salva Mese nello Storico: Archivia l'orario nell'archivio permanente dell'hotel per le future rotazioni."
    ),
    "COSTS": (
        "❓ Guida: Controllo Costi del Lavoro Mensile",
        "A cosa serve questa scheda:\\n"
        "Calcola in tempo reale la stima economica della turnazione moltiplicando le ore lavorate per la tariffa oraria di ciascuna dipendente.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Configura Costo Orario (€/h): Imposta la tariffa oraria per ciascuna lavoratrice.\\n"
        "2. Ripartizione Mansioni: Visualizza quanto incide la spesa per il Bar, per le Pulizie Mattina e per le Pulizie Pomeriggio.\\n"
        "3. Incidenza Sostitute: Controlla la spesa destinata alle fisse rispetto a quella per Caterina e Sig.ra Patrizia.\\n"
        "4. Esportazione: Puoi includere il riepilogo economico come foglio dedicato nel file Excel."
    ),
    "HISTORY": (
        "❓ Guida: Archivio Cronologico e Memoria Storica",
        "A cosa serve questa scheda:\\n"
        "Conserva gli orari dei mesi precedenti ordinati dal più recente al più vecchio.\\n\\n"
        "Cosa puoi fare:\\n"
        "1. Riapertura & Stampa: Riapri un mese passato e rigenera all'istante il JPEG o il file Excel.\\n"
        "2. Memoria Rotazioni: Il solver consulta lo storico per non assegnare sempre alle stesse persone le festività (Natale, Pasqua, Ferragosto) o le domeniche critiche."
    ),
}


class Win11ToolTip:
    """
    Sistema Universale di Tooltip in stile Windows 10/11 (sfondo scuro #0F172A, testo chiaro multi-riga).
    Compare dopo un ritardo di 450ms al passaggio del cursore (hover) e scompare istantaneamente all'uscita.
    Specifica sempre:
    - Funzione: a cosa serve il controllo.
    - Effetto: cosa succede quando viene premuto/modificato (incluso salvataggio automatico).
    - Nota / Requisito: eventuali avvertenze operative.
    """

    def __init__(self, widget, title: str, purpose: str, effect: str, requirement: str = "", delay_ms: int = 450):
        self.widget = widget
        self.title = title
        self.purpose = purpose
        self.effect = effect
        self.requirement = requirement
        self.delay_ms = delay_ms
        self._after_id = None
        self._tip_win = None
        self._last_x = 0
        self._last_y = 0

        self.widget.bind("<Enter>", self._on_enter, add="+")
        self.widget.bind("<Leave>", self._on_leave, add="+")
        self.widget.bind("<ButtonPress>", self._on_leave, add="+")

    def _on_enter(self, _event=None):
        self._cancel()
        self._after_id = self.widget.after(self.delay_ms, self._show)

    def _on_leave(self, _event=None):
        self._cancel()
        self._hide()

    def _cancel(self):
        if self._after_id is not None:
            try:
                self.widget.after_cancel(self._after_id)
            except Exception:
                pass
            self._after_id = None

    def _show(self):
        if self._tip_win is not None:
            return
        try:
            self._tip_win = tk.Toplevel(self.widget)
            self._tip_win.wm_overrideredirect(True)
            self._tip_win.wm_attributes("-topmost", True)

            px = self.widget.winfo_pointerx()
            py = self.widget.winfo_pointery()
            x = px + 14 if px else self.widget.winfo_rootx() + 20
            y = py + 18 if py else self.widget.winfo_rooty() + self.widget.winfo_height() + 6
            self._tip_win.wm_geometry(f"+{x}+{y}")

            outer = tk.Frame(
                self._tip_win,
                bg="#0F172A",
                highlightbackground="#334155",
                highlightthickness=1,
                padx=12,
                pady=9,
            )
            outer.pack(fill="both", expand=True)

            tk.Label(
                outer,
                text=self.title,
                bg="#0F172A",
                fg="#FFFFFF",
                font=("Segoe UI", 9, "bold"),
                anchor="w",
                justify="left",
                wraplength=340,
            ).pack(fill="x", pady=(0, 4))

            tk.Label(
                outer,
                text=f"Funzione: {self.purpose}",
                bg="#0F172A",
                fg="#E2E8F0",
                font=("Segoe UI", 8),
                anchor="w",
                justify="left",
                wraplength=340,
            ).pack(fill="x", pady=(0, 3))

            tk.Label(
                outer,
                text=f"Effetto: {self.effect}",
                bg="#0F172A",
                fg="#86EFAC",
                font=("Segoe UI", 8),
                anchor="w",
                justify="left",
                wraplength=340,
            ).pack(fill="x", pady=(0, 3 if self.requirement else 0))

            if self.requirement:
                tk.Label(
                    outer,
                    text=f"Nota / Requisito: {self.requirement}",
                    bg="#0F172A",
                    fg="#FCD34D",
                    font=("Segoe UI", 8, "italic"),
                    anchor="w",
                    justify="left",
                    wraplength=340,
                ).pack(fill="x")
        except Exception:
            self._hide()

    def _hide(self):
        if self._tip_win is not None:
            try:
                self._tip_win.destroy()
            except Exception:
                pass
            self._tip_win = None


class TurniDonnePulizieApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Turni di Lavoro RT — Workforce Scheduling (OR-Tools CP-SAT)")
        self.geometry("1460x900")
        self._tooltips = []
        self._autosave_after_id = None
        self._apply_window_icon()

        # Mostra subito la schermata di avvio con il Logo dell'Hotel in grande e la barra progressiva
        self._create_startup_splash()
        self._update_splash(0.18, "Caricamento configurazione e memoria permanente (%APPDATA%)...")

        # Carica SEMPRE dallo stato permanente %APPDATA%\\TurniDonnePulizieRT\\config.json
        self.config_data = ConfigManager.load_config()
        self.history_records = ConfigManager.load_history()
        self.current_solution = None

        # Salva automaticamente anche alla chiusura della finestra (X in alto a destra)
        self.protocol("WM_DELETE_WINDOW", self._on_closing)

        self._update_splash(0.38, "Inizializzazione intestazione e struttura schede...")

        top_bar = ctk.CTkFrame(self, height=62, fg_color="#0F172A", corner_radius=0)
        top_bar.pack(fill="x", side="top")

        # 1. Logo dell'Hotel (Airport Motel Malpensa) su sfondo bianco in alto a sinistra nell'Header (altezza ~48px)
        self._header_logo_ctk = None
        try:
            raw_logo = base64.b64decode(HOTEL_LOGO_B64)
            pil_logo = Image.open(io.BytesIO(raw_logo)).convert("RGBA")
            # Assicura sfondo bianco puro sotto il logo
            white_bg = Image.new("RGBA", pil_logo.size, (255, 255, 255, 255))
            pil_logo = Image.alpha_composite(white_bg, pil_logo).convert("RGB")
            target_h = 44
            ratio = pil_logo.width / max(1, pil_logo.height)
            target_w = int(target_h * ratio)
            self._header_logo_ctk = ctk.CTkImage(
                light_image=pil_logo, dark_image=pil_logo, size=(target_w, target_h)
            )
            logo_badge = ctk.CTkFrame(top_bar, fg_color="#FFFFFF", corner_radius=6)
            logo_badge.pack(side="left", padx=(14, 6), pady=6)
            lbl_logo = ctk.CTkLabel(logo_badge, text="", image=self._header_logo_ctk, fg_color="#FFFFFF")
            lbl_logo.pack(padx=6, pady=3)
        except Exception:
            pass

        title_lbl = ctk.CTkLabel(
            top_bar,
            text="Turni di Lavoro RT — Airport Motel Malpensa",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color="#FFFFFF",
        )
        title_lbl.pack(side="left", padx=10, pady=12)

        self.lbl_autosave = ctk.CTkLabel(
            top_bar,
            text=f"Memoria Permanente Attiva (%APPDATA% — {datetime.now().strftime('%H:%M:%S')})",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color="#4ADE80",
        )
        self.lbl_autosave.pack(side="left", padx=12)

        btn_save_json = ctk.CTkButton(
            top_bar, text="Esporta Backup (.json)", width=155, command=self.save_profile_dialog
        )
        btn_save_json.pack(side="right", padx=12, pady=10)

        btn_load_json = ctk.CTkButton(
            top_bar, text="Importa Backup (.json)", width=155, fg_color="#334155", command=self.load_profile_dialog
        )
        btn_load_json.pack(side="right", padx=6, pady=10)

        # 2. Firma elegante e discreta nel Footer fisso in basso ("Creato da Raffaele Tarallo")
        footer_bar = ctk.CTkFrame(self, height=30, fg_color="#F1F5F9", corner_radius=0)
        footer_bar.pack(fill="x", side="bottom")
        ctk.CTkLabel(
            footer_bar,
            text="Turni di Lavoro RT · Airport Motel Malpensa",
            font=ctk.CTkFont(size=11),
            text_color="#64748B",
        ).pack(side="left", padx=16, pady=4)
        ctk.CTkLabel(
            footer_bar,
            text="Creato da Raffaele Tarallo",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color="#1E293B",
        ).pack(side="right", padx=18, pady=4)

        self.tabview = ctk.CTkTabview(self)
        self.tabview.pack(fill="both", expand=True, padx=14, pady=8)

        # Ordine Schede richiesto: 2. Periodo & Fabbisogno al 2° posto, 3. Orari & Eccezioni al 3° posto
        self.tab_staff = self.tabview.add("1. Personale & Nomi")
        self.tab_calendar = self.tabview.add("2. Periodo & Fabbisogno")
        self.tab_shifts = self.tabview.add("3. Orari & Eccezioni")
        self.tab_absences = self.tabview.add("4. Ferie & Indisponibilità")
        self.tab_ccnl = self.tabview.add("5. Vincoli CCNL & Equità")
        self.tab_solve = self.tabview.add("6. Generazione & Export")
        self.tab_history = self.tabview.add("7. Storico Turni")
        self.tab_costs = self.tabview.add("8. Analisi & Costi")

        self._update_splash(0.58, "Costruzione tabelle Personale, Calendario, Orari e Ferie...")
        self._build_tab_staff()
        self._build_tab_calendar()
        self._build_tab_shifts()
        self._build_tab_absences()

        self._update_splash(0.75, "Costruzione schede Vincoli CCNL, Storico Turni e Analisi Costi...")
        self._build_tab_ccnl()
        self._build_tab_solve()
        self._build_tab_history()
        self._build_tab_costs()

        self._update_splash(0.86, "Attivazione sistema Tooltip universale...")
        self._attach_universal_tooltips(self)

        self._update_splash(0.95, "Calcolo turnazione ottimale (Google OR-Tools CP-SAT)...")
        self.run_optimizer(silent=True)
        self._update_splash(1.0, "Avvio completato!")
        self._close_startup_splash()

    def _create_startup_splash(self):
        self._splash_frame = ctk.CTkFrame(self, fg_color="#F8FAFC", corner_radius=0)
        self._splash_frame.place(relx=0, rely=0, relwidth=1, relheight=1)

        card = ctk.CTkFrame(
            self._splash_frame,
            fg_color="#FFFFFF",
            corner_radius=16,
            border_width=1,
            border_color="#E2E8F0",
        )
        card.place(relx=0.5, rely=0.5, anchor="center")

        self._splash_logo_ctk = None
        try:
            raw_logo = base64.b64decode(HOTEL_LOGO_B64)
            pil_logo = Image.open(io.BytesIO(raw_logo)).convert("RGBA")
            white_bg = Image.new("RGBA", pil_logo.size, (255, 255, 255, 255))
            pil_logo = Image.alpha_composite(white_bg, pil_logo).convert("RGB")
            target_h = 150
            ratio = pil_logo.width / max(1, pil_logo.height)
            target_w = int(target_h * ratio)
            self._splash_logo_ctk = ctk.CTkImage(
                light_image=pil_logo, dark_image=pil_logo, size=(target_w, target_h)
            )
            lbl_big_logo = ctk.CTkLabel(
                card, text="", image=self._splash_logo_ctk, fg_color="#FFFFFF"
            )
            lbl_big_logo.pack(padx=44, pady=(28, 14))
        except Exception:
            pass

        ctk.CTkLabel(
            card,
            text="Turni di Lavoro RT",
            font=ctk.CTkFont(size=22, weight="bold"),
            text_color="#0F172A",
        ).pack(padx=36, pady=(4, 2))

        ctk.CTkLabel(
            card,
            text="Airport Motel Malpensa · Sistema Ottimizzazione Turni",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#64748B",
        ).pack(padx=36, pady=(0, 18))

        self._splash_status_lbl = ctk.CTkLabel(
            card,
            text="Avvio del programma in corso...",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#334155",
        )
        self._splash_status_lbl.pack(padx=36, pady=(0, 6))

        self._splash_pbar = ctk.CTkProgressBar(
            card, width=400, height=12, progress_color="#0F172A"
        )
        self._splash_pbar.pack(padx=36, pady=(0, 18))
        self._splash_pbar.set(0.10)

        ctk.CTkLabel(
            card,
            text="Creato da Raffaele Tarallo",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color="#475569",
        ).pack(padx=36, pady=(0, 22))
        self.update()

    def _update_splash(self, progress_val: float, status_text: str):
        if hasattr(self, "_splash_frame") and self._splash_frame is not None:
            try:
                pct = int(round(progress_val * 100))
                self._splash_status_lbl.configure(text=f"{status_text} ({pct}%)")
                self._splash_pbar.set(progress_val)
                self.update()
            except Exception:
                pass

    def _close_startup_splash(self):
        if hasattr(self, "_splash_frame") and self._splash_frame is not None:
            try:
                self._splash_frame.destroy()
            except Exception:
                pass
            self._splash_frame = None

    def _apply_window_icon(self):
        base_dirs = [getattr(sys, "_MEIPASS", ""), os.path.dirname(os.path.abspath(__file__)), os.getcwd()]
        icon_applied = False
        for d in base_dirs:
            if not d:
                continue
            ico_p = os.path.join(d, "app_icon.ico")
            png_p = os.path.join(d, "iconadef.png")
            if not os.path.exists(png_p):
                png_p = os.path.join(d, "app_icon.png")
            try:
                if os.path.exists(ico_p):
                    self.iconbitmap(ico_p)
                if os.path.exists(png_p):
                    img = Image.open(png_p).resize((64, 64))
                    self._icon_photo = ImageTk.PhotoImage(img)
                    self.wm_iconphoto(True, self._icon_photo)
                    icon_applied = True
                    break
            except Exception:
                pass
        if not icon_applied:
            try:
                raw_ico = base64.b64decode(APP_ICON_B64)
                img = Image.open(io.BytesIO(raw_ico)).resize((64, 64))
                self._icon_photo = ImageTk.PhotoImage(img)
                self.wm_iconphoto(True, self._icon_photo)
            except Exception:
                pass

    def _attach_universal_tooltips(self, root_widget):
        """Applica automaticamente il sistema universale di Tooltip (450ms) a tutti i pulsanti, campi, switch e tabelle."""
        for child in root_widget.winfo_children():
            cls_name = child.__class__.__name__
            txt = ""
            try:
                txt = str(child.cget("text") or "").strip()
            except Exception:
                pass
            low = txt.lower()

            if "CTkButton" in cls_name and txt:
                if "calcola turni" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Calcola Turni Ottimizzati (CP-SAT)",
                        "Avvia il risolutore matematico Google OR-Tools CP-SAT tenendo conto di organico, ferie, eccezioni e Storico Turni.",
                        "Genera la matrice mensile pareggiando ore, weekend/festività e turni Mattina/Pomeriggio.",
                        "Richiede che il fabbisogno giornaliero sia compatibile con le lavoratrici presenti."
                    ))
                elif "importa turni da excel" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Importa Turni da File Excel (.xlsx) nello Storico",
                        "Carica uno o più mesi precedenti da un file Excel (.xlsx) direttamente nell'archivio Storico Turni.",
                        "Analizza turni, ore, domeniche e festività del file Excel e li salva in %APPDATA%/TurniDonnePulizieRT/history.json.",
                        "Il risolutore userà automaticamente questi mesi passati per equilibrare weekend, festività, ore e turni."
                    ))
                elif "salva orario corrente nello storico" in low or "archivia mese in storico" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Archivia Orario Corrente nello Storico Turni",
                        "Salva il prospetto turni del mese attivo nell'archivio cronologico permanente.",
                        "Aggiunge il mese in cima allo Storico Turni (dal più recente al più vecchio) e aggiorna il bilanciamento plurimensile.",
                        "Richiede che il calcolo turni sia stato completato."
                    ))
                elif "esporta excel" in low or "riesporta excel" in low or "riepilogo economico" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Esporta Prospetto in Excel (.xlsx)",
                        "Crea il file Microsoft Excel (.xlsx) con colori ufficiali, formule native =SOMMA(...) e foglio Analisi_Costi_Personale.",
                        "Apre la finestra di salvataggio file sul PC Windows.",
                        "Modificando i turni dentro Excel, il Totale Ore Mensili e i costi si aggiornano da soli."
                    ))
                elif "jpeg" in low or "300 dpi" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Esporta Immagine ad Alta Definizione (.jpeg 300 DPI)",
                        "Genera il prospetto grafico ad alta risoluzione pronto per stampa in bacheca o invio WhatsApp.",
                        "Salva il file .jpeg senza la tabella inferiore dei calcoli ore.",
                        "Richiede che i turni del mese siano stati generati."
                    ))
                elif "aggiungi lavoratrice" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Aggiungi Nuova Lavoratrice all'Organico",
                        "Inserisce una nuova dipendente assegnandole un ID numerico progressivo immutabile (#N).",
                        "Salva istantaneamente l'anagrafica in %APPDATA% e ricalcola i turni.",
                        "Inserisci il nome della lavoratrice prima di premere il pulsante."
                    ))
                elif "elimina lavoratrice" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Elimina Lavoratrice Selezionata",
                        "Rimuove la dipendente selezionata dall'organico attivo.",
                        "Aggiorna la memoria permanente (%APPDATA%) e ricalcola la copertura turni.",
                        "Seleziona prima una riga nella tabella del personale."
                    ))
                elif "salva modifiche selezionata" in low:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        "Salva Modifiche Lavoratrice (ID Immutabile)",
                        "Aggiorna nome, contratto, tariffa oraria (€/h), ore massime e mansioni abilitate della lavoratrice selezionata.",
                        "Salva istantaneamente su disco senza perdere lo storico o le ferie (collegate all'ID numerico).",
                        "Seleziona prima una lavoratrice dalla tabella."
                    ))
                else:
                    self._tooltips.append(Win11ToolTip(
                        child,
                        f"Pulsante: {txt}",
                        f"Esegue il comando '{txt}' nella scheda corrente.",
                        "Applica immediatamente la modifica e aggiorna la memoria permanente (%APPDATA%).",
                        "Tutte le modifiche restano salvate anche dopo la chiusura del programma."
                    ))
            elif "CTkEntry" in cls_name:
                self._tooltips.append(Win11ToolTip(
                    child,
                    "Campo di Inserimento Dati",
                    "Permette di digitare o modificare il valore del parametro (nome, orario, data, ore o tariffa €/h).",
                    "Il valore inserito viene utilizzato dal risolutore CP-SAT e salvato in memoria permanente."
                ))
            elif "CTkComboBox" in cls_name:
                self._tooltips.append(Win11ToolTip(
                    child,
                    "Menu di Selezione",
                    "Consente di scegliere un'opzione valida dall'elenco a discesa.",
                    "Aggiorna il parametro selezionato per il calcolo dei turni e il salvataggio automatico."
                ))
            elif "CTkCheckBox" in cls_name or "CTkSwitch" in cls_name:
                self._tooltips.append(Win11ToolTip(
                    child,
                    f"Interruttore / Abilitazione: {txt or 'Opzione'}",
                    "Attiva o disattiva la competenza di reparto o il vincolo contrattuale CCNL.",
                    "Aggiorna istantaneamente i vincoli del motore matematico CP-SAT e salva in %APPDATA%."
                ))
            elif "Treeview" in cls_name:
                self._tooltips.append(Win11ToolTip(
                    child,
                    "Tabella Dati Interattiva",
                    "Mostra l'elenco aggiornato dei record configurati per questa sezione.",
                    "Fai clic su una riga per selezionarla, visualizzarne i dettagli, modificarla o eliminarla."
                ))

            self._attach_universal_tooltips(child)

    def _auto_save(self, immediate: bool = False):
        if immediate:
            if getattr(self, "_autosave_after_id", None) is not None:
                try:
                    self.after_cancel(self._autosave_after_id)
                except Exception:
                    pass
                self._autosave_after_id = None
            self._flush_auto_save()
            return
        if getattr(self, "_autosave_after_id", None) is not None:
            try:
                self.after_cancel(self._autosave_after_id)
            except Exception:
                pass
        self._autosave_after_id = self.after(250, self._flush_auto_save)

    def _flush_auto_save(self):
        self._autosave_after_id = None
        ConfigManager.save_config(self.config_data, "profilo_turni.json")
        if hasattr(self, "lbl_autosave"):
            self.lbl_autosave.configure(
                text=f"Salvato in Memoria Permanente ({datetime.now().strftime('%H:%M:%S')})"
            )

    def _on_closing(self):
        try:
            if hasattr(self, "var_ccnl_11h"):
                self.config_data["constraints"]["forbidAfternoonToMorning"] = bool(self.var_ccnl_11h.get())
            self._auto_save(immediate=True)
        except Exception:
            pass
        self.destroy()

    def _next_numeric_id(self) -> int:
        max_id = 0
        for w in self.config_data.get("workers", []):
            try:
                val = int(w.get("numericId") or str(w.get("id", "0")).replace("#", ""))
                if val > max_id:
                    max_id = val
            except ValueError:
                pass
        return max_id + 1

    # -------------------------------------------------------------------------
    # SCHEDA 1: PERSONALE (MODIFICA, AGGIUNTA NUOVE LAVORATRICI, ELIMINAZIONE)
    # -------------------------------------------------------------------------
    def _build_tab_staff(self):
        # Barra superiore: Modifica o Eliminazione lavoratrice selezionata
        edit_bar = ctk.CTkFrame(self.tab_staff)
        edit_bar.pack(fill="x", padx=10, pady=(6, 4))

        ctk.CTkLabel(edit_bar, text="Selezionata — Nome:", font=ctk.CTkFont(weight="bold")).pack(side="left", padx=3)
        self.ent_rename = ctk.CTkEntry(edit_bar, width=130, placeholder_text="Nome lavoratrice")
        self.ent_rename.pack(side="left", padx=2)

        ctk.CTkLabel(edit_bar, text="Contratto:").pack(side="left", padx=2)
        self.cmb_edit_type = ctk.CTkComboBox(edit_bar, values=["Fisso", "Sostituta"], width=95)
        self.cmb_edit_type.pack(side="left", padx=2)

        ctk.CTkLabel(edit_bar, text="Priorità Sost.(1-5):").pack(side="left", padx=2)
        self.cmb_edit_prio = ctk.CTkComboBox(
            edit_bar,
            values=["1 - Massima", "2 - Alta", "3 - Media", "4 - Minima", "5 - Esclusa"],
            width=115,
        )
        self.cmb_edit_prio.set("1 - Massima")
        self.cmb_edit_prio.pack(side="left", padx=2)

        ctk.CTkLabel(edit_bar, text="€/h:").pack(side="left", padx=2)
        self.ent_hourly_rate = ctk.CTkEntry(edit_bar, width=58, placeholder_text="12.50")
        self.ent_hourly_rate.pack(side="left", padx=2)

        ctk.CTkLabel(edit_bar, text="Magg.Fest.% (Fisse):").pack(side="left", padx=2)
        self.ent_holiday_pct = ctk.CTkEntry(edit_bar, width=48, placeholder_text="20")
        self.ent_holiday_pct.pack(side="left", padx=2)

        ctk.CTkLabel(edit_bar, text="Max Ore:").pack(side="left", padx=2)
        self.ent_edit_hours = ctk.CTkEntry(edit_bar, width=45, placeholder_text="40")
        self.ent_edit_hours.pack(side="left", padx=2)

        self.var_edit_bar = ctk.BooleanVar(value=False)
        self.var_edit_morn = ctk.BooleanVar(value=True)
        self.var_edit_aft = ctk.BooleanVar(value=True)
        ctk.CTkCheckBox(edit_bar, text="Bar", variable=self.var_edit_bar, width=46).pack(side="left", padx=2)
        ctk.CTkCheckBox(edit_bar, text="Matt.", variable=self.var_edit_morn, width=54).pack(side="left", padx=2)
        ctk.CTkCheckBox(edit_bar, text="Pom.", variable=self.var_edit_aft, width=54).pack(side="left", padx=2)

        ctk.CTkButton(
            edit_bar,
            text="Salva Modifiche Selezionata",
            fg_color="#0F172A",
            width=165,
            command=self._update_selected_worker,
        ).pack(side="left", padx=4)

        ctk.CTkButton(
            edit_bar,
            text="Elimina",
            fg_color="#DC2626",
            hover_color="#B91C1C",
            width=80,
            command=self._delete_selected_worker,
        ).pack(side="left", padx=2)

        ctk.CTkButton(
            edit_bar,
            text="❓ Guida",
            fg_color="#334155",
            hover_color="#1E293B",
            width=90,
            command=lambda: self._open_tab_guide_modal("STAFF"),
        ).pack(side="right", padx=4)

        # Tabella Personale
        cols = ("id", "name", "type", "rate", "holiday_pct", "priority", "bar", "morning", "afternoon", "hours")
        self.tree_staff = ttk.Treeview(self.tab_staff, columns=cols, show="headings", height=13)
        headers = [
            ("id", "ID #", 70),
            ("name", "Nome Lavoratrice", 185),
            ("type", "Contratto", 100),
            ("rate", "Costo Orario (€/h)", 120),
            ("holiday_pct", "Magg. Festivi (%) — Fisse", 155),
            ("priority", "Priorità Sost. (1-5)", 140),
            ("bar", "Abil. Bar", 80),
            ("morning", "Abil. Mattina", 95),
            ("afternoon", "Abil. Pomeriggio", 105),
            ("hours", "Max Ore Sett.", 95),
        ]
        for col_id, text, width in headers:
            self.tree_staff.heading(col_id, text=text)
            self.tree_staff.column(col_id, width=width, anchor="center")
        self.tree_staff.pack(fill="both", expand=True, padx=10, pady=6)
        self.tree_staff.bind("<<TreeviewSelect>>", self._on_staff_select)

        # Barra inferiore: Aggiunta Nuova Lavoratrice
        add_bar = ctk.CTkFrame(self.tab_staff)
        add_bar.pack(fill="x", padx=10, pady=(4, 8))

        ctk.CTkLabel(
            add_bar,
            text="AGGIUNGI NUOVA LAVORATRICE:",
            font=ctk.CTkFont(weight="bold", size=12),
        ).pack(side="left", padx=6, pady=8)

        self.ent_new_name = ctk.CTkEntry(add_bar, width=140, placeholder_text="Nome nuova lavoratrice")
        self.ent_new_name.pack(side="left", padx=3)

        self.cmb_new_type = ctk.CTkComboBox(add_bar, values=["Fisso", "Sostituta"], width=95)
        self.cmb_new_type.set("Fisso")
        self.cmb_new_type.pack(side="left", padx=3)

        ctk.CTkLabel(add_bar, text="Priorità Sost.:").pack(side="left", padx=2)
        self.cmb_new_prio = ctk.CTkComboBox(
            add_bar,
            values=["1 - Massima", "2 - Alta", "3 - Media", "4 - Minima", "5 - Esclusa"],
            width=115,
        )
        self.cmb_new_prio.set("1 - Massima")
        self.cmb_new_prio.pack(side="left", padx=2)

        ctk.CTkLabel(add_bar, text="€/h:").pack(side="left", padx=2)
        self.ent_new_rate = ctk.CTkEntry(add_bar, width=58)
        self.ent_new_rate.insert(0, "12.50")
        self.ent_new_rate.pack(side="left", padx=2)

        ctk.CTkLabel(add_bar, text="Magg.Fest.%:").pack(side="left", padx=2)
        self.ent_new_holiday_pct = ctk.CTkEntry(add_bar, width=48)
        self.ent_new_holiday_pct.insert(0, "20")
        self.ent_new_holiday_pct.pack(side="left", padx=2)

        ctk.CTkLabel(add_bar, text="Max Ore:").pack(side="left", padx=2)
        self.ent_new_hours = ctk.CTkEntry(add_bar, width=45)
        self.ent_new_hours.insert(0, "40")
        self.ent_new_hours.pack(side="left", padx=2)

        self.var_new_bar = ctk.BooleanVar(value=False)
        self.var_new_morn = ctk.BooleanVar(value=True)
        self.var_new_aft = ctk.BooleanVar(value=True)
        ctk.CTkCheckBox(add_bar, text="Bar", variable=self.var_new_bar, width=48).pack(side="left", padx=2)
        ctk.CTkCheckBox(add_bar, text="Mattina", variable=self.var_new_morn, width=66).pack(side="left", padx=2)
        ctk.CTkCheckBox(add_bar, text="Pomeriggio", variable=self.var_new_aft, width=82).pack(side="left", padx=2)

        ctk.CTkButton(
            add_bar,
            text="+ Aggiungi Lavoratrice",
            fg_color="#16A34A",
            hover_color="#15803D",
            width=160,
            command=self._add_new_worker,
        ).pack(side="left", padx=6, pady=6)

        self._refresh_staff_tree()

    def _on_staff_select(self, _event):
        sel = self.tree_staff.selection()
        if not sel:
            return
        vals = self.tree_staff.item(sel[0], "values")
        raw_id = str(vals[0]).replace("#", "").strip()
        w_obj = next((w for w in self.config_data["workers"] if str(w["id"]) == raw_id), None)
        if not w_obj:
            return
        self.ent_rename.delete(0, "end")
        self.ent_rename.insert(0, w_obj.get("name", ""))
        self.cmb_edit_type.set(w_obj.get("type", "Fisso"))
        prio_num = max(1, min(5, int(w_obj.get("priority", 1) or 1)))
        prio_labels = {1: "1 - Massima", 2: "2 - Alta", 3: "3 - Media", 4: "4 - Minima", 5: "5 - Esclusa"}
        self.cmb_edit_prio.set(prio_labels.get(prio_num, "1 - Massima"))
        rate = float(w_obj.get("hourlyRate", 12.5))
        self.ent_hourly_rate.delete(0, "end")
        self.ent_hourly_rate.insert(0, f"{rate:.2f}")
        hol_pct = int(w_obj.get("holidaySurchargePct", 20 if w_obj.get("type") == "Fisso" else 0))
        self.ent_holiday_pct.delete(0, "end")
        self.ent_holiday_pct.insert(0, str(hol_pct))
        self.ent_edit_hours.delete(0, "end")
        self.ent_edit_hours.insert(0, str(w_obj.get("maxWeeklyHours", 40)))
        self.var_edit_bar.set(bool(w_obj.get("canBar", False)))
        self.var_edit_morn.set(bool(w_obj.get("canMorning", True)))
        self.var_edit_aft.set(bool(w_obj.get("canAfternoon", True)))

    def _update_selected_worker(self):
        sel = self.tree_staff.selection()
        if not sel:
            messagebox.showwarning("Selezione", "Seleziona prima una lavoratrice dalla tabella.")
            return
        raw_id = str(self.tree_staff.item(sel[0], "values")[0]).replace("#", "").strip()
        new_name = self.ent_rename.get().strip()
        try:
            new_rate = float(self.ent_hourly_rate.get().replace(",", ".").strip() or 12.5)
        except ValueError:
            new_rate = 12.5
        try:
            new_hol_pct = max(0, min(200, int(float(self.ent_holiday_pct.get().replace(",", ".").strip() or 20))))
        except ValueError:
            new_hol_pct = 20
        try:
            new_hrs = int(self.ent_edit_hours.get().strip() or 40)
        except ValueError:
            new_hrs = 40
        try:
            sel_prio = int(str(self.cmb_edit_prio.get()).split("-")[0].strip())
            sel_prio = max(1, min(5, sel_prio))
        except ValueError:
            sel_prio = 1

        for w in self.config_data["workers"]:
            if str(w["id"]) == raw_id:
                if new_name:
                    w["name"] = new_name
                w["type"] = self.cmb_edit_type.get()
                w["priority"] = sel_prio if w["type"] == "Sostituta" else 0
                w["hourlyRate"] = round(new_rate, 2)
                w["holidaySurchargePct"] = new_hol_pct if w["type"] == "Fisso" else 0
                w["maxWeeklyHours"] = max(6, new_hrs)
                w["canBar"] = bool(self.var_edit_bar.get())
                w["canMorning"] = bool(self.var_edit_morn.get())
                w["canAfternoon"] = bool(self.var_edit_aft.get())
                break

        self._auto_save()
        self._refresh_staff_tree()
        self._refresh_absences_tree()
        if hasattr(self, "cmb_abs_worker"):
            self.cmb_abs_worker.configure(values=[w["name"] for w in self.config_data["workers"]])
        self.run_optimizer(silent=True)
        messagebox.showinfo("Modifiche Salvate", "Dati lavoratrice salvati in memoria permanente (%APPDATA%).")

    def _add_new_worker(self):
        name = self.ent_new_name.get().strip()
        if not name:
            messagebox.showwarning("Nome mancante", "Inserisci il nome della nuova lavoratrice.")
            return
        next_num = self._next_numeric_id()
        w_type = self.cmb_new_type.get()
        try:
            rate = float(self.ent_new_rate.get().replace(",", ".").strip() or (12.5 if w_type == "Fisso" else 13.0))
        except ValueError:
            rate = 12.5
        try:
            hol_pct = max(0, min(200, int(float(self.ent_new_holiday_pct.get().replace(",", ".").strip() or 20))))
        except ValueError:
            hol_pct = 20
        try:
            max_h = int(self.ent_new_hours.get().strip() or 40)
        except ValueError:
            max_h = 40
        try:
            new_prio = max(1, min(5, int(str(self.cmb_new_prio.get()).split("-")[0].strip())))
        except ValueError:
            new_prio = 1

        new_worker = {
            "id": str(next_num),
            "numericId": next_num,
            "name": name,
            "type": w_type,
            "priority": new_prio if w_type == "Sostituta" else 0,
            "canBar": bool(self.var_new_bar.get()),
            "canMorning": bool(self.var_new_morn.get()),
            "canAfternoon": bool(self.var_new_aft.get()),
            "maxWeeklyHours": max(6, max_h),
            "hourlyRate": round(rate, 2),
            "holidaySurchargePct": hol_pct if w_type == "Fisso" else 0,
            "active": True,
        }
        self.config_data["workers"].append(new_worker)
        self.ent_new_name.delete(0, "end")
        self._auto_save()
        self._refresh_staff_tree()
        if hasattr(self, "cmb_abs_worker"):
            self.cmb_abs_worker.configure(values=[w["name"] for w in self.config_data["workers"]])
        self.run_optimizer(silent=True)
        messagebox.showinfo("Lavoratrice Aggiunta", f"Aggiunta '{name}' con ID immutabile #{next_num} e salvata su disco.")

    def _delete_selected_worker(self):
        sel = self.tree_staff.selection()
        if not sel:
            messagebox.showwarning("Selezione", "Seleziona prima la lavoratrice da eliminare nella tabella.")
            return
        vals = self.tree_staff.item(sel[0], "values")
        raw_id = str(vals[0]).replace("#", "").strip()
        w_name = vals[1]
        if not messagebox.askyesno(
            "Conferma Eliminazione",
            f"Vuoi davvero eliminare la lavoratrice #{raw_id} '{w_name}' dall'organico?",
        ):
            return
        self.config_data["workers"] = [
            w for w in self.config_data["workers"] if str(w["id"]) != raw_id
        ]
        self.config_data["absences"] = [
            a for a in self.config_data.get("absences", []) if str(a.get("workerId")) != raw_id
        ]
        self._auto_save()
        self._refresh_staff_tree()
        self._refresh_absences_tree()
        if hasattr(self, "cmb_abs_worker"):
            self.cmb_abs_worker.configure(values=[w["name"] for w in self.config_data["workers"]])
        self.run_optimizer(silent=True)

    def _refresh_staff_tree(self):
        for item in self.tree_staff.get_children():
            self.tree_staff.delete(item)
        prio_desc = {
            1: "1 (Massima)",
            2: "2 (Alta)",
            3: "3 (Media)",
            4: "4 (Minima)",
            5: "5 (Esclusa)",
        }
        for w in self.config_data["workers"]:
            if not w.get("active", True):
                continue
            rate = float(w.get("hourlyRate", 12.5 if w["type"] == "Fisso" else 13.0))
            hol_pct = int(w.get("holidaySurchargePct", 20 if w["type"] == "Fisso" else 0))
            hol_str = f"+{hol_pct}% (€ {rate * (1 + hol_pct / 100):.2f}/h)" if w["type"] == "Fisso" else "— (Solo Fisse)"
            prio_val = int(w.get("priority", 1) or 1)
            prio_str = prio_desc.get(prio_val, str(prio_val)) if w["type"] == "Sostituta" else "—"
            self.tree_staff.insert(
                "",
                "end",
                values=(
                    f"#{w['id']}",
                    w["name"],
                    w["type"],
                    f"€ {rate:.2f}/h",
                    hol_str,
                    prio_str,
                    "Sì" if w.get("canBar") else "No",
                    "Sì" if w.get("canMorning") else "No",
                    "Sì" if w.get("canAfternoon") else "No",
                    f"{w.get('maxWeeklyHours', 40)}h",
                ),
            )

    # -------------------------------------------------------------------------
    # SCHEDA 2: ORARI STANDARD & ECCEZIONI ORARIE DI CALENDARIO
    # -------------------------------------------------------------------------
    def _build_tab_shifts(self):
        top_frame = ctk.CTkFrame(self.tab_shifts)
        top_frame.pack(fill="x", padx=10, pady=6)
        self.shift_entries = {}
        bands = [("MON_WED", "Lun - Mer"), ("THU_SAT", "Gio - Sab"), ("SUN_HOL", "Dom / Festivi")]
        roles = [("bar", "Turno Bar"), ("morning", "Pulizie Mattina"), ("afternoon", "Pulizie Pomeriggio")]

        for r_idx, (r_key, r_label) in enumerate(roles):
            ctk.CTkLabel(top_frame, text=r_label, font=ctk.CTkFont(weight="bold", size=13)).grid(
                row=r_idx, column=0, padx=10, pady=6, sticky="w"
            )
            for b_idx, (b_key, b_label) in enumerate(bands):
                spec = self.config_data["shiftConfig"][r_key][b_key]
                sub = ctk.CTkFrame(top_frame)
                sub.grid(row=r_idx, column=b_idx + 1, padx=8, pady=4, sticky="ew")
                ctk.CTkLabel(sub, text=b_label, font=ctk.CTkFont(size=11, weight="bold")).pack(side="left", padx=4)
                e_lbl = ctk.CTkEntry(sub, width=72)
                e_lbl.insert(0, spec["label"])
                e_lbl.pack(side="left", padx=3, pady=3)
                e_hrs = ctk.CTkEntry(sub, width=42)
                e_hrs.insert(0, str(spec["hours"]))
                e_hrs.pack(side="left", padx=3, pady=3)
                self.shift_entries[(r_key, b_key)] = (e_lbl, e_hrs)

        ctk.CTkButton(top_frame, text="Salva Orari Standard", command=self._save_shifts_from_ui).grid(
            row=0, column=4, rowspan=2, padx=12, pady=4
        )
        ctk.CTkButton(
            top_frame,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            command=lambda: self._open_tab_guide_modal("SHIFTS"),
        ).grid(row=2, column=4, padx=12, pady=4)

        exc_box = ctk.CTkFrame(self.tab_shifts)
        exc_box.pack(fill="both", expand=True, padx=10, pady=8)

        ctk.CTkLabel(
            exc_box,
            text="ECCEZIONI ORARIE DI CALENDARIO (Modifica orario e ore per data e turno specifici, es. 03-nov Mattina 7-12 = 5h)",
            font=ctk.CTkFont(weight="bold", size=13),
        ).pack(anchor="w", padx=10, pady=(8, 4))

        exc_form = ctk.CTkFrame(exc_box)
        exc_form.pack(fill="x", padx=10, pady=4)

        date_values = [d["dateStr"] for d in self.config_data["calendar"]]
        ctk.CTkLabel(exc_form, text="Data:").pack(side="left", padx=4)
        self.cmb_exc_date = ctk.CTkComboBox(exc_form, values=date_values, width=110)
        self.cmb_exc_date.pack(side="left", padx=4)

        ctk.CTkLabel(exc_form, text="Turno:").pack(side="left", padx=4)
        self.cmb_exc_shift = ctk.CTkComboBox(exc_form, values=["BAR", "MORNING", "AFTERNOON"], width=120)
        self.cmb_exc_shift.set("MORNING")
        self.cmb_exc_shift.pack(side="left", padx=4)

        ctk.CTkLabel(exc_form, text="Nuovo Orario (es. 7-12):").pack(side="left", padx=4)
        self.ent_exc_label = ctk.CTkEntry(exc_form, width=90)
        self.ent_exc_label.insert(0, "7-12")
        self.ent_exc_label.pack(side="left", padx=4)

        ctk.CTkLabel(exc_form, text="Ore Retribuite:").pack(side="left", padx=4)
        self.ent_exc_hours = ctk.CTkEntry(exc_form, width=60)
        self.ent_exc_hours.insert(0, "5")
        self.ent_exc_hours.pack(side="left", padx=4)

        ctk.CTkButton(exc_form, text="Aggiungi / Aggiorna Eccezione", command=self._add_shift_exception).pack(
            side="left", padx=8
        )
        ctk.CTkButton(
            exc_form, text="Rimuovi Selezionata", fg_color="#DC2626", command=self._delete_shift_exception
        ).pack(side="left", padx=4)

        cols_exc = ("id", "dateStr", "shiftType", "label", "hours")
        self.tree_exc = ttk.Treeview(exc_box, columns=cols_exc, show="headings", height=8)
        for cid, txt, w_col in [
            ("id", "ID", 90),
            ("dateStr", "Data Calendario", 150),
            ("shiftType", "Turno Specifico", 160),
            ("label", "Orario Speciale", 160),
            ("hours", "Ore Retribuite", 140),
        ]:
            self.tree_exc.heading(cid, text=txt)
            self.tree_exc.column(cid, width=w_col, anchor="center")
        self.tree_exc.pack(fill="both", expand=True, padx=10, pady=6)
        self._refresh_exceptions_tree()

    def _save_shifts_from_ui(self):
        for (r_key, b_key), (e_lbl, e_hrs) in self.shift_entries.items():
            self.config_data["shiftConfig"][r_key][b_key]["label"] = e_lbl.get().strip()
            self.config_data["shiftConfig"][r_key][b_key]["hours"] = int(e_hrs.get().strip() or 6)
        self._auto_save()
        self.run_optimizer(silent=True)
        messagebox.showinfo("Orari Salvati", "Configurazione orari standard salvata in modo permanente.")

    def _add_shift_exception(self):
        d_str = self.cmb_exc_date.get().strip()
        s_type = self.cmb_exc_shift.get().strip()
        lbl = self.ent_exc_label.get().strip() or "7-12"
        hrs = int(self.ent_exc_hours.get().strip() or 5)
        day_obj = next((d for d in self.config_data["calendar"] if d["dateStr"] == d_str), None)
        if not day_obj:
            return
        ex_list = self.config_data.setdefault("shiftExceptions", [])
        ex_list[:] = [
            e for e in ex_list if not (e.get("dateStr") == d_str and e.get("shiftType") == s_type)
        ]
        ex_list.append({
            "id": f"exc-{int(datetime.now().timestamp() * 1000)}",
            "day": day_obj["day"],
            "isoDate": day_obj.get("isoDate", ""),
            "dateStr": d_str,
            "shiftType": s_type,
            "label": lbl,
            "hours": hrs,
            "note": "Eccezione calendario",
        })
        self._auto_save()
        self._refresh_exceptions_tree()
        self.run_optimizer(silent=True)

    def _delete_shift_exception(self):
        sel = self.tree_exc.selection()
        if not sel:
            return
        exc_id = self.tree_exc.item(sel[0], "values")[0]
        self.config_data["shiftExceptions"] = [
            e for e in self.config_data.get("shiftExceptions", []) if e.get("id") != exc_id
        ]
        self._auto_save()
        self._refresh_exceptions_tree()
        self.run_optimizer(silent=True)

    def _refresh_exceptions_tree(self):
        if not hasattr(self, "tree_exc"):
            return
        for i in self.tree_exc.get_children():
            self.tree_exc.delete(i)
        for ex in self.config_data.get("shiftExceptions", []):
            self.tree_exc.insert(
                "",
                "end",
                values=(
                    ex.get("id", ""),
                    ex.get("dateStr", ""),
                    ex.get("shiftType", ""),
                    ex.get("label", ""),
                    f"{ex.get('hours', 0)}h",
                ),
            )

    # -------------------------------------------------------------------------
    # SCHEDA 3: PERIODO & FABBISOGNO
    # -------------------------------------------------------------------------
    def _build_tab_calendar(self):
        top = ctk.CTkFrame(self.tab_calendar)
        top.pack(fill="x", padx=10, pady=6)

        ctk.CTkLabel(top, text="Mese (1-12):").pack(side="left", padx=4)
        self.ent_month = ctk.CTkEntry(top, width=50)
        self.ent_month.insert(0, str(self.config_data["month"]))
        self.ent_month.pack(side="left", padx=4)

        ctk.CTkLabel(top, text="Anno:").pack(side="left", padx=4)
        self.ent_year = ctk.CTkEntry(top, width=70)
        self.ent_year.insert(0, str(self.config_data["year"]))
        self.ent_year.pack(side="left", padx=4)

        ctk.CTkLabel(top, text="Giorni extra oltre fine mese:").pack(side="left", padx=6)
        self.ent_extra_days = ctk.CTkEntry(top, width=50)
        self.ent_extra_days.insert(0, str(self.config_data.get("extraDaysAfterMonth", 0)))
        self.ent_extra_days.pack(side="left", padx=4)

        ctk.CTkButton(top, text="Applica Mese + Giorni Extra", command=self._regenerate_month).pack(
            side="left", padx=8
        )

        ctk.CTkLabel(top, text="| Oppure Dal (YYYY-MM-DD):").pack(side="left", padx=6)
        self.ent_start_iso = ctk.CTkEntry(top, width=100)
        self.ent_start_iso.insert(0, self.config_data.get("customStartDate", "2026-11-01"))
        self.ent_start_iso.pack(side="left", padx=4)

        ctk.CTkLabel(top, text="Al:").pack(side="left", padx=4)
        self.ent_end_iso = ctk.CTkEntry(top, width=100)
        self.ent_end_iso.insert(0, self.config_data.get("customEndDate", "2026-12-06"))
        self.ent_end_iso.pack(side="left", padx=4)

        ctk.CTkButton(top, text="Genera Intervallo Date", fg_color="#334155", command=self._regenerate_custom_range).pack(
            side="left", padx=6
        )

        ctk.CTkButton(
            top,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            width=135,
            command=lambda: self._open_tab_guide_modal("CALENDAR"),
        ).pack(side="right", padx=6)

        cols = ("date", "day", "bar", "morning", "afternoon", "holiday")
        self.tree_cal = ttk.Treeview(self.tab_calendar, columns=cols, show="headings", height=18)
        for c_id, txt in [
            ("date", "Data"),
            ("day", "Giorno"),
            ("bar", "Fabb. Bar"),
            ("morning", "Fabb. Mattina"),
            ("afternoon", "Fabb. Pomeriggio"),
            ("holiday", "Festività"),
        ]:
            self.tree_cal.heading(c_id, text=txt)
            self.tree_cal.column(c_id, width=120, anchor="center")
        self.tree_cal.pack(fill="both", expand=True, padx=10, pady=8)
        self._refresh_calendar_tree()

    def _regenerate_month(self):
        m = int(self.ent_month.get() or 11)
        y = int(self.ent_year.get() or 2026)
        extra = int(self.ent_extra_days.get() or 0)
        self.config_data["month"] = m
        self.config_data["year"] = y
        self.config_data["extraDaysAfterMonth"] = extra
        self.config_data["calendar"] = generate_calendar_for_month(m, y, 1, 4, 2, extra)
        self._auto_save()
        self._refresh_calendar_tree()
        if hasattr(self, "cmb_exc_date"):
            self.cmb_exc_date.configure(values=[d["dateStr"] for d in self.config_data["calendar"]])
        self.run_optimizer(silent=True)

    def _regenerate_custom_range(self):
        try:
            s_d = date.fromisoformat(self.ent_start_iso.get().strip())
            e_d = date.fromisoformat(self.ent_end_iso.get().strip())
            self.config_data["calendar"] = generate_calendar_from_dates(s_d, e_d, 1, 4, 2)
            self._auto_save()
            self._refresh_calendar_tree()
            if hasattr(self, "cmb_exc_date"):
                self.cmb_exc_date.configure(values=[d["dateStr"] for d in self.config_data["calendar"]])
            self.run_optimizer(silent=True)
        except ValueError:
            messagebox.showerror("Formato Data", "Inserisci le date nel formato YYYY-MM-DD (es. 2026-11-01).")

    def _refresh_calendar_tree(self):
        for i in self.tree_cal.get_children():
            self.tree_cal.delete(i)
        for d in self.config_data["calendar"]:
            self.tree_cal.insert(
                "",
                "end",
                values=(
                    d["dateStr"],
                    d["dayAbbr"],
                    d["reqBar"],
                    d["reqMorning"],
                    d["reqAfternoon"],
                    "Festivo" if d.get("isHoliday") else "-",
                ),
            )

    # -------------------------------------------------------------------------
    # SCHEDA 4: FERIE & INDISPONIBILITÀ (COLLEGATE A ID NUMERICO)
    # -------------------------------------------------------------------------
    def _build_tab_absences(self):
        form = ctk.CTkFrame(self.tab_absences)
        form.pack(fill="x", padx=10, pady=8)

        worker_names = [w["name"] for w in self.config_data["workers"]]
        ctk.CTkLabel(form, text="Lavoratrice:").pack(side="left", padx=4)
        self.cmb_abs_worker = ctk.CTkComboBox(form, values=worker_names, width=150)
        self.cmb_abs_worker.pack(side="left", padx=4)

        ctk.CTkLabel(form, text="Dal giorno (1..N):").pack(side="left", padx=4)
        self.ent_abs_start = ctk.CTkEntry(form, width=50)
        self.ent_abs_start.insert(0, "1")
        self.ent_abs_start.pack(side="left", padx=4)

        ctk.CTkLabel(form, text="Al giorno:").pack(side="left", padx=4)
        self.ent_abs_end = ctk.CTkEntry(form, width=50)
        self.ent_abs_end.insert(0, "1")
        self.ent_abs_end.pack(side="left", padx=4)

        ctk.CTkLabel(form, text="Tipo:").pack(side="left", padx=4)
        self.cmb_abs_type = ctk.CTkComboBox(
            form,
            values=["Ferie", "Malattia", "Permesso ROL", "Riposo richiesto", "Indisponibilità generica"],
            width=150,
        )
        self.cmb_abs_type.pack(side="left", padx=4)

        ctk.CTkLabel(form, text="Ambito:").pack(side="left", padx=4)
        self.cmb_abs_scope = ctk.CTkComboBox(
            form,
            values=["FULL_DAY", "ONLY_MORNING", "ONLY_AFTERNOON", "ONLY_BAR"],
            width=140,
        )
        self.cmb_abs_scope.pack(side="left", padx=4)

        ctk.CTkButton(form, text="Aggiungi Ferie / Indisp.", command=self._add_absence_record).pack(
            side="left", padx=8
        )
        ctk.CTkButton(
            form, text="Elimina Selezionata", fg_color="#DC2626", command=self._delete_selected_absence
        ).pack(side="left", padx=4)

        ctk.CTkButton(
            form,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            width=135,
            command=lambda: self._open_tab_guide_modal("ABSENCES"),
        ).pack(side="right", padx=6)

        cols = ("id", "worker", "range", "type", "scope", "note")
        self.tree_abs = ttk.Treeview(self.tab_absences, columns=cols, show="headings", height=15)
        for c_id, txt, w_col in [
            ("id", "ID Record", 100),
            ("worker", "Dipendente (ID Numerico)", 210),
            ("range", "Periodo / Giorno", 180),
            ("type", "Tipologia Assenza", 160),
            ("scope", "Ambito Turno", 160),
            ("note", "Note", 180),
        ]:
            self.tree_abs.heading(c_id, text=txt)
            self.tree_abs.column(c_id, width=w_col, anchor="center")
        self.tree_abs.pack(fill="both", expand=True, padx=10, pady=8)
        self._refresh_absences_tree()

    def _add_absence_record(self):
        w_name = self.cmb_abs_worker.get()
        w_obj = next((w for w in self.config_data["workers"] if w["name"] == w_name), None)
        if not w_obj:
            return
        s_day = int(self.ent_abs_start.get() or 1)
        e_day = int(self.ent_abs_end.get() or s_day)
        self.config_data.setdefault("absences", []).append({
            "id": f"abs-{int(datetime.now().timestamp() * 1000)}",
            "workerId": w_obj["id"],
            "startDay": min(s_day, e_day),
            "endDay": max(s_day, e_day),
            "type": self.cmb_abs_type.get(),
            "scope": self.cmb_abs_scope.get(),
            "note": "",
        })
        self._auto_save()
        self._refresh_absences_tree()
        self.run_optimizer(silent=True)

    def _delete_selected_absence(self):
        sel = self.tree_abs.selection()
        if not sel:
            return
        abs_id = self.tree_abs.item(sel[0], "values")[0]
        self.config_data["absences"] = [
            a for a in self.config_data.get("absences", []) if a["id"] != abs_id
        ]
        self._auto_save()
        self._refresh_absences_tree()
        self.run_optimizer(silent=True)

    def _refresh_absences_tree(self):
        for i in self.tree_abs.get_children():
            self.tree_abs.delete(i)
        w_map = {w["id"]: f"#{w['id']} {w['name']}" for w in self.config_data["workers"]}
        cal_map = {d["day"]: d["dateStr"] for d in self.config_data["calendar"]}
        for a in self.config_data.get("absences", []):
            d_s = cal_map.get(a["startDay"], str(a["startDay"]))
            d_e = cal_map.get(a["endDay"], str(a["endDay"]))
            rng_txt = d_s if a["startDay"] == a["endDay"] else f"{d_s} -> {d_e}"
            self.tree_abs.insert(
                "",
                "end",
                values=(
                    a["id"],
                    w_map.get(a["workerId"], a["workerId"]),
                    rng_txt,
                    a["type"],
                    a["scope"],
                    a.get("note", ""),
                ),
            )

    # -------------------------------------------------------------------------
    # SCHEDA 5: VINCOLI CCNL & EQUITÀ
    # -------------------------------------------------------------------------
    def _build_tab_ccnl(self):
        frame = ctk.CTkFrame(self.tab_ccnl)
        frame.pack(fill="both", expand=True, padx=20, pady=20)
        c = self.config_data["constraints"]

        top_ccnl = ctk.CTkFrame(frame, fg_color="transparent")
        top_ccnl.pack(fill="x", padx=10, pady=(6, 4))
        ctk.CTkLabel(
            top_ccnl,
            text="Vincoli Normativi CCNL Turismo & Regole di Equità",
            font=ctk.CTkFont(size=15, weight="bold"),
        ).pack(side="left", padx=6)
        ctk.CTkButton(
            top_ccnl,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            width=135,
            command=lambda: self._open_tab_guide_modal("CCNL"),
        ).pack(side="right", padx=6)

        self.var_ccnl_11h = ctk.BooleanVar(value=c.get("forbidAfternoonToMorning", True))
        ctk.CTkSwitch(
            frame,
            text="Regola Pomeriggio -> Mattina vietata (Rispetto 11h riposo CCNL)",
            variable=self.var_ccnl_11h,
            command=self._on_ccnl_toggle,
        ).pack(anchor="w", pady=12, padx=16)

        ctk.CTkLabel(frame, text=f"Massimo giorni consecutivi lavorabili: {c.get('maxConsecutiveDays', 6)}").pack(
            anchor="w", padx=16, pady=6
        )
        ctk.CTkLabel(
            frame,
            text=f"Limite Pomeriggi Consecutivi: Massimo {c.get('maxConsecutiveAfternoons', 3)} consecutivi (invalicabile), preferibilmente {c.get('preferredConsecutiveAfternoons', 2)} consecutivi.",
            font=ctk.CTkFont(weight="bold"),
        ).pack(anchor="w", padx=16, pady=6)
        ctk.CTkLabel(frame, text=f"Minimo giorni di riposo settimanali (Lun-Dom): {c.get('minWeeklyRestDays', 1)}").pack(
            anchor="w", padx=16, pady=6
        )
        ctk.CTkLabel(
            frame,
            text="Vincolo garantito attivo: almeno 1 Domenica libera al mese e rotazione su ultimi 3 mesi (max 3 domeniche lavorate consecutive).",
            font=ctk.CTkFont(weight="bold"),
        ).pack(anchor="w", padx=16, pady=10)

    def _on_ccnl_toggle(self):
        self.config_data["constraints"]["forbidAfternoonToMorning"] = bool(self.var_ccnl_11h.get())
        self._auto_save()

    # -------------------------------------------------------------------------
    # SCHEDA 6: GENERAZIONE, ARCHIVIAZIONE IN STORICO & ESPORTAZIONE
    # -------------------------------------------------------------------------
    def _build_tab_solve(self):
        top = ctk.CTkFrame(self.tab_solve)
        top.pack(fill="x", padx=10, pady=8)

        ctk.CTkButton(
            top,
            text="Calcola Turni Ottimizzati (CP-SAT)",
            fg_color="#16A34A",
            hover_color="#15803D",
            width=220,
            command=self.run_optimizer,
        ).pack(side="left", padx=5, pady=8)

        ctk.CTkButton(
            top,
            text="Archivia Mese in Storico Turni",
            fg_color="#2563EB",
            hover_color="#1D4ED8",
            width=200,
            command=self._archive_current_schedule,
        ).pack(side="left", padx=5, pady=8)

        ctk.CTkButton(
            top, text="Esporta Excel (.xlsx)", width=160, command=self.export_excel_action
        ).pack(side="left", padx=5, pady=8)

        ctk.CTkButton(
            top, text="Esporta Immagine 300 DPI (.jpeg)", width=200, command=self.export_image_action
        ).pack(side="left", padx=5, pady=8)

        ctk.CTkButton(
            top,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            width=135,
            command=lambda: self._open_tab_guide_modal("SOLVE"),
        ).pack(side="right", padx=6, pady=8)

        # Banner interattivo Alert Criticità con tasto [ 🔍 Vai al Problema ]
        self.alert_frame = ctk.CTkFrame(self.tab_solve, fg_color="#ECFDF5", corner_radius=8)
        self.alert_frame.pack(fill="x", padx=10, pady=(0, 6))
        self.lbl_alert_status = ctk.CTkLabel(
            self.alert_frame,
            text="✅ Nessun problema di turnazione rilevato (100% turni coperti e conformi al CCNL).",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#065F46",
        )
        self.lbl_alert_status.pack(side="left", padx=12, pady=8)

        self.btn_inspect_problem = ctk.CTkButton(
            self.alert_frame,
            text="🔍 Vai al Problema / Mostra Dettaglio",
            fg_color="#DC2626",
            hover_color="#B91C1C",
            width=230,
            command=self._open_conflict_inspector_modal,
        )
        self.btn_inspect_problem.pack(side="right", padx=10, pady=6)

        self.txt_log = ctk.CTkTextbox(self.tab_solve, height=400, font=ctk.CTkFont(family="Consolas", size=12))
        self.txt_log.pack(fill="both", expand=True, padx=10, pady=8)

    def _detect_detailed_problems(self):
        problems = []
        workers = [w for w in self.config_data.get("workers", []) if w.get("active", True)]
        absences = self.config_data.get("absences", [])
        cal = self.config_data.get("calendar", [])
        assignments = (self.current_solution or {}).get("assignments", {})

        dow_names = {
            0: "Domenica",
            1: "Lunedì",
            2: "Martedì",
            3: "Mercoledì",
            4: "Giovedì",
            5: "Venerdì",
            6: "Sabato",
        }

        for day_req in cal:
            d = day_req["day"]
            d_str = day_req["dateStr"]
            full_day = f"{dow_names.get(day_req.get('dayOfWeek', 1), day_req.get('dayAbbr', ''))} {d_str}"
            day_map = assignments.get(d) or assignments.get(str(d)) or {}

            for s_type, req_key, name_it in [
                ("BAR", "reqBar", "Turno Bar"),
                ("MORNING", "reqMorning", "Turno Mattina"),
                ("AFTERNOON", "reqAfternoon", "Turno Pomeriggio"),
            ]:
                req_n = int(day_req.get(req_key, 0))
                assigned_n = sum(
                    1
                    for w in workers
                    if (day_map.get(w["id"]) or {}).get("shiftType") == s_type
                )
                if self.current_solution and self.current_solution.get("status") == "INFEASIBLE":
                    # Controlla se le assenze impediscono la copertura
                    from solver import is_worker_blocked
                    avail_w = [w for w in workers if not is_worker_blocked(w, d, s_type, absences)]
                    if len(avail_w) < req_n:
                        spec = get_shift_spec(self.config_data, day_req, s_type)
                        problems.append({
                            "day": d,
                            "dateStr": d_str,
                            "fullDay": full_day,
                            "shiftTitle": f"{name_it} {spec['label']}: richieste {req_n} persone, disponibili solo {len(avail_w)} lavoratrici",
                            "rule": "Troppe ferie/indisponibilità contemporanee o mansione scoperta",
                            "detail": f"Giorno {full_day}: il {name_it} ({spec['label']}) richiede {req_n} operatrici ma solo {len(avail_w)} risultano disponibili.",
                        })
                elif assignments and assigned_n < req_n:
                    spec = get_shift_spec(self.config_data, day_req, s_type)
                    problems.append({
                        "day": d,
                        "dateStr": d_str,
                        "fullDay": full_day,
                        "shiftTitle": f"{name_it} {spec['label']}: richieste {req_n} persone, assegnate solo {assigned_n} lavoratrici",
                        "rule": "Scopertura Fabbisogno Giornaliero",
                        "detail": f"Giorno {full_day}: mancano {req_n - assigned_n} operatrici nel {name_it} ({spec['label']}).",
                    })

        if self.current_solution and self.current_solution.get("status") == "INFEASIBLE" and not problems:
            for diag_line in self.current_solution.get("diagnostics", []):
                problems.append({
                    "day": 1,
                    "dateStr": cal[0]["dateStr"] if cal else "01",
                    "fullDay": f"Conflitto Generale ({cal[0]['dateStr'] if cal else 'Mese'})",
                    "shiftTitle": diag_line,
                    "rule": "Incompatibilità Vincoli CP-SAT (Ferie / Ore Max Settimanali / Riposo 11h)",
                    "detail": diag_line,
                })

        return problems

    def _update_alert_banner(self):
        if not hasattr(self, "alert_frame"):
            return
        probs = self._detect_detailed_problems()
        if probs:
            self.alert_frame.configure(fg_color="#FEF2F2")
            self.lbl_alert_status.configure(
                text=f"⚠️ Rilevati {len(probs)} problemi di turnazione — Clicca su 'Vai al Problema' per ispezionare il giorno e il turno critico",
                text_color="#991B1B",
            )
            self.btn_inspect_problem.configure(fg_color="#DC2626", text=f"🔍 Vai al Problema ({len(probs)})")
        else:
            self.alert_frame.configure(fg_color="#ECFDF5")
            self.lbl_alert_status.configure(
                text="✅ 0 problemi rilevati: tutti i turni (Bar, Mattina, Pomeriggio) e i vincoli CCNL sono soddisfatti.",
                text_color="#065F46",
            )
            self.btn_inspect_problem.configure(fg_color="#334155", text="👁️ Ispeziona Stato Turni")

    def _open_conflict_inspector_modal(self):
        probs = self._detect_detailed_problems()
        win = ctk.CTkToplevel(self)
        win.title("Ispezione Giorno / Turno Problematico — Diagnostica Alert")
        win.geometry("760x520")
        win.attributes("-topmost", True)

        hdr = ctk.CTkFrame(win, fg_color="#DC2626" if probs else "#0F172A", corner_radius=0)
        hdr.pack(fill="x")
        ctk.CTkLabel(
            hdr,
            text=(
                f"⚠️ Rilevati {len(probs)} problemi di turnazione"
                if probs
                else "✅ Nessun Conflitto o Anomalia Rilevata nella Turnazione"
            ),
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color="#FFFFFF",
        ).pack(side="left", padx=16, pady=12)

        body = ctk.CTkScrollableFrame(win)
        body.pack(fill="both", expand=True, padx=14, pady=12)

        if not probs:
            ctk.CTkLabel(
                body,
                text="Tutti i turni giornalieri (Bar, Mattina e Pomeriggio) sono regolarmente coperti\\n"
                     "nel pieno rispetto delle 11 ore di riposo CCNL, del massimo di 3 pomeriggi consecutivi\\n"
                     "e della rotazione trimestrale delle domeniche libere.",
                font=ctk.CTkFont(size=13),
                justify="left",
            ).pack(anchor="w", padx=10, pady=12)
        else:
            for p in probs:
                card = ctk.CTkFrame(body, fg_color="#FFFFFF", border_width=1, border_color="#FCA5A5")
                card.pack(fill="x", padx=6, pady=6)

                ctk.CTkLabel(
                    card,
                    text=f"📅 Giorno Specifico: {p['fullDay']}   |   ⚠️ Regola Violata: {p['rule']}",
                    font=ctk.CTkFont(size=12, weight="bold"),
                    text_color="#B91C1C",
                ).pack(anchor="w", padx=12, pady=(8, 2))

                ctk.CTkLabel(
                    card,
                    text=f"Turnazione Prevista: {p['shiftTitle']}",
                    font=ctk.CTkFont(size=12, weight="bold"),
                    text_color="#0F172A",
                ).pack(anchor="w", padx=12, pady=2)

                ctk.CTkLabel(
                    card,
                    text=p["detail"],
                    font=ctk.CTkFont(size=11),
                    text_color="#475569",
                    wraplength=680,
                    justify="left",
                ).pack(anchor="w", padx=12, pady=(2, 6))

                def _jump_to_day(day_num=p["day"], date_s=p["dateStr"]):
                    self.tabview.set("2. Periodo & Fabbisogno")
                    for item_id in self.tree_cal.get_children():
                        vals = self.tree_cal.item(item_id, "values")
                        if vals and str(vals[0]) == str(date_s):
                            self.tree_cal.selection_set(item_id)
                            self.tree_cal.focus(item_id)
                            self.tree_cal.see(item_id)
                            break
                    win.destroy()

                ctk.CTkButton(
                    card,
                    text=f"🎯 Evidenzia Giorno {p['dateStr']} nella Tabella Calendario",
                    fg_color="#0F172A",
                    height=28,
                    command=_jump_to_day,
                ).pack(anchor="e", padx=12, pady=(2, 8))

    def _open_tab_guide_modal(self, guide_key: str):
        title, content = TAB_HELP_GUIDES.get(guide_key, TAB_HELP_GUIDES["SOLVE"])
        win = ctk.CTkToplevel(self)
        win.title(title)
        win.geometry("720x500")
        win.attributes("-topmost", True)

        hdr = ctk.CTkFrame(win, fg_color="#0F172A", corner_radius=0)
        hdr.pack(fill="x")
        ctk.CTkLabel(
            hdr,
            text=title,
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color="#FEF08A",
        ).pack(side="left", padx=16, pady=12)

        txt = ctk.CTkTextbox(win, font=ctk.CTkFont(family="Segoe UI", size=13), wrap="word")
        txt.pack(fill="both", expand=True, padx=16, pady=14)
        txt.insert("1.0", content)
        txt.configure(state="disabled")

        ctk.CTkButton(
            win,
            text="Ho capito, chiudi guida",
            fg_color="#0F172A",
            command=win.destroy,
        ).pack(pady=(0, 12))

    def run_optimizer(self, silent: bool = False):
        self.config_data["constraints"]["forbidAfternoonToMorning"] = bool(self.var_ccnl_11h.get())
        self.history_records = ConfigManager.load_history()
        self.config_data["history"] = self.history_records
        self.config_data["_history_records"] = self.history_records
        self._auto_save()
        if hasattr(self, "txt_log"):
            self.txt_log.delete("1.0", "end")
            self.txt_log.insert("end", "Avvio motore matematico Google OR-Tools CP-SAT in corso...\\n")
            if not silent:
                self.update_idletasks()

        self.config_data["_allow_afternoon_overflow"] = False
        sol = solve_schedule(self.config_data)

        if sol.get("requiresAfternoonOverflowConfirmation") and not silent:
            ex_list = sol.get("indispensableAfternoonExceptions", [])
            details = "\\n".join(
                f"• {e['workerName']} — {e['dateStr']} ({e.get('dayAbbr', '')})"
                for e in ex_list
            )
            ask_msg = (
                "La regola prevede che nessuno svolga più di 3 pomeriggi consecutivi.\\n\\n"
                "Tuttavia, per non lasciare turni di Pomeriggio scoperti in questo periodo, "
                "risulta strettamente indispensabile superare i 3 pomeriggi consecutivi per:\\n"
                f"{details}\\n\\n"
                "Vuoi autorizzare eccezionalmente il superamento dei 3 pomeriggi consecutivi "
                "solo per coprire questi turni indispensabili?"
            )
            if messagebox.askyesno("Richiesta Conferma: Superamento 3 Pomeriggi Consecutivi", ask_msg):
                self.config_data["_allow_afternoon_overflow"] = True
                sol = solve_schedule(self.config_data)

        self.current_solution = sol
        self._update_alert_banner()

        if hasattr(self, "txt_log"):
            self.txt_log.insert("end", f"Stato Risolutore: {sol['status']}\\n")
            for msg in sol.get("diagnostics", []):
                self.txt_log.insert("end", f"• {msg}\\n")

            if sol["status"] in ("OPTIMAL", "FEASIBLE"):
                self.txt_log.insert("end", "\\nRIEPILOGO MONTE ORE, TURNI E COSTI STIMATI DEL MESE:\\n")
                for w in self.config_data["workers"]:
                    if not w.get("active", True):
                        continue
                    st = sol["workerStats"].get(w["id"], {})
                    rate = float(w.get("hourlyRate", 12.5 if w["type"] == "Fisso" else 13.5))
                    tot_h = st.get("totalHours", 0)
                    cost_eur = tot_h * rate
                    self.txt_log.insert(
                        "end",
                        f"- #{w['id']:<2} {w['name']:<18} | Ore: {tot_h:>3}h | Giorni: {st.get('workedDays', 0):>2} "
                        f"| Bar: {st.get('barCount', 0):>2} | Mattine: {st.get('morningCount', 0):>2} "
                        f"| Pomeriggi: {st.get('afternoonCount', 0):>2} | Dom: {st.get('sundaysWorked', 0):>1} | Costo: € {cost_eur:>7.2f}\\n",
                    )

        self._refresh_costs_tab()

    # -------------------------------------------------------------------------
    # SCHEDA 7: STORICO TURNI (LAYOUT IDENTICO ALL'ANTEPRIMA WEB: CARDS + STRIP 8 LAVORATRICI + GRIGLIA COLORATA)
    # -------------------------------------------------------------------------
    def _build_tab_history(self):
        self.preview_history_id = None
        self._hist_toast_after_id = None

        self.hist_scroll = ctk.CTkScrollableFrame(
            self.tab_history, fg_color="#F1F5F9", corner_radius=0
        )
        self.hist_scroll.pack(fill="both", expand=True, padx=0, pady=0)

        # 1. CARD SUPERIORE: INTESTAZIONE + PULSANTI EXCEL + BARRA DI ARCHIVIAZIONE ESPLICITA
        top_card = ctk.CTkFrame(
            self.hist_scroll,
            fg_color="#FFFFFF",
            border_width=1,
            border_color="#E2E8F0",
            corner_radius=8,
        )
        top_card.pack(fill="x", padx=12, pady=(10, 8))

        hdr_row = ctk.CTkFrame(top_card, fg_color="transparent")
        hdr_row.pack(fill="x", padx=16, pady=(14, 10))

        hdr_left = ctk.CTkFrame(hdr_row, fg_color="transparent")
        hdr_left.pack(side="left", fill="x", expand=True)

        title_line = ctk.CTkFrame(hdr_left, fg_color="transparent")
        title_line.pack(anchor="w")

        ctk.CTkLabel(
            title_line,
            text="🕒 Storico Turni — Caricamento da Excel (.xlsx) & Bilanciamento Plurimensile",
            font=ctk.CTkFont(size=17, weight="bold"),
            text_color="#0F172A",
        ).pack(side="left")

        self.lbl_hist_count_badge = ctk.CTkLabel(
            title_line,
            text=f"  ({len(self.history_records)} periodi salvati · Ordine dal più recente)",
            font=ctk.CTkFont(family="Consolas", size=12),
            text_color="#64748B",
        )
        self.lbl_hist_count_badge.pack(side="left", padx=(6, 0))

        ctk.CTkLabel(
            hdr_left,
            text=(
                "Puoi caricare turni passati direttamente da file Excel (.xlsx) oppure archiviare il mese corrente. "
                "Il motore matematico legge automaticamente lo storico per equilibrare festività/weekend (Domeniche e Festivi), "
                "monte ore (~160h) e rotazione Mattina/Pomeriggio nella creazione dei nuovi turni."
            ),
            font=ctk.CTkFont(size=12),
            text_color="#475569",
            wraplength=760,
            justify="left",
        ).pack(anchor="w", pady=(4, 0))

        hdr_right = ctk.CTkFrame(hdr_row, fg_color="transparent")
        hdr_right.pack(side="right", padx=(8, 0))

        ctk.CTkButton(
            hdr_right,
            text="📤 Importa Turni da Excel (.xlsx) nello Storico",
            fg_color="#047857",
            hover_color="#065F46",
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=12, weight="bold"),
            height=34,
            corner_radius=6,
            command=self._import_history_excel_dialog,
        ).pack(side="left", padx=4)

        ctk.CTkButton(
            hdr_right,
            text="📥 Esporta Intero Storico in Excel (.xlsx)",
            fg_color="#FFFFFF",
            hover_color="#F8FAFC",
            text_color="#334155",
            border_width=1,
            border_color="#CBD5E1",
            font=ctk.CTkFont(size=12, weight="bold"),
            height=34,
            corner_radius=6,
            command=self._export_all_history_excel_dialog,
        ).pack(side="left", padx=4)

        ctk.CTkButton(
            hdr_right,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=12, weight="bold"),
            width=125,
            height=34,
            corner_radius=6,
            command=lambda: self._open_tab_guide_modal("HISTORY"),
        ).pack(side="left", padx=(4, 0))

        # Divider
        ctk.CTkFrame(top_card, fg_color="#E2E8F0", height=1).pack(fill="x", padx=16, pady=(2, 12))

        # Barra di Archiviazione Esplicita (identica al form bg-slate-50 dell'anteprima web)
        arch_box = ctk.CTkFrame(
            top_card,
            fg_color="#F8FAFC",
            border_width=1,
            border_color="#E2E8F0",
            corner_radius=8,
        )
        arch_box.pack(fill="x", padx=16, pady=(0, 14))

        arch_inner = ctk.CTkFrame(arch_box, fg_color="transparent")
        arch_inner.pack(fill="x", padx=14, pady=12)

        m = int(self.config_data.get("month", 11))
        y = int(self.config_data.get("year", 2026))
        cal = self.config_data.get("calendar", [])
        default_title = f"{ITALIAN_MONTHS_FULL.get(m, 'Novembre')} {y}"
        default_range = (
            f"{cal[0]['dateStr']} – {cal[-1]['dateStr']}" if cal else f"01/{m:02d}/{y} - 30/{m:02d}/{y}"
        )

        col1 = ctk.CTkFrame(arch_inner, fg_color="transparent")
        col1.pack(side="left", padx=(0, 14))
        ctk.CTkLabel(
            col1,
            text="Periodo di Riferimento (Mese / Titolo)",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color="#1E293B",
        ).pack(anchor="w", pady=(0, 3))
        self.ent_hist_label = ctk.CTkEntry(
            col1,
            width=230,
            height=32,
            placeholder_text=f"Es. {default_title}",
            fg_color="#FFFFFF",
            border_color="#CBD5E1",
        )
        self.ent_hist_label.pack(anchor="w")

        col2 = ctk.CTkFrame(arch_inner, fg_color="transparent")
        col2.pack(side="left", padx=(0, 14))
        ctk.CTkLabel(
            col2,
            text="Intervallo Date (Dal → Al)",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color="#1E293B",
        ).pack(anchor="w", pady=(0, 3))
        self.ent_hist_range = ctk.CTkEntry(
            col2,
            width=220,
            height=32,
            placeholder_text=f"Es. {default_range}",
            fg_color="#FFFFFF",
            border_color="#CBD5E1",
            font=ctk.CTkFont(family="Consolas", size=12),
        )
        self.ent_hist_range.pack(anchor="w")

        col3 = ctk.CTkFrame(arch_inner, fg_color="transparent")
        col3.pack(side="left", padx=(0, 14))
        ctk.CTkLabel(
            col3,
            text="Orario Attivo Pronto per Archiviazione:",
            font=ctk.CTkFont(size=11),
            text_color="#64748B",
        ).pack(anchor="w", pady=(2, 1))
        self.lbl_hist_active_summary = ctk.CTkLabel(
            col3,
            text=f"{default_title} ({default_range}) · {len(cal)} giorni",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#0F172A",
        )
        self.lbl_hist_active_summary.pack(anchor="w")

        ctk.CTkButton(
            arch_inner,
            text="💾 Salva e Archivia Orario Corrente nello Storico",
            fg_color="#0F172A",
            hover_color="#1E293B",
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=12, weight="bold"),
            height=36,
            corner_radius=6,
            command=self._archive_current_schedule,
        ).pack(side="right", padx=(8, 0))

        # Banner Toast Feedback (nascosto di default)
        self.hist_toast_frame = ctk.CTkFrame(
            top_card,
            fg_color="#ECFDF5",
            border_width=1,
            border_color="#A7F3D0",
            corner_radius=6,
        )
        self.lbl_hist_toast = ctk.CTkLabel(
            self.hist_toast_frame,
            text="",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#065F46",
        )
        self.lbl_hist_toast.pack(anchor="w", padx=12, pady=8)

        # 2. PANNELLO DINAMICO ANTEPRIMA GRIGLIA COLORATA (visibile quando si clicca "Anteprima Griglia Turni")
        self.hist_preview_panel = ctk.CTkFrame(
            self.hist_scroll,
            fg_color="#FFFFFF",
            border_width=2,
            border_color="#0F172A",
            corner_radius=8,
        )

        # 3. ELENCO ORARI ARCHIVIATI A SCHEDE (ORDINE CRONOLOGICO DECRESCENTE)
        list_outer = ctk.CTkFrame(
            self.hist_scroll,
            fg_color="#FFFFFF",
            border_width=1,
            border_color="#E2E8F0",
            corner_radius=8,
        )
        list_outer.pack(fill="both", expand=True, padx=12, pady=(4, 14))

        list_hdr = ctk.CTkFrame(list_outer, fg_color="#F1F5F9", corner_radius=6)
        list_hdr.pack(fill="x", padx=2, pady=2)

        ctk.CTkLabel(
            list_hdr,
            text="ELENCO ORARI ARCHIVIATI (ORDINE CRONOLOGICO DECRESCENTE: DAL PIÙ RECENTE AL PIÙ VECCHIO)",
            font=ctk.CTkFont(size=11, weight="bold"),
            text_color="#1E293B",
        ).pack(side="left", padx=14, pady=9)

        ctk.CTkLabel(
            list_hdr,
            text="Clicca su Anteprima Griglia Turni per vedere il tabellone colorato del mese oppure riesporta Excel / JPEG",
            font=ctk.CTkFont(size=11),
            text_color="#475569",
        ).pack(side="right", padx=14, pady=9)

        self.hist_cards_container = ctk.CTkFrame(list_outer, fg_color="transparent")
        self.hist_cards_container.pack(fill="both", expand=True, padx=12, pady=10)

        self._refresh_history_tree()

    def _show_history_toast(self, message: str):
        if not hasattr(self, "hist_toast_frame"):
            return
        self.lbl_hist_toast.configure(text=f"✔  {message}")
        self.hist_toast_frame.pack(fill="x", padx=16, pady=(0, 12))
        if self._hist_toast_after_id is not None:
            try:
                self.after_cancel(self._hist_toast_after_id)
            except Exception:
                pass
        self._hist_toast_after_id = self.after(
            5000, lambda: self.hist_toast_frame.pack_forget()
        )

    def _export_all_history_excel_dialog(self):
        if not self.history_records:
            messagebox.showwarning("Storico Vuoto", "Non ci sono periodi archiviati nello Storico da esportare.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".xlsx",
            filetypes=[("File Excel", "*.xlsx")],
            initialfile=f"Storico_Completo_Turni_RT_{self.config_data.get('year', 2026)}.xlsx",
        )
        if not path:
            return
        try:
            export_all_history_to_excel(self.config_data, self.history_records, path)
            self._show_history_toast("Intero archivio storico esportato in formato Microsoft Excel (.xlsx)!")
            messagebox.showinfo("Esportazione Intero Storico Excel", f"Archivio storico completo salvato in:\\n{path}")
        except Exception as exc:
            messagebox.showerror("Errore Esportazione", f"Impossibile esportare lo storico in Excel:\\n{exc}")

    def _import_history_excel_dialog(self):
        paths = filedialog.askopenfilenames(
            title="Seleziona uno o più file Excel (.xlsx) dei turni passati da caricare nello Storico",
            filetypes=[("File Excel", "*.xlsx *.xls")],
        )
        if not paths:
            return
        imported_count = 0
        for p in paths:
            try:
                self.history_records = ConfigManager.import_history_from_excel(p, self.config_data)
                imported_count += 1
            except Exception as exc:
                messagebox.showerror("Errore Importazione Excel", f"Impossibile leggere il file {os.path.basename(p)}:\\n{exc}")
        if imported_count > 0:
            if self.history_records:
                self.preview_history_id = self.history_records[0].get("id")
            self._refresh_history_tree()
            self.run_optimizer(silent=True)
            self._show_history_toast(
                f"Caricati con successo {imported_count} file Excel (.xlsx) nello Storico! Il solver ora bilancerà festività, weekend, ore e turni."
            )

    def _archive_current_schedule(self):
        if not self.current_solution or not self.current_solution.get("assignments"):
            self.run_optimizer(silent=True)
        lbl = self.ent_hist_label.get().strip() if hasattr(self, "ent_hist_label") else ""
        rng = self.ent_hist_range.get().strip() if hasattr(self, "ent_hist_range") else ""
        self.history_records = ConfigManager.save_history_record(
            self.config_data, self.current_solution, lbl, rng
        )
        if hasattr(self, "ent_hist_label"):
            self.ent_hist_label.delete(0, "end")
        if hasattr(self, "ent_hist_range"):
            self.ent_hist_range.delete(0, "end")
        if self.history_records:
            self.preview_history_id = self.history_records[0].get("id")
        self._refresh_history_tree()
        self.run_optimizer(silent=True)
        saved_lbl = self.history_records[0].get("periodLabel", "") if self.history_records else lbl
        self._show_history_toast(
            f"Orario '{saved_lbl}' archiviato nello Storico! Il solver lo userà per equilibrare ore, weekend/festività e turni."
        )

    def _toggle_history_preview(self, rec_id: str):
        if self.preview_history_id == rec_id:
            self.preview_history_id = None
        else:
            self.preview_history_id = rec_id
        self._refresh_history_tree()

    def _render_history_preview_panel(self, rec: Dict[str, Any]):
        for child in self.hist_preview_panel.winfo_children():
            child.destroy()

        top_bar = ctk.CTkFrame(self.hist_preview_panel, fg_color="transparent")
        top_bar.pack(fill="x", padx=16, pady=(12, 8))

        left_info = ctk.CTkFrame(top_bar, fg_color="transparent")
        left_info.pack(side="left", fill="x", expand=True)

        ctk.CTkLabel(
            left_info,
            text=f"👁️ Anteprima Orario Archiviato: {rec.get('periodLabel', '')}",
            font=ctk.CTkFont(size=15, weight="bold"),
            text_color="#0F172A",
        ).pack(anchor="w")

        ctk.CTkLabel(
            left_info,
            text=f"Salvato il {rec.get('savedAt', '')} · {rec.get('numDays', len(rec.get('configSnapshot', {}).get('calendar', [])))} giorni",
            font=ctk.CTkFont(family="Consolas", size=11),
            text_color="#64748B",
        ).pack(anchor="w")

        btn_bar = ctk.CTkFrame(top_bar, fg_color="transparent")
        btn_bar.pack(side="right")

        ctk.CTkButton(
            btn_bar,
            text="📂 Carica nell'Area di Lavoro Attiva",
            fg_color="#0F172A",
            hover_color="#1E293B",
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=12, weight="bold"),
            height=30,
            corner_radius=6,
            command=lambda r=rec: self._load_record_into_workspace(r),
        ).pack(side="left", padx=3)

        ctk.CTkButton(
            btn_bar,
            text=f"🖼️ Esporta JPEG ({int(rec.get('month', 1)):02d}/{rec.get('year', 2026)})",
            fg_color="#FEF08A",
            hover_color="#FDE047",
            text_color="#0F172A",
            border_width=1,
            border_color="#F59E0B",
            font=ctk.CTkFont(size=12, weight="bold"),
            height=30,
            corner_radius=6,
            command=lambda r=rec: self._export_record_jpeg(r),
        ).pack(side="left", padx=3)

        ctk.CTkButton(
            btn_bar,
            text="📊 Esporta Excel (.xlsx)",
            fg_color="#047857",
            hover_color="#065F46",
            text_color="#FFFFFF",
            font=ctk.CTkFont(size=12, weight="bold"),
            height=30,
            corner_radius=6,
            command=lambda r=rec: self._export_record_excel(r),
        ).pack(side="left", padx=3)

        ctk.CTkButton(
            btn_bar,
            text="✖ Chiudi Anteprima",
            fg_color="#F1F5F9",
            hover_color="#E2E8F0",
            text_color="#475569",
            font=ctk.CTkFont(size=12, weight="bold"),
            width=125,
            height=30,
            corner_radius=6,
            command=lambda: self._toggle_history_preview(rec.get("id", "")),
        ).pack(side="left", padx=(3, 0))

        # Tabella Grafica Colorata (SchedulePaperTable: Giallo per Bar, Rosso per Mattina, Nero Grassetto per Pomeriggio, Bordo Verde Domenica)
        canvas_wrap = ctk.CTkFrame(
            self.hist_preview_panel,
            fg_color="#FFFFFF",
            border_width=1,
            border_color="#CBD5E1",
            corner_radius=6,
        )
        canvas_wrap.pack(fill="both", expand=True, padx=16, pady=(2, 14))

        cfg_snap = rec.get("configSnapshot", self.config_data)
        sol_snap = rec.get("solutionSnapshot", {})
        cal_days = cfg_snap.get("calendar", [])
        assignments = sol_snap.get("assignments", {})
        w_stats = rec.get("workerStats") or sol_snap.get("workerStats", {})

        active_workers = [w for w in self.config_data.get("workers", []) if w.get("active", True)]
        active_workers.sort(key=lambda w: (0 if w["type"] == "Fisso" else 1, w.get("priority", 0)))

        col_date_w = 68
        col_day_w = 52
        col_shift_w = 66
        col_hrs_w = 38
        pair_w = col_shift_w + col_hrs_w
        row_h = 24
        hdr_h = 46

        summary_rows = [
            ("TOTALE ORE MESE", lambda wid, st, c_b, c_m, c_p, c_s, t_h, d_w: f"{st.get('totalHours', t_h)}h"),
            ("GIORNI LAVORATI", lambda wid, st, c_b, c_m, c_p, c_s, t_h, d_w: str(st.get("workedDays", d_w))),
            ("TURNI BAR (6-12/13)", lambda wid, st, c_b, c_m, c_p, c_s, t_h, d_w: str(st.get("barCount", c_b))),
            ("TURNI MATTINA (7-13/14)", lambda wid, st, c_b, c_m, c_p, c_s, t_h, d_w: str(st.get("morningCount", c_m))),
            ("TURNI POMERIGGIO", lambda wid, st, c_b, c_m, c_p, c_s, t_h, d_w: str(st.get("afternoonCount", c_p))),
            ("DOMENICHE LAVORATE", lambda wid, st, c_b, c_m, c_p, c_s, t_h, d_w: str(st.get("sundaysWorked", c_s))),
        ]

        total_w = col_date_w + col_day_w + len(active_workers) * pair_w + 4
        total_h = hdr_h + (len(cal_days) + len(summary_rows)) * row_h + 6

        c_frame = tk.Frame(canvas_wrap, bg="#FFFFFF")
        c_frame.pack(fill="both", expand=True, padx=2, pady=2)

        hbar = ttk.Scrollbar(c_frame, orient="horizontal")
        hbar.pack(side="bottom", fill="x")
        vbar = ttk.Scrollbar(c_frame, orient="vertical")
        vbar.pack(side="right", fill="y")

        cv = tk.Canvas(
            c_frame,
            bg="#FFFFFF",
            height=min(440, total_h),
            scrollregion=(0, 0, total_w, total_h),
            highlightthickness=0,
            xscrollcommand=hbar.set,
            yscrollcommand=vbar.set,
        )
        cv.pack(side="left", fill="both", expand=True)
        hbar.config(command=cv.xview)
        vbar.config(command=cv.yview)

        # Intestazione Tabella
        cv.create_rectangle(0, 0, col_date_w, hdr_h, fill="#E2E8F0", outline="#64748B")
        cv.create_text(col_date_w // 2, hdr_h // 2, text="Data", font=("Segoe UI", 9, "bold"), fill="#0F172A")
        cv.create_rectangle(col_date_w, 0, col_date_w + col_day_w, hdr_h, fill="#E2E8F0", outline="#64748B")
        cv.create_text(col_date_w + col_day_w // 2, hdr_h // 2, text="Giorno", font=("Segoe UI", 9, "bold"), fill="#0F172A")

        for idx_w, w in enumerate(active_workers):
            wx = col_date_w + col_day_w + idx_w * pair_w
            hdr_bg = "#FEF9C3" if w.get("type") == "Sostituta" else "#E2E8F0"
            cv.create_rectangle(wx, 0, wx + pair_w, 25, fill=hdr_bg, outline="#64748B")
            cv.create_text(
                wx + pair_w // 2,
                12,
                text=f"#{w['id']} {w['name'][:11]}",
                font=("Segoe UI", 9, "bold"),
                fill="#0F172A",
            )
            cv.create_rectangle(wx, 25, wx + col_shift_w, hdr_h, fill="#F8FAFC", outline="#64748B")
            cv.create_text(wx + col_shift_w // 2, 35, text="Turno", font=("Segoe UI", 8, "bold"), fill="#475569")
            cv.create_rectangle(wx + col_shift_w, 25, wx + pair_w, hdr_h, fill="#F8FAFC", outline="#64748B")
            cv.create_text(wx + col_shift_w + col_hrs_w // 2, 35, text="Ore", font=("Segoe UI", 8, "bold"), fill="#475569")

        # Righe Giorni del Mese
        for r_idx, d_req in enumerate(cal_days):
            ry = hdr_h + r_idx * row_h
            d_key = d_req.get("day", r_idx + 1)
            is_sun = d_req.get("dayOfWeek") == 0
            is_hol = bool(d_req.get("isHoliday", False))
            date_bg = "#F0FDF4" if is_sun else ("#FEF2F2" if is_hol else "#FFFFFF")
            date_fg = "#14532D" if is_sun else ("#B91C1C" if is_hol else "#0F172A")
            d_font = ("Segoe UI", 9, "bold" if (is_sun or is_hol) else "normal")

            cv.create_rectangle(0, ry, col_date_w, ry + row_h, fill=date_bg, outline="#CBD5E1")
            cv.create_text(col_date_w // 2, ry + row_h // 2, text=str(d_req.get("dateStr", "")), font=d_font, fill=date_fg)

            cv.create_rectangle(col_date_w, ry, col_date_w + col_day_w, ry + row_h, fill=date_bg, outline="#CBD5E1")
            cv.create_text(col_date_w + col_day_w // 2, ry + row_h // 2, text=str(d_req.get("dayAbbr", "")), font=d_font, fill=date_fg)

            day_cells = assignments.get(str(d_key)) or assignments.get(d_key) or {}
            for idx_w, w in enumerate(active_workers):
                wx = col_date_w + col_day_w + idx_w * pair_w
                cell = day_cells.get(w["id"], {"shiftType": "OFF", "label": "", "hours": 0})
                s_type = cell.get("shiftType", "OFF")
                lbl = str(cell.get("label", "")) if s_type != "OFF" else ""
                hrs = str(cell.get("hours", "")) if s_type != "OFF" and cell.get("hours") else ""

                c_bg = "#FFFF00" if s_type == "BAR" else "#FFFFFF"
                c_fg = "#DC2626" if s_type == "MORNING" else "#000000"
                c_font = ("Segoe UI", 9, "bold") if s_type in ("BAR", "AFTERNOON") else ("Segoe UI", 9, "normal")

                cv.create_rectangle(wx, ry, wx + col_shift_w, ry + row_h, fill=c_bg, outline="#CBD5E1")
                if lbl:
                    cv.create_text(wx + col_shift_w // 2, ry + row_h // 2, text=lbl, font=c_font, fill=c_fg)

                cv.create_rectangle(wx + col_shift_w, ry, wx + pair_w, ry + row_h, fill="#FFFFFF", outline="#CBD5E1")
                if hrs:
                    cv.create_text(
                        wx + col_shift_w + col_hrs_w // 2,
                        ry + row_h // 2,
                        text=hrs,
                        font=("Segoe UI", 9),
                        fill="#334155",
                    )

            if is_sun:
                cv.create_line(0, ry + row_h, total_w, ry + row_h, fill="#15803D", width=2)

        # Righe Riepilogo Finale in Fondo alla Tabella
        base_sum_y = hdr_h + len(cal_days) * row_h
        for s_idx, (s_title, val_fn) in enumerate(summary_rows):
            sy = base_sum_y + s_idx * row_h
            row_bg = "#E2E8F0" if s_idx == 0 else "#F8FAFC"
            cv.create_rectangle(0, sy, col_date_w + col_day_w, sy + row_h, fill=row_bg, outline="#94A3B8")
            cv.create_text(
                (col_date_w + col_day_w) // 2,
                sy + row_h // 2,
                text=s_title,
                font=("Segoe UI", 8, "bold"),
                fill="#0F172A",
            )
            for idx_w, w in enumerate(active_workers):
                wx = col_date_w + col_day_w + idx_w * pair_w
                wid = w["id"]
                st_w = w_stats.get(wid, {})
                c_b = c_m = c_p = c_s = t_h = d_w = 0
                for d_req in cal_days:
                    dk = d_req.get("day")
                    dc = (assignments.get(str(dk)) or assignments.get(dk) or {}).get(wid, {})
                    st_t = dc.get("shiftType", "OFF")
                    if st_t != "OFF":
                        d_w += 1
                        t_h += int(dc.get("hours", 0))
                        if st_t == "BAR":
                            c_b += 1
                        elif st_t == "MORNING":
                            c_m += 1
                        elif st_t == "AFTERNOON":
                            c_p += 1
                        if d_req.get("dayOfWeek") == 0:
                            c_s += 1
                txt_val = val_fn(wid, st_w, c_b, c_m, c_p, c_s, t_h, d_w)
                cv.create_rectangle(wx, sy, wx + pair_w, sy + row_h, fill=row_bg, outline="#94A3B8")
                cv.create_text(
                    wx + pair_w // 2,
                    sy + row_h // 2,
                    text=txt_val,
                    font=("Segoe UI", 9, "bold" if s_idx == 0 else "normal"),
                    fill="#0F172A",
                )

    def _refresh_history_tree(self):
        if not hasattr(self, "hist_cards_container"):
            return
        self.history_records = ConfigManager.load_history()
        self.config_data["history"] = self.history_records

        if hasattr(self, "lbl_hist_count_badge"):
            self.lbl_hist_count_badge.configure(
                text=f"  ({len(self.history_records)} periodi salvati · Ordine dal più recente)"
            )
        if hasattr(self, "lbl_hist_active_summary"):
            m = int(self.config_data.get("month", 11))
            y = int(self.config_data.get("year", 2026))
            cal = self.config_data.get("calendar", [])
            d_title = f"{ITALIAN_MONTHS_FULL.get(m, 'Novembre')} {y}"
            d_rng = f"{cal[0]['dateStr']} – {cal[-1]['dateStr']}" if cal else f"{m:02d}/{y}"
            self.lbl_hist_active_summary.configure(text=f"{d_title} ({d_rng}) · {len(cal)} giorni")

        # Gestione pannello anteprima
        preview_rec = next(
            (r for r in self.history_records if r.get("id") == self.preview_history_id),
            None,
        )
        if preview_rec:
            self.hist_preview_panel.pack(
                fill="x", padx=12, pady=(2, 10), before=self.hist_cards_container.master
            )
            self._render_history_preview_panel(preview_rec)
        else:
            self.hist_preview_panel.pack_forget()

        for child in self.hist_cards_container.winfo_children():
            child.destroy()

        if not self.history_records:
            ctk.CTkLabel(
                self.hist_cards_container,
                text="Nessun orario salvato nello storico. Usa il pulsante in alto per archiviare il primo mese o importare un file Excel (.xlsx).",
                font=ctk.CTkFont(size=13),
                text_color="#64748B",
            ).pack(pady=28)
            return

        fisse_workers = [
            w
            for w in self.config_data.get("workers", [])
            if w.get("active", True) and w.get("type") == "Fisso"
        ]
        fisse_workers.sort(key=lambda w: w.get("priority", 0))

        for idx, rec in enumerate(self.history_records):
            rec_id = rec.get("id", "")
            is_selected = self.preview_history_id == rec_id
            card = ctk.CTkFrame(
                self.hist_cards_container,
                fg_color="#F8FAFC" if is_selected else "#FFFFFF",
                border_width=2 if is_selected else 1,
                border_color="#0F172A" if is_selected else "#E2E8F0",
                corner_radius=8,
            )
            card.pack(fill="x", pady=5)

            top_row = ctk.CTkFrame(card, fg_color="transparent")
            top_row.pack(fill="x", padx=14, pady=(12, 6))

            # Sinistra: #01 + Titolo + Badge Più Recente + Metadati
            meta_left = ctk.CTkFrame(top_row, fg_color="transparent")
            meta_left.pack(side="left", fill="x", expand=True)

            t_line = ctk.CTkFrame(meta_left, fg_color="transparent")
            t_line.pack(anchor="w")

            ctk.CTkLabel(
                t_line,
                text=f"#{idx + 1:02d}",
                font=ctk.CTkFont(family="Consolas", size=12, weight="bold"),
                text_color="#64748B",
            ).pack(side="left", padx=(0, 8))

            ctk.CTkLabel(
                t_line,
                text=f"📅  {rec.get('periodLabel', '')}",
                font=ctk.CTkFont(size=15, weight="bold"),
                text_color="#0F172A",
            ).pack(side="left")

            if idx == 0:
                ctk.CTkLabel(
                    t_line,
                    text="  · Più Recente",
                    font=ctk.CTkFont(size=12, weight="bold"),
                    text_color="#047857",
                ).pack(side="left", padx=(6, 0))

            m_num = int(rec.get("month", 1))
            y_num = int(rec.get("year", 2026))
            n_days = int(rec.get("numDays") or len(rec.get("configSnapshot", {}).get("calendar", [])) or 30)
            saved_str = str(rec.get("savedAt", ""))[:10]
            ctk.CTkLabel(
                meta_left,
                text=f"Mese/Anno: {m_num:02d}/{y_num}   ·   Durata: {n_days} giorni   ·   Archiviato il: {saved_str}",
                font=ctk.CTkFont(family="Consolas", size=11),
                text_color="#64748B",
            ).pack(anchor="w", pady=(2, 0))

            # Destra: Pulsanti Azione sulla singola Card (identici all'anteprima web)
            actions_right = ctk.CTkFrame(top_row, fg_color="transparent")
            actions_right.pack(side="right")

            ctk.CTkButton(
                actions_right,
                text="👁️ Nascondi Griglia" if is_selected else "👁️ Anteprima Griglia Turni",
                fg_color="#0F172A" if is_selected else "#FFFFFF",
                hover_color="#1E293B" if is_selected else "#F1F5F9",
                text_color="#FFFFFF" if is_selected else "#1E293B",
                border_width=1,
                border_color="#0F172A" if is_selected else "#CBD5E1",
                font=ctk.CTkFont(size=12, weight="bold"),
                height=30,
                corner_radius=6,
                command=lambda rid=rec_id: self._toggle_history_preview(rid),
            ).pack(side="left", padx=3)

            ctk.CTkButton(
                actions_right,
                text="📂 Carica nell'Area Attiva",
                fg_color="#F1F5F9",
                hover_color="#E2E8F0",
                text_color="#1E293B",
                border_width=1,
                border_color="#CBD5E1",
                font=ctk.CTkFont(size=12, weight="bold"),
                height=30,
                corner_radius=6,
                command=lambda r=rec: self._load_record_into_workspace(r),
            ).pack(side="left", padx=3)

            ctk.CTkButton(
                actions_right,
                text="🖼️ JPEG",
                fg_color="#FEF08A",
                hover_color="#FDE047",
                text_color="#0F172A",
                border_width=1,
                border_color="#F59E0B",
                font=ctk.CTkFont(size=12, weight="bold"),
                width=78,
                height=30,
                corner_radius=6,
                command=lambda r=rec: self._export_record_jpeg(r),
            ).pack(side="left", padx=3)

            ctk.CTkButton(
                actions_right,
                text="📊 Excel (.xlsx)",
                fg_color="#047857",
                hover_color="#065F46",
                text_color="#FFFFFF",
                font=ctk.CTkFont(size=12, weight="bold"),
                width=112,
                height=30,
                corner_radius=6,
                command=lambda r=rec: self._export_record_excel(r),
            ).pack(side="left", padx=3)

            ctk.CTkButton(
                actions_right,
                text="🗑️",
                fg_color="#FEF2F2",
                hover_color="#FEE2E2",
                text_color="#DC2626",
                border_width=1,
                border_color="#FECACA",
                font=ctk.CTkFont(size=12, weight="bold"),
                width=34,
                height=30,
                corner_radius=6,
                command=lambda r=rec: self._delete_record_direct(r),
            ).pack(side="left", padx=(3, 0))

            # Striscia Riepilogo 8 Lavoratrici Fisse in fondo alla Card (ID numerico immutabile + Ore)
            ctk.CTkFrame(card, fg_color="#F1F5F9", height=1).pack(fill="x", padx=14, pady=(4, 6))

            strip_frame = ctk.CTkFrame(card, fg_color="transparent")
            strip_frame.pack(fill="x", padx=14, pady=(0, 10))

            w_stats = rec.get("workerStats") or rec.get("solutionSnapshot", {}).get("workerStats", {})
            for col_i, w in enumerate(fisse_workers):
                strip_frame.grid_columnconfigure(col_i, weight=1, uniform="wstrip")
                st_w = w_stats.get(w["id"], {})
                tot_h = int(st_w.get("totalHours", 0)) if isinstance(st_w, dict) else 0

                badge = ctk.CTkFrame(
                    strip_frame,
                    fg_color="#F8FAFC",
                    border_width=1,
                    border_color="#E2E8F0",
                    corner_radius=6,
                )
                badge.grid(row=0, column=col_i, padx=3, pady=2, sticky="ew")

                ctk.CTkLabel(
                    badge,
                    text=f"#{w['id']} {w['name'][:10]}",
                    font=ctk.CTkFont(size=11, weight="bold"),
                    text_color="#1E293B",
                ).pack(side="left", padx=(8, 4), pady=5)

                ctk.CTkLabel(
                    badge,
                    text=f"{tot_h}h",
                    font=ctk.CTkFont(family="Consolas", size=11, weight="bold"),
                    text_color="#0F172A",
                ).pack(side="right", padx=(4, 8), pady=5)

    def _load_record_into_workspace(self, rec: Dict[str, Any]):
        if not rec:
            return
        cfg_snap = json.loads(json.dumps(rec.get("configSnapshot", self.config_data)))
        cfg_snap["workers"] = self.config_data.get("workers", cfg_snap.get("workers", []))
        cfg_snap["history"] = self.history_records
        self.config_data = cfg_snap
        self.current_solution = json.loads(json.dumps(rec.get("solutionSnapshot", {})))
        self._auto_save()
        self._refresh_staff_tree()
        self._refresh_calendar_tree()
        self._refresh_absences_tree()
        self._refresh_exceptions_tree()
        self._refresh_costs_tab()
        self._refresh_history_tree()
        self._show_history_toast(f"Orario '{rec.get('periodLabel', '')}' caricato nell'area di lavoro attiva!")
        self.tabview.set("6. Generazione & Export")

    def _export_record_excel(self, rec: Dict[str, Any]):
        if not rec:
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".xlsx",
            filetypes=[("File Excel", "*.xlsx")],
            initialfile=f"Storico_{rec.get('periodLabel', 'Turni').replace(' ', '_').replace('/', '-')}.xlsx",
        )
        if path:
            cfg_snap = json.loads(json.dumps(rec.get("configSnapshot", self.config_data)))
            cfg_snap["workers"] = self.config_data.get("workers", cfg_snap.get("workers", []))
            export_to_excel(cfg_snap, rec.get("solutionSnapshot", {}), path)
            self._show_history_toast(f"File Excel esportato: {os.path.basename(path)}")

    def _export_record_jpeg(self, rec: Dict[str, Any]):
        if not rec:
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".jpeg",
            filetypes=[("Immagine JPEG 300 DPI", "*.jpeg")],
            initialfile=f"Storico_{rec.get('periodLabel', 'Turni').replace(' ', '_').replace('/', '-')}_300DPI.jpeg",
        )
        if path:
            cfg_snap = json.loads(json.dumps(rec.get("configSnapshot", self.config_data)))
            cfg_snap["workers"] = self.config_data.get("workers", cfg_snap.get("workers", []))
            export_to_jpeg(cfg_snap, rec.get("solutionSnapshot", {}), path)
            self._show_history_toast(f"Immagine JPEG esportata: {os.path.basename(path)}")

    def _delete_record_direct(self, rec: Dict[str, Any]):
        if not rec:
            return
        rec_id = rec.get("id", "")
        self.history_records = ConfigManager.delete_history_record(rec_id)
        if self.preview_history_id == rec_id:
            self.preview_history_id = None
        self._refresh_history_tree()
        self._show_history_toast(f"Record '{rec.get('periodLabel', '')}' rimosso dallo storico.")

    # -------------------------------------------------------------------------
    # SCHEDA 8: ANALISI ECONOMICA & STIMA COSTO PERSONALE PER MESE E MANSIONE
    # -------------------------------------------------------------------------
    def _build_tab_costs(self):
        kpi_bar = ctk.CTkFrame(self.tab_costs)
        kpi_bar.pack(fill="x", padx=10, pady=8)

        self.lbl_cost_total = ctk.CTkLabel(
            kpi_bar, text="Costo Totale Mese: € 0.00", font=ctk.CTkFont(size=15, weight="bold"), text_color="#0F172A"
        )
        self.lbl_cost_total.pack(side="left", padx=14, pady=8)

        self.lbl_cost_bar = ctk.CTkLabel(
            kpi_bar, text="Quota BAR: € 0.00", font=ctk.CTkFont(size=13, weight="bold"), text_color="#B45309"
        )
        self.lbl_cost_bar.pack(side="left", padx=12, pady=8)

        self.lbl_cost_morn = ctk.CTkLabel(
            kpi_bar, text="Quota MATTINA: € 0.00", font=ctk.CTkFont(size=13, weight="bold"), text_color="#DC2626"
        )
        self.lbl_cost_morn.pack(side="left", padx=12, pady=8)

        self.lbl_cost_aft = ctk.CTkLabel(
            kpi_bar, text="Quota POMERIGGIO: € 0.00", font=ctk.CTkFont(size=13, weight="bold"), text_color="#1E293B"
        )
        self.lbl_cost_aft.pack(side="left", padx=12, pady=8)

        self.lbl_cost_split = ctk.CTkLabel(
            kpi_bar, text="Fisse: € 0.00 | Sostitute: € 0.00", font=ctk.CTkFont(size=12, weight="bold"), text_color="#059669"
        )
        self.lbl_cost_split.pack(side="left", padx=12, pady=8)

        ctk.CTkButton(
            kpi_bar,
            text="❓ Guida Scheda",
            fg_color="#334155",
            hover_color="#1E293B",
            width=135,
            command=lambda: self._open_tab_guide_modal("COSTS"),
        ).pack(side="right", padx=6, pady=8)

        ctk.CTkButton(
            kpi_bar,
            text="Esporta Riepilogo Economico (.xlsx)",
            fg_color="#0F172A",
            width=220,
            command=self.export_excel_action,
        ).pack(side="right", padx=10, pady=8)

        cols = ("id", "name", "role", "bar_h", "morn_h", "aft_h", "tot_h", "rate", "tot_cost")
        self.tree_costs = ttk.Treeview(self.tab_costs, columns=cols, show="headings", height=16)
        for cid, txt, w_col in [
            ("id", "ID", 70),
            ("name", "Dipendente", 190),
            ("role", "Ruolo / Contratto", 130),
            ("bar_h", "Ore Bar", 100),
            ("morn_h", "Ore Mattina", 110),
            ("aft_h", "Ore Pomeriggio", 120),
            ("tot_h", "Ore Totali", 110),
            ("rate", "Tariffa Oraria (€/h)", 140),
            ("tot_cost", "Costo Totale Stimato (€)", 170),
        ]:
            self.tree_costs.heading(cid, text=txt)
            self.tree_costs.column(cid, width=w_col, anchor="center")
        self.tree_costs.pack(fill="both", expand=True, padx=10, pady=8)

    def _refresh_costs_tab(self):
        if not hasattr(self, "tree_costs"):
            return
        for i in self.tree_costs.get_children():
            self.tree_costs.delete(i)
        if not self.current_solution or not self.current_solution.get("assignments"):
            return

        assignments = self.current_solution.get("assignments", {})
        workers = [w for w in self.config_data["workers"] if w.get("active", True)]
        workers.sort(key=lambda w: (0 if w["type"] == "Fisso" else 1, w.get("priority", 0)))

        grand_hours = 0
        grand_cost = 0.0
        cost_bar = 0.0
        cost_morn = 0.0
        cost_aft = 0.0
        cost_fisse = 0.0
        cost_sost = 0.0

        for w in workers:
            wid = w["id"]
            rate = float(w.get("hourlyRate", 12.5 if w["type"] == "Fisso" else 13.5))
            bh, mh, ah = 0, 0, 0
            for d_req in self.config_data["calendar"]:
                d = d_req["day"]
                day_map = assignments.get(d) or assignments.get(str(d)) or {}
                cell = day_map.get(wid, {"shiftType": "OFF", "hours": 0})
                st = cell.get("shiftType", "OFF")
                hrs = int(cell.get("hours", 0))
                if st == "BAR":
                    bh += hrs
                elif st == "MORNING":
                    mh += hrs
                elif st == "AFTERNOON":
                    ah += hrs

            tot_h = bh + mh + ah
            w_cost = tot_h * rate
            grand_hours += tot_h
            grand_cost += w_cost
            cost_bar += bh * rate
            cost_morn += mh * rate
            cost_aft += ah * rate
            if w["type"] == "Fisso":
                cost_fisse += w_cost
            else:
                cost_sost += w_cost

            self.tree_costs.insert(
                "",
                "end",
                values=(
                    f"#{wid}",
                    w["name"],
                    w["type"],
                    f"{bh}h",
                    f"{mh}h",
                    f"{ah}h",
                    f"{tot_h}h",
                    f"€ {rate:.2f}/h",
                    f"€ {w_cost:,.2f}",
                ),
            )

        self.tree_costs.insert(
            "",
            "end",
            values=(
                "TOT",
                "TOTALE GENERALE DEL MESE",
                "-",
                "-",
                "-",
                "-",
                f"{grand_hours}h",
                "-",
                f"€ {grand_cost:,.2f}",
            ),
        )

        self.lbl_cost_total.configure(text=f"Costo Totale Mese: € {grand_cost:,.2f}")
        self.lbl_cost_bar.configure(text=f"Quota BAR: € {cost_bar:,.2f}")
        self.lbl_cost_morn.configure(text=f"Quota MATTINA: € {cost_morn:,.2f}")
        self.lbl_cost_aft.configure(text=f"Quota POMERIGGIO: € {cost_aft:,.2f}")
        self.lbl_cost_split.configure(
            text=f"Fisse: € {cost_fisse:,.2f} | Sostitute: € {cost_sost:,.2f}"
        )

    def export_excel_action(self):
        if not self.current_solution or not self.current_solution.get("assignments"):
            self.run_optimizer(silent=True)
        path = filedialog.asksaveasfilename(
            defaultextension=".xlsx",
            filetypes=[("File Excel", "*.xlsx")],
            initialfile=f"Turni_{self.config_data['month']:02d}_{self.config_data['year']}.xlsx",
        )
        if path:
            export_to_excel(self.config_data, self.current_solution, path)
            messagebox.showinfo(
                "Esportazione Completata",
                f"File Excel (con Totale Ore Mensili =SOMMA(...) e foglio Analisi_Costi_Personale) salvato in:\\n{path}",
            )

    def export_image_action(self):
        if not self.current_solution or not self.current_solution.get("assignments"):
            self.run_optimizer(silent=True)
        path = filedialog.asksaveasfilename(
            defaultextension=".jpeg",
            filetypes=[("Immagine JPEG 300 DPI", "*.jpeg")],
            initialfile=f"Turni_{self.config_data['month']:02d}_{self.config_data['year']}_300DPI.jpeg",
        )
        if path:
            export_to_jpeg(self.config_data, self.current_solution, path)
            messagebox.showinfo("Immagine 300 DPI Creata", f"Immagine ad alta definizione salvata in:\\n{path}")

    def save_profile_dialog(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Profilo JSON", "*.json")],
            initialfile="profilo_turni.json",
        )
        if path:
            ConfigManager.save_config(self.config_data, path)
            messagebox.showinfo("Profilo Salvato", f"Configurazione salvata in:\\n{path}")

    def load_profile_dialog(self):
        path = filedialog.askopenfilename(filetypes=[("Profilo JSON", "*.json")])
        if path:
            self.config_data = ConfigManager.load_config(path)
            self._auto_save()
            self._refresh_staff_tree()
            self._refresh_calendar_tree()
            self._refresh_absences_tree()
            self._refresh_exceptions_tree()
            self.run_optimizer(silent=True)
            messagebox.showinfo("Profilo Caricato", "Configurazione importata e salvata in memoria permanente.")


def _find_web_ui_dir() -> str:
    candidates = []
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        candidates.append(os.path.join(exe_dir, "web_ui"))
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(os.path.join(meipass, "web_ui"))
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(script_dir, "web_ui"))
    for c in candidates:
        if os.path.isfile(os.path.join(c, "index.html")):
            return c
    return ""


def _find_windows_app_browser() -> str:
    prog_x86 = os.environ.get("PROGRAMFILES(X86)", r"C:\\Program Files (x86)")
    prog_64 = os.environ.get("PROGRAMFILES", r"C:\\Program Files")
    local_app = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(prog_x86, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(prog_64, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(local_app, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(prog_64, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(prog_x86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(local_app, "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return ""


def launch_identical_web_desktop_app() -> bool:
    """
    Avvia l'interfaccia grafica IDENTICA AL 100% all'anteprima Web (React + Tailwind CSS)
    in una finestra Desktop nativa di Windows, sincronizzando automaticamente ogni modifica
    con %APPDATA%/TurniDonnePulizieRT/config.json e history.json.
    """
    web_ui_dir = _find_web_ui_dir()
    if not web_ui_dir or "--classic-tkinter" in sys.argv:
        return False

    # Assicura che config.json e history.json in %APPDATA% siano inizializzati
    initial_cfg = ConfigManager.load_config("profilo_turni.json")
    initial_hist = ConfigManager.load_history()
    if initial_hist:
        initial_cfg["history"] = initial_hist
        ConfigManager.save_config(initial_cfg)

    class DesktopUISyncHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=web_ui_dir, **kwargs)

        def log_message(self, format, *args):
            pass  # Silenzia log console in modalità finestra desktop

        def do_GET(self):
            if self.path.startswith("/desktop_sync.js"):
                cfg = ConfigManager.load_config("profilo_turni.json")
                hist = ConfigManager.load_history()
                if hist and not cfg.get("history"):
                    cfg["history"] = hist
                cfg_json = json.dumps(cfg, ensure_ascii=False)
                js_code = (
                    "(function(){\\n"
                    "  try {\\n"
                    f"    var serverCfg = {cfg_json};\\n"
                    "    if (serverCfg && typeof serverCfg === 'object') {\\n"
                    "      window.localStorage.setItem('turni_donne_pulizie_rt_v4_config', JSON.stringify(serverCfg));\\n"
                    "    }\\n"
                    "    var origSetItem = Storage.prototype.setItem;\\n"
                    "    Storage.prototype.setItem = function(k, v) {\\n"
                    "      origSetItem.apply(this, arguments);\\n"
                    "      if (k === 'turni_donne_pulizie_rt_v4_config') {\\n"
                    "        fetch('/api/desktop-config', {\\n"
                    "          method: 'POST',\\n"
                    "          headers: { 'Content-Type': 'application/json' },\\n"
                    "          body: v,\\n"
                    "          keepalive: true\\n"
                    "        }).catch(function(){});\\n"
                    "      }\\n"
                    "    };\\n"
                    "    window.addEventListener('beforeunload', function() {\\n"
                    "      try {\\n"
                    "        var latest = window.localStorage.getItem('turni_donne_pulizie_rt_v4_config');\\n"
                    "        if (latest && navigator.sendBeacon) {\\n"
                    "          navigator.sendBeacon('/api/desktop-config', new Blob([latest], { type: 'application/json' }));\\n"
                    "        }\\n"
                    "      } catch (e) {}\\n"
                    "    });\\n"
                    "  } catch (err) { console.error(err); }\\n"
                    "})();\\n"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
                self.send_header("Content-Length", str(len(js_code)))
                self.end_headers()
                self.wfile.write(js_code)
                return

            if self.path.startswith("/api/desktop-config"):
                cfg = ConfigManager.load_config("profilo_turni.json")
                payload = json.dumps(cfg, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            return super().do_GET()

        def do_POST(self):
            if self.path.startswith("/api/desktop-config"):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    raw_body = self.rfile.read(length).decode("utf-8")
                    new_cfg = json.loads(raw_body)
                    if isinstance(new_cfg, dict):
                        ConfigManager.save_config(new_cfg)
                        if isinstance(new_cfg.get("history"), list):
                            with open(ConfigManager.get_history_path(), "w", encoding="utf-8") as hf:
                                json.dump(new_cfg["history"], hf, indent=2, ensure_ascii=False)
                    resp = b'{"ok":true}'
                    self.send_response(200)
                except Exception:
                    resp = b'{"ok":false}'
                    self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)
                return
            self.send_response(404)
            self.end_headers()

    server = None
    bound_port = 18492
    for candidate_port in range(18492, 18515):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate_port), DesktopUISyncHandler)
            bound_port = candidate_port
            break
        except OSError:
            continue

    if server is None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), DesktopUISyncHandler)
        bound_port = server.server_address[1]

    srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
    srv_thread.start()
    app_url = f"http://127.0.0.1:{bound_port}/"

    # Priorità 1: pywebview (se installato)
    try:
        import webview  # type: ignore
        webview.create_window(
            "Turni di Lavoro RT — Airport Motel Malpensa",
            app_url,
            width=1520,
            height=940,
            min_size=(1100, 700),
        )
        webview.start()
        server.shutdown()
        return True
    except Exception:
        pass

    # Priorità 2: Finestra App Desktop nativa Windows tramite Microsoft Edge WebView/App o Chrome App
    browser_exe = _find_windows_app_browser()
    if browser_exe:
        profile_dir = os.path.join(ConfigManager.get_appdata_dir(), "DesktopWindowProfile")
        os.makedirs(profile_dir, exist_ok=True)
        try:
            proc = subprocess.Popen(
                [
                    browser_exe,
                    f"--app={app_url}",
                    "--window-size=1520,940",
                    f"--user-data-dir={profile_dir}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-extensions",
                ]
            )
            proc.wait()
            time.sleep(0.5)
            server.shutdown()
            return True
        except Exception:
            pass

    # Priorità 3: Browser predefinito di sistema
    try:
        webbrowser.open(app_url)
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        server.shutdown()
        return True


if __name__ == "__main__":
    if not launch_identical_web_desktop_app():
        app = TurniDonnePulizieApp()
        app.mainloop()
`;

  const requirementsTxt = `ortools>=9.10.4067
customtkinter>=5.2.2
openpyxl>=3.1.5
Pillow>=10.4.0
pyinstaller>=6.10.0
`;

  const buildExeBat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================================
echo  Turni di Lavoro RT - Creazione Automatica Programma Windows (.exe)
echo ============================================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERRORE] Python non trovato sul sistema!
    echo Scarica e installa Python 3.11 o 3.12 da https://www.python.org/downloads/
    echo IMPORTANTE: Durante l'installazione di Python spunta la casella "Add Python to PATH".
    pause
    exit /b 1
)

echo [1/3] Aggiornamento pip e installazione librerie necessarie...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

if exist "app_icon.png" (
    python -c "from PIL import Image; img = Image.open('app_icon.png'); img.save('app_icon.ico', format='ICO', sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)])"
)

echo.
echo [2/3] Compilazione in unico eseguibile stand-alone TurniDonnePulizieRT.exe...
if exist "app_icon.ico" (
    if exist "web_ui\\index.html" (
        python -m PyInstaller --noconfirm --clean --onefile --windowed ^
          --name "TurniDonnePulizieRT" ^
          --icon "app_icon.ico" ^
          --add-data "app_icon.ico;." ^
          --add-data "app_icon.png;." ^
          --add-data "web_ui;web_ui" ^
          --collect-all customtkinter ^
          --collect-all ortools ^
          app_gui.py
    ) else (
        python -m PyInstaller --noconfirm --clean --onefile --windowed ^
          --name "TurniDonnePulizieRT" ^
          --icon "app_icon.ico" ^
          --add-data "app_icon.ico;." ^
          --add-data "app_icon.png;." ^
          --collect-all customtkinter ^
          --collect-all ortools ^
          app_gui.py
    )
) else (
    if exist "web_ui\\index.html" (
        python -m PyInstaller --noconfirm --clean --onefile --windowed ^
          --name "TurniDonnePulizieRT" ^
          --add-data "web_ui;web_ui" ^
          --collect-all customtkinter ^
          --collect-all ortools ^
          app_gui.py
    ) else (
        python -m PyInstaller --noconfirm --clean --onefile --windowed ^
          --name "TurniDonnePulizieRT" ^
          --collect-all customtkinter ^
          --collect-all ortools ^
          app_gui.py
    )
)

if not exist "dist\\TurniDonnePulizieRT.exe" (
    echo [INFO] Riprovo compilazione veloce standard PyInstaller...
    python -m PyInstaller --noconfirm --onefile --windowed --name "TurniDonnePulizieRT" app_gui.py
)

if not exist "dist" mkdir "dist"
if exist "profilo_turni.json" (
    copy /Y "profilo_turni.json" "dist\\profilo_turni.json" >nul
)
if exist "web_ui\\index.html" (
    xcopy /E /I /Y "web_ui" "dist\\web_ui" >nul
)

echo.
echo ============================================================================
if exist "dist\\TurniDonnePulizieRT.exe" (
    echo  [3/3] COMPILAZIONE COMPLETATA CON SUCCESSO!
    echo  Il programma pronto all'uso si trova in: dist\\TurniDonnePulizieRT.exe
) else (
    echo  [3/3] Preparazione file completata. Lancia INSTALLA_SU_WINDOWS.bat per installare.
)
echo ============================================================================
`;

  const installOnWindowsBat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================================
echo  INSTALLAZIONE / AGGIORNAMENTO "Turni di Lavoro RT" SU WINDOWS 10 / 11
echo ============================================================================
echo.

echo Chiusura di eventuali istanze aperte di TurniDonnePulizieRT.exe...
taskkill /F /IM TurniDonnePulizieRT.exe >nul 2>nul

echo Compilazione della versione aggiornata in corso...
call build_windows_exe.bat

set "INSTALL_DIR=%LOCALAPPDATA%\\Programs\\TurniDonnePulizieRT"
echo [1/3] Copia dei file aggiornati di programma in: %INSTALL_DIR%
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

copy /Y "*.py" "%INSTALL_DIR%\\" >nul 2>nul
if exist "app_icon.ico" copy /Y "app_icon.ico" "%INSTALL_DIR%\\app_icon.ico" >nul
if exist "app_icon.png" copy /Y "app_icon.png" "%INSTALL_DIR%\\app_icon.png" >nul
if exist "iconadef.png" copy /Y "iconadef.png" "%INSTALL_DIR%\\iconadef.png" >nul
if exist "web_ui\\index.html" (
    xcopy /E /I /Y "web_ui" "%INSTALL_DIR%\\web_ui" >nul
)
if not exist "%INSTALL_DIR%\\profilo_turni.json" (
    if exist "profilo_turni.json" (
        copy /Y "profilo_turni.json" "%INSTALL_DIR%\\profilo_turni.json" >nul
    )
)

(
echo Set WshShell = CreateObject^("WScript.Shell"^)
echo WshShell.CurrentDirectory = "%INSTALL_DIR%"
echo WshShell.Run "pythonw.exe app_gui.py", 0, False
) > "%INSTALL_DIR%\\Avvia_TurniDonnePulizieRT.vbs"

set "TARGET_LAUNCH=%INSTALL_DIR%\\Avvia_TurniDonnePulizieRT.vbs"
if exist "dist\\TurniDonnePulizieRT.exe" (
    copy /Y "dist\\TurniDonnePulizieRT.exe" "%INSTALL_DIR%\\TurniDonnePulizieRT.exe" >nul
    set "TARGET_LAUNCH=%INSTALL_DIR%\\TurniDonnePulizieRT.exe"
)

echo [2/3] Creazione collegamento con Icona Personalizzata sul Desktop e nel Menu Start...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $desktop = [Environment]::GetFolderPath('Desktop'); ^
   $oldLnk1 = Join-Path $desktop 'Turni Donne Pulizie RT.lnk'; ^
   if (Test-Path $oldLnk1) { Remove-Item $oldLnk1 -Force }; ^
   $icoPath = if (Test-Path '%INSTALL_DIR%\\app_icon.ico') { '%INSTALL_DIR%\\app_icon.ico' } else { '%TARGET_LAUNCH%,0' }; ^
   $s1 = $ws.CreateShortcut((Join-Path $desktop 'Turni di Lavoro RT.lnk')); ^
   $s1.TargetPath = '%TARGET_LAUNCH%'; ^
   $s1.WorkingDirectory = '%INSTALL_DIR%'; ^
   $s1.IconLocation = $icoPath; ^
   $s1.Description = 'Turni di Lavoro RT - Gestione, Storico e Costi Turni'; ^
   $s1.Save(); ^
   $startMenu = [Environment]::GetFolderPath('Programs'); ^
   $oldLnk2 = Join-Path $startMenu 'Turni Donne Pulizie RT.lnk'; ^
   if (Test-Path $oldLnk2) { Remove-Item $oldLnk2 -Force }; ^
   $s2 = $ws.CreateShortcut((Join-Path $startMenu 'Turni di Lavoro RT.lnk')); ^
   $s2.TargetPath = '%TARGET_LAUNCH%'; ^
   $s2.WorkingDirectory = '%INSTALL_DIR%'; ^
   $s2.IconLocation = $icoPath; ^
   $s2.Description = 'Turni di Lavoro RT - Gestione, Storico e Costi Turni'; ^
   $s2.Save();"

echo.
echo ============================================================================
echo  [3/3] INSTALLAZIONE / AGGIORNAMENTO COMPLETATO CON SUCCESSO!
echo  Trovi l'icona personalizzata "Turni di Lavoro RT" direttamente sul tuo
echo  DESKTOP e nel MENU START di Windows con la UI identica all'anteprima!
echo ============================================================================
start "" "%TARGET_LAUNCH%"
pause
`;

  const uninstallFromWindowsBat = `@echo off
chcp 65001 >nul
echo ============================================================================
echo  DISINSTALLAZIONE "Turni di Lavoro RT" DA WINDOWS 10 / 11
echo ============================================================================
echo.

taskkill /F /IM TurniDonnePulizieRT.exe >nul 2>nul

set "INSTALL_DIR=%LOCALAPPDATA%\\Programs\\TurniDonnePulizieRT"
if exist "%INSTALL_DIR%" (
    echo Rimozione cartella programma: %INSTALL_DIR%
    rmdir /S /Q "%INSTALL_DIR%"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desktop = [Environment]::GetFolderPath('Desktop'); ^
   $lnk1 = Join-Path $desktop 'Turni di Lavoro RT.lnk'; ^
   if (Test-Path $lnk1) { Remove-Item $lnk1 -Force }; ^
   $oldLnk1 = Join-Path $desktop 'Turni Donne Pulizie RT.lnk'; ^
   if (Test-Path $oldLnk1) { Remove-Item $oldLnk1 -Force }; ^
   $startMenu = [Environment]::GetFolderPath('Programs'); ^
   $lnk2 = Join-Path $startMenu 'Turni di Lavoro RT.lnk'; ^
   if (Test-Path $lnk2) { Remove-Item $lnk2 -Force }; ^
   $oldLnk2 = Join-Path $startMenu 'Turni Donne Pulizie RT.lnk'; ^
   if (Test-Path $oldLnk2) { Remove-Item $oldLnk2 -Force };"

echo.
echo Programma e collegamenti sul Desktop/Menu Start rimossi con successo!
echo (I tuoi dati salvati in %APPDATA%\\TurniDonnePulizieRT sono stati preservati per sicurezza).
pause
`;

  const innoSetupIss = `; Script Inno Setup per generare l'installer Setup_TurniDonnePulizieRT.exe
[Setup]
AppName=Turni di Lavoro RT
AppVersion=2.2.0
DefaultDirName={autopf}\\TurniDonnePulizieRT
DefaultGroupName=Turni di Lavoro RT
OutputBaseFilename=Setup_TurniDonnePulizieRT
SetupIconFile=app_icon.ico
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest

[Files]
Source: "dist\\TurniDonnePulizieRT.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\\web_ui\\*"; DestDir: "{app}\\web_ui"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "app_icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "profilo_turni.json"; DestDir: "{app}"; Flags: onlyifdoesntexist

[Icons]
Name: "{autodesktop}\\Turni di Lavoro RT"; Filename: "{app}\\TurniDonnePulizieRT.exe"; IconFilename: "{app}\\app_icon.ico"; WorkingDir: "{app}"
Name: "{autoprograms}\\Turni di Lavoro RT"; Filename: "{app}\\TurniDonnePulizieRT.exe"; IconFilename: "{app}\\app_icon.ico"; WorkingDir: "{app}"

[Run]
Filename: "{app}\\TurniDonnePulizieRT.exe"; Description: "Avvia Turni di Lavoro RT"; Flags: nowait postinstall skipifsilent
`;

  return [
    {
      filename: 'INSTALLA_SU_WINDOWS.bat',
      description: '1-Click Installer/Updater per Windows: compila il .exe con la UI identica all’anteprima, lo installa in Programmi e crea l’icona sul Desktop',
      code: installOnWindowsBat,
    },
    {
      filename: 'DISINSTALLA_DA_WINDOWS.bat',
      description: '1-Click Uninstaller per Windows: chiude l’app, rimuove la cartella di installazione e cancella i collegamenti dal Desktop e Menu Start',
      code: uninstallFromWindowsBat,
    },
    {
      filename: 'build_windows_exe.bat',
      description: 'Script automatico batch per convertire app_icon.png in .ico e generare TurniDonnePulizieRT.exe con la UI Web Desktop inclusa',
      code: buildExeBat,
    },
    {
      filename: 'solver.py',
      description: 'Motore matematico Google OR-Tools CP-SAT con pareggio rigoroso delle ore e bilanciamento plurimensile sullo Storico Turni',
      code: solverPy,
    },
    {
      filename: 'config_manager.py',
      description: 'Gestione Auto-Save permanente in %APPDATA%, Storico Turni cronologico e importazione diretta di turni da file Excel (.xlsx)',
      code: configManagerPy,
    },
    {
      filename: 'exporter_excel.py',
      description: 'Generazione foglio Excel (.xlsx) con Totale Ore Mensili (=SOMMA) dinamico e 2° foglio Analisi_Costi_Personale',
      code: exporterExcelPy,
    },
    {
      filename: 'exporter_image.py',
      description: 'Rendering nitido a 300 DPI (.jpeg) dell’intero prospetto con Pillow',
      code: exporterImagePy,
    },
    {
      filename: 'app_gui.py',
      description: 'Launcher Desktop Windows nativo (avvia la UI identica al 100% all’anteprima con salvataggio automatico in %APPDATA% + fallback CustomTkinter)',
      code: appGuiPy,
    },
    {
      filename: 'requirements.txt',
      description: 'Elenco pacchetti Python per Windows 10/11',
      code: requirementsTxt,
    },
    {
      filename: 'installer_windows.iss',
      description: 'Script Inno Setup (opzionale) per creare un pacchetto di installazione distribuibile Setup_TurniDonnePulizieRT.exe',
      code: innoSetupIss,
    },
  ];
}

export async function downloadPythonWindowsSuiteZip(config: AppConfig): Promise<void> {
  const zip = new JSZip();
  const folder = zip.folder('TurniDonnePulizieRT_Windows_Suite');
  if (!folder) return;

  const files = getPythonSuiteFiles(config);
  for (const f of files) {
    folder.file(f.filename, f.code);
  }

  folder.file('profilo_turni.json', JSON.stringify(config, null, 2));

  try {
    const iconResp = await fetch('/assets/iconadef.png');
    if (iconResp.ok) {
      const iconBlob = await iconResp.blob();
      folder.file('app_icon.png', iconBlob);
      folder.file('iconadef.png', iconBlob);
    }
  } catch {
    // Proceed even if offline
  }

  // Includi l'intera applicazione Web compilata (web_ui/) nel pacchetto ZIP in modo che
  // la versione installata su Windows abbia la UI identica al 100% all'anteprima!
  try {
    const webUiFolder = folder.folder('web_ui');
    if (webUiFolder) {
      let indexHtmlContent = '';
      let assetFiles: string[] = [];

      const manifestResp = await fetch('/web_ui_dist/manifest.json');
      if (manifestResp.ok) {
        const manifest = await manifestResp.json();
        if (Array.isArray(manifest.files)) {
          assetFiles = manifest.files;
        }
        const htmlResp = await fetch('/web_ui_dist/index.html');
        if (htmlResp.ok) {
          indexHtmlContent = await htmlResp.text();
        }
      }

      if (indexHtmlContent) {
        const injectedHtml = indexHtmlContent.replace(
          '<head>',
          '<head>\n    <script src="/desktop_sync.js"></script>'
        );
        webUiFolder.file('index.html', injectedHtml);

        for (const relPath of assetFiles) {
          if (relPath === 'index.html') continue;
          const fileResp = await fetch(`/web_ui_dist/${relPath}`);
          if (fileResp.ok) {
            const fileBlob = await fileResp.blob();
            webUiFolder.file(relPath, fileBlob);
          }
        }
      }
    }
  } catch {
    // Fallback silenzioso se web_ui_dist non è raggiungibile
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'TurniDonnePulizieRT_Windows_Suite.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
