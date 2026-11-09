import React from 'react';
import { HelpCircle, X, CheckCircle2, Sparkles, BookOpen } from 'lucide-react';

export type GuideTabKey =
  | 'TAB_1_STAFF'
  | 'TAB_2_SHIFTS'
  | 'TAB_3_CALENDAR'
  | 'TAB_4_ABSENCES'
  | 'TAB_5_CCNL'
  | 'TAB_6_SOLVE'
  | 'TAB_ECONOMICS'
  | 'TAB_HISTORY'
  | 'TAB_7_WINDOWS_CODE';

export interface TabGuideContent {
  key: GuideTabKey;
  shortTabLabel: string;
  title: string;
  purpose: string;
  actionsHeading: string;
  actions: Array<{
    boldTitle: string;
    description: string;
  }>;
  goldenRule?: string;
}

export const TAB_GUIDES: Record<GuideTabKey, TabGuideContent> = {
  TAB_1_STAFF: {
    key: 'TAB_1_STAFF',
    shortTabLabel: 'Scheda Personale & Competenze',
    title: '❓ Guida: Gestione Organico e Competenze',
    purpose:
      "Gestisci l'elenco delle lavoratrici fisse e delle sostitute a chiamata, le loro abilitazioni ai turni e il monte ore contrattuale.",
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Modifica Nome:',
        description:
          'Clicca sul campo di testo di qualsiasi lavoratrice o premi "Rinomina". La modifica aggiorna automaticamente l\'intero programma, le esportazioni Excel/JPEG e lo storico, senza perdere i dati (grazie agli ID numerici interni).',
      },
      {
        boldTitle: 'Assegna Mansioni (Bar, Mattina, Pomeriggio):',
        description:
          'Spunta le caselle per definire quali turni la persona può ricoprire (es. Ioana al Bar; Sabrina e Ilaria sia Bar sia pulizie; Caterina solo Mattina).',
      },
      {
        boldTitle: 'Ore Contrattuali:',
        description:
          'Imposta il limite settimanale (default: 40h). Il solver rispetterà questo tetto evitando straordinari non concordati.',
      },
      {
        boldTitle: 'Aggiungi / Rimuovi Lavoratrice:',
        description:
          'Usa il tasto "+ Aggiungi Lavoratrice" per inserire nuovo personale, oppure disattiva una lavoratrice senza cancellarne lo storico pregresso.',
      },
    ],
    goldenRule:
      'Caterina e SIG.RA PATRIZIA sono impostate come "Sostitute": il sistema le chiamerà solo ed esclusivamente se le fisse non bastano a coprire tutti i turni richiesti.',
  },
  TAB_2_SHIFTS: {
    key: 'TAB_2_SHIFTS',
    shortTabLabel: 'Scheda Orari & Eccezioni',
    title: '❓ Guida: Configurazione Fasce Orarie ed Eccezioni',
    purpose:
      'Definisce gli orari effettivi di ingresso/uscita e il conteggio delle ore lavorate per ciascun turno, sia a livello standard sia per singole giornate speciali.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Fasce Standard:',
        description:
          'Modifica gli orari predefiniti divisi per giorni (Lun-Mer: Bar 6-12 [6h], Mattina 7-13 [6h], Pomeriggio 14-20 [6h]; Gio-Dom: Bar 6-13 [7h], Mattina 7-14 [7h], Pomeriggio 14-21 [7h]). Puoi modificare sia la dicitura visiva sia il valore delle ore retribuite.',
      },
      {
        boldTitle: 'Eccezioni di Calendario:',
        description:
          'Se in un giorno specifico (es. 15 del mese) il turno di mattina dura 5 ore invece di 6 (es. 7-12 anziché 7-13), seleziona la data precisa e il turno nella sezione "Eccezione Calendario" e imposta il nuovo orario.',
      },
    ],
    goldenRule:
      'Tutte le modifiche orarie si riflettono automaticamente sia nel calcolo dei totali ore sia nelle stime dei costi mensili.',
  },
  TAB_3_CALENDAR: {
    key: 'TAB_3_CALENDAR',
    shortTabLabel: 'Scheda Periodo & Fabbisogno',
    title: '❓ Guida: Periodo di Lavoro e Numero Donne per Turno',
    purpose:
      'Permette di stabilire il periodo da pianificare e quante operatrici devono essere presenti contemporaneamente in ogni singolo turno di ciascun giorno.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Selezione Mese/Periodo:',
        description:
          'Scegli il mese e l\'anno. Se necessario, puoi estendere il piano oltre la fine del mese (es. per completare la settimana fino alla domenica successiva) oppure scegliere un intervallo libero di date (Dal → Al).',
      },
      {
        boldTitle: 'Fabbisogno Giornaliero:',
        description: 'Di base sono richieste: 1 Bar, 4 Mattine, 2 Pomeriggi.',
      },
      {
        boldTitle: 'Variazioni di Fabbisogno:',
        description:
          'Se in un giorno infrasettimanale ci sono meno camere da rifare, puoi abbassare le presenze del mattino da 4 a 3 o a 2 cliccando direttamente sulla casella di quel giorno.',
      },
    ],
    goldenRule:
      'Se aumenti il fabbisogno oltre la capienza oraria delle 8 fisse, il programma attiverà in automatico le sostitute per evitare turni scoperti.',
  },
  TAB_4_ABSENCES: {
    key: 'TAB_4_ABSENCES',
    shortTabLabel: 'Scheda Ferie & Indisponibilità',
    title: '❓ Guida: Inserimento Ferie e Veti di Turno',
    purpose:
      'Registra i giorni di assenza o indisponibilità garantendo che il solver non assegni turni non desiderati.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Periodo di Ferie / Malattia (Dal → Al):',
        description:
          "Seleziona la dipendente, inserisci la data di partenza e di fine e scegli la causale (Ferie, Malattia, Permesso ROL, Riposo richiesto). Nessun turno le verrà assegnato in quell'intervallo.",
      },
      {
        boldTitle: 'Indisponibilità su Turno Specifico:',
        description:
          'Se una dipendente è disponibile solo parzialmente in un certo giorno (es. può lavorare al pomeriggio ma ha una visita la mattina), blocca selettivamente "Solo Turno Mattina": il programma potrà comunque impiegarla al pomeriggio.',
      },
    ],
    goldenRule:
      'Inserisci le richieste prima di calcolare i turni. Se si verificano incompatibilità, il tasto alert ti mostrerà il giorno preciso e il turno da correggere.',
  },
  TAB_5_CCNL: {
    key: 'TAB_5_CCNL',
    shortTabLabel: 'Scheda Vincoli CCNL & Equità',
    title: '❓ Guida: Vincoli di Legge e Rotazione Equa',
    purpose:
      'Regola i vincoli contrattuali vincolanti (CCNL Turismo) e i criteri matematici di equità tra le lavoratrici.',
    actionsHeading: 'Cosa puoi verificare e impostare:',
    actions: [
      {
        boldTitle: 'Divieto Pomeriggio → Mattina (11h di Riposo):',
        description:
          'Assicura che chi finisce alle 20:00 o 21:00 non sia mai messa in turno alle 06:00 o 07:00 del mattino seguente. Il giorno dopo farà un altro pomeriggio oppure sarà a riposo.',
      },
      {
        boldTitle: 'Limite 6 Giorni Consecutivi & 1 Riposo Settimanale:',
        description: 'Obbliga almeno 1 giorno di riposo per settimana solare (Lun-Dom).',
      },
      {
        boldTitle: 'Obbligo 1 Domenica Libera al Mese:',
        description:
          'Garantisce che ogni lavoratrice abbia almeno una domenica di riposo nel mese (e mai più di 3 domeniche lavorate consecutive anche considerando gli ultimi 3 mesi di storico).',
      },
      {
        boldTitle: 'Target ~160 Ore & Parità Mattine/Pomeriggi:',
        description:
          'Il motore bilancia il carico affinché tutte le fisse abbiano un monte ore simile (~160h-163h) e lo stesso identico numero di pomeriggi (8-9) e mattine.',
      },
    ],
  },
  TAB_6_SOLVE: {
    key: 'TAB_6_SOLVE',
    shortTabLabel: 'Scheda Anteprima & Esportazione',
    title: '❓ Guida: Generazione e Salvataggio dei File',
    purpose:
      'È la sezione in cui calcoli la turnazione, verifichi i conteggi, analizzi gli alert ed esporti i file.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Calcola Turni Ottimizzati:',
        description: "Avvia l'algoritmo per generare la turnazione ideale.",
      },
      {
        boldTitle: 'Verifica Indicatori & Alert:',
        description:
          'Controlla i badge di parità. Se appare un alert rosso/giallo, clicca su "Vai al Problema" per visualizzare subito il giorno e il turno critico.',
      },
      {
        boldTitle: 'Esporta Excel (.xlsx):',
        description:
          'Scarica il file modificabile completo di formule native, celle bar in giallo pastello, mattine in rosso e separatori verdi alle domeniche.',
      },
      {
        boldTitle: 'Esporta JPEG Lavoratrici:',
        description:
          "Genera l'immagine pulita a 300 DPI per WhatsApp o stampa, senza la tabella inferiore delle ore e dei costi.",
      },
      {
        boldTitle: 'Salva Mese nello Storico:',
        description:
          "Archivia l'orario nell'archivio permanente dell'hotel per le future rotazioni.",
      },
    ],
  },
  TAB_ECONOMICS: {
    key: 'TAB_ECONOMICS',
    shortTabLabel: 'Scheda Analisi Costi (€)',
    title: '❓ Guida: Controllo Costi del Lavoro Mensile',
    purpose:
      'Calcola in tempo reale la stima economica della turnazione moltiplicando le ore lavorate per la tariffa oraria di ciascuna dipendente.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Configura Costo Orario (€/h):',
        description: 'Imposta la tariffa oraria per ciascuna lavoratrice.',
      },
      {
        boldTitle: 'Ripartizione Mansioni:',
        description:
          'Visualizza quanto incide la spesa per il Bar, per le Pulizie Mattina e per le Pulizie Pomeriggio.',
      },
      {
        boldTitle: 'Incidenza Sostitute:',
        description:
          'Controlla la spesa destinata alle fisse rispetto a quella per Caterina e Sig.ra Patrizia.',
      },
      {
        boldTitle: 'Esportazione:',
        description:
          'Puoi includere il riepilogo economico come foglio dedicato nel file Excel.',
      },
    ],
  },
  TAB_HISTORY: {
    key: 'TAB_HISTORY',
    shortTabLabel: 'Scheda Storico Turni',
    title: '❓ Guida: Archivio Cronologico e Memoria Storica',
    purpose: 'Conserva gli orari dei mesi precedenti ordinati dal più recente al più vecchio.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Riapertura & Stampa:',
        description: "Riapri un mese passato e rigenera all'istante il JPEG o il file Excel.",
      },
      {
        boldTitle: 'Memoria Rotazioni:',
        description:
          'Il solver consulta lo storico per non assegnare sempre alle stesse persone le festività (Natale, Pasqua, Ferragosto) o le domeniche critiche.',
      },
    ],
  },
  TAB_7_WINDOWS_CODE: {
    key: 'TAB_7_WINDOWS_CODE',
    shortTabLabel: 'Sorgente Python Windows (.exe)',
    title: '❓ Guida: Installazione ed Eseguibile Desktop Windows (.exe)',
    purpose:
      'Permette di scaricare il pacchetto completo per installare o aggiornare il programma nativo su Windows 10/11.',
    actionsHeading: 'Cosa puoi fare:',
    actions: [
      {
        boldTitle: 'Scarica Programma Windows (.zip):',
        description:
          'Estrai lo ZIP in una cartella sul PC e fai doppio clic su INSTALLA_SU_WINDOWS.bat per creare l\'eseguibile .exe e l\'icona sul Desktop.',
      },
      {
        boldTitle: 'Disinstallazione Pulita:',
        description:
          'Usa DISINSTALLA_DA_WINDOWS.bat per rimuovere il programma scegliendo se conservare o meno lo storico turni salvato in %APPDATA%.',
      },
    ],
  },
};

interface HelpGuideButtonProps {
  tabKey: GuideTabKey;
  onOpenGuide: (key: GuideTabKey) => void;
}

export const HelpGuideButton: React.FC<HelpGuideButtonProps> = ({ tabKey, onOpenGuide }) => {
  return (
    <button
      type="button"
      onClick={() => onOpenGuide(tabKey)}
      title="Apri la guida dettagliata per questa scheda: spiega a cosa serve, cosa puoi fare e la regola d'oro operativa"
      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 shadow-2xs"
    >
      <HelpCircle className="w-4 h-4 text-slate-700" />
      <span>❓ Guida Scheda</span>
    </button>
  );
};

interface TabHelpModalProps {
  isOpen: boolean;
  activeGuideKey: GuideTabKey;
  onSelectGuideKey: (key: GuideTabKey) => void;
  onClose: () => void;
}

export const TabHelpModal: React.FC<TabHelpModalProps> = ({
  isOpen,
  activeGuideKey,
  onSelectGuideKey,
  onClose,
}) => {
  if (!isOpen) return null;

  const currentGuide = TAB_GUIDES[activeGuideKey] || TAB_GUIDES.TAB_6_SOLVE;
  const allGuideKeys: GuideTabKey[] = [
    'TAB_1_STAFF',
    'TAB_2_SHIFTS',
    'TAB_3_CALENDAR',
    'TAB_4_ABSENCES',
    'TAB_5_CCNL',
    'TAB_6_SOLVE',
    'TAB_ECONOMICS',
    'TAB_HISTORY',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-3xl w-full max-h-[88vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5 text-[#FEF08A]" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">{currentGuide.title}</h2>
              <p className="text-xs text-slate-300">
                Manuale operativo interattivo — Turni di Lavoro RT
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick Guide Switcher Pills */}
        <div className="px-6 py-2.5 bg-slate-100 border-b border-slate-200 flex items-center gap-1.5 overflow-x-auto">
          {allGuideKeys.map((k, idx) => {
            const g = TAB_GUIDES[k];
            const selected = k === activeGuideKey;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onSelectGuideKey(k)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
                  selected
                    ? 'bg-slate-900 text-white font-bold shadow-2xs'
                    : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                {idx + 1}. {g.shortTabLabel.replace('Scheda ', '')}
              </button>
            );
          })}
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto space-y-5 text-sm text-slate-800">
          {/* A cosa serve questa scheda */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
              A cosa serve questa scheda
            </div>
            <p className="text-sm font-medium text-slate-900 leading-relaxed">
              {currentGuide.purpose}
            </p>
          </div>

          {/* Cosa puoi fare */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
              {currentGuide.actionsHeading}
            </h3>
            <div className="space-y-2.5">
              {currentGuide.actions.map((act, index) => (
                <div
                  key={index}
                  className="p-3.5 bg-white border border-slate-200 rounded-lg flex items-start gap-3"
                >
                  <span className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {index + 1}
                  </span>
                  <div className="text-xs leading-relaxed text-slate-700">
                    <strong className="text-slate-950 font-bold italic mr-1.5">
                      {act.boldTitle}
                    </strong>
                    <span>{act.description}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Regola d'oro */}
          {currentGuide.goldenRule && (
            <div className="p-4 bg-[#FEF08A]/40 border border-amber-300 rounded-lg flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-0.5 text-xs leading-relaxed">
                <div className="font-bold text-slate-950 uppercase tracking-wider">
                  Regola d&apos;oro
                </div>
                <p className="text-slate-900 font-medium">{currentGuide.goldenRule}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Passa con il mouse su qualsiasi pulsante per leggere anche il Tooltip rapido.</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            Ho capito, chiudi guida
          </button>
        </div>
      </div>
    </div>
  );
};
