import React, { useEffect, useState, useRef } from 'react';

export interface StructuredTooltipInfo {
  title: string;
  purpose: string;
  effect: string;
  requirement?: string;
}

/**
 * Resolves a comprehensive, structured multi-line tooltip for ANY interactive control
 * or table column header in the application.
 */
function resolveControlTooltip(el: HTMLElement): StructuredTooltipInfo | null {
  // 1. Check explicit data attributes first
  const explicitTitle = el.getAttribute('data-tt-title');
  const explicitPurpose = el.getAttribute('data-tt-purpose');
  const explicitEffect = el.getAttribute('data-tt-effect');
  const explicitReq = el.getAttribute('data-tt-req');

  if (explicitTitle && explicitPurpose) {
    return {
      title: explicitTitle,
      purpose: explicitPurpose,
      effect:
        explicitEffect ||
        'Applica immediatamente la modifica e aggiorna la memoria permanente (Auto-Save).',
      requirement: explicitReq || undefined,
    };
  }

  // Migrate native title attribute to data-native-title so the browser's native tooltip doesn't overlap
  const nativeTitle = el.getAttribute('title');
  if (nativeTitle) {
    el.setAttribute('data-native-title', nativeTitle);
    el.removeAttribute('title');
  }
  const savedTitle = el.getAttribute('data-native-title') || '';

  const tag = el.tagName.toLowerCase();
  const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const labelText = rawText || savedTitle || el.getAttribute('placeholder') || '';
  const lower = labelText.toLowerCase();

  // 2. Match buttons & navigation tabs
  if (tag === 'button' || el.getAttribute('role') === 'button') {
    if (lower.includes('scarica programma windows') || lower.includes('.zip')) {
      return {
        title: 'Scarica Programma Desktop Windows (.zip)',
        purpose:
          'Genera e scarica il pacchetto completo installabile per Windows 10/11 con interfaccia grafica Python CustomTkinter e motore Google OR-Tools.',
        effect:
          'Avvia il download di TurniDonnePulizieRT_Windows_Suite.zip contenente INSTALLA_SU_WINDOWS.bat, DISINSTALLA_DA_WINDOWS.bat, icona personalizzata e i tuoi dati attuali.',
        requirement:
          'Dopo il download, estrai la cartella ZIP sul PC e fai doppio clic su INSTALLA_SU_WINDOWS.bat.',
      };
    }
    if (lower.includes('scheda 1') || lower.includes('personale')) {
      return {
        title: 'Scheda 1: Anagrafica Personale & Competenze',
        purpose:
          'Apre la gestione dell’organico lavoratrici con ID numerici progressivi immutabili (#1, #2, ...).',
        effect:
          'Permette di rinominare le lavoratrici, aggiungerne di nuove, eliminarne di esistenti, impostare le mansioni (Bar, Mattina, Pomeriggio) e la tariffa oraria (€/h).',
        requirement: 'Ogni modifica viene salvata istantaneamente in memoria permanente.',
      };
    }
    if (lower.includes('scheda 2') || lower.includes('periodo & fabbisogno')) {
      return {
        title: 'Scheda 2: Periodo, Calendario & Fabbisogno Giornaliero',
        purpose:
          'Imposta il mese/anno di riferimento, eventuali giorni oltre fine mese o un intervallo personalizzato di date.',
        effect:
          'Rigenera il calendario e consente di personalizzare quante lavoratrici servono ogni giorno per Bar, Mattina e Pomeriggio.',
        requirement: 'Qualsiasi variazione viene salvata automaticamente in memoria permanente.',
      };
    }
    if (
      lower.includes('scheda 3') ||
      lower.includes('orari & eccezioni') ||
      lower.includes('orari turni') ||
      lower.includes('orari & calcolo')
    ) {
      return {
        title: 'Scheda 3: Orari Standard & Eccezioni Calendario',
        purpose:
          'Configura gli orari dei turni (Lun-Mer, Gio-Sab, Dom/Festivi) e le Eccezioni Orarie per date specifiche.',
        effect:
          'Aggiorna le etichette orarie (es. 7-13, 14-20) e le ore retribuite usate dal motore matematico e dal file Excel.',
        requirement:
          'Le eccezioni orarie di calendario hanno priorità assoluta rispetto alle fasce settimanali standard.',
      };
    }
    if (lower.includes('scheda 4') || lower.includes('ferie & indisponibilità')) {
      return {
        title: 'Scheda 4: Ferie, Malattia & Indisponibilità',
        purpose:
          'Gestisce i periodi di assenza a giornata intera o le indisponibilità per singolo turno (solo Bar, solo Mattina o solo Pomeriggio).',
        effect:
          'Blocca matematicamente l’assegnazione della lavoratrice nei giorni/turni indicati e ricalcola automaticamente le sostituzioni.',
        requirement:
          'Collegato all’ID numerico immutabile della lavoratrice: anche se la rinomini, le ferie restano associate correttamente.',
      };
    }
    if (lower.includes('scheda 5') || lower.includes('vincoli ccnl')) {
      return {
        title: 'Scheda 5: Vincoli CCNL & Pesi di Equità',
        purpose:
          'Controlla i vincoli rigidi contrattuali (riposo 11h Pomeriggio→Mattina, max giorni consecutivi, 1 domenica libera mensile) e i pesi di equità.',
        effect:
          'Modifica i parametri del risolutore matematico CP-SAT e ricalcola in tempo reale la distribuzione dei turni.',
      };
    }
    if (lower.includes('scheda 6') || lower.includes('anteprima & esportazione')) {
      return {
        title: 'Scheda 6: Griglia Turni & Esportazione Excel / JPEG',
        purpose:
          'Mostra il prospetto mensile completo stile foglio cartaceo, le statistiche di equità e i pulsanti di esportazione.',
        effect:
          'Permette di verificare i turni generati, archiviare il mese nello Storico e scaricare il file Excel (.xlsx) o l’immagine 300 DPI (.jpeg).',
      };
    }
    if (lower.includes('storico turni') && !lower.includes('salva') && !lower.includes('archivia')) {
      return {
        title: 'Sezione Storico Turni (Archivio Cronologico Mensile)',
        purpose:
          'Consulta, importa da Excel (.xlsx) ed esporta gli orari dei mesi passati ordinati dal più recente al più vecchio.',
        effect:
          'I mesi presenti nello Storico vengono letti automaticamente dal motore di calcolo per equilibrare ore, festività/weekend e turni Mattina/Pomeriggio nei mesi successivi.',
      };
    }
    if (lower.includes('analisi costi')) {
      return {
        title: 'Sezione Analisi Economica & Costi Personale (€)',
        purpose:
          'Calcola la spesa mensile stimata per ciascuna dipendente, per mansione (Bar, Mattina, Pomeriggio) e per contratto (Fisse vs Sostitute).',
        effect:
          'Mostra grafici comparativi, tabella analitica con Totale Generale del Mese (€) ed esportazione Excel con foglio costi dedicato.',
      };
    }
    if (lower.includes('sorgente python') || lower.includes('.exe')) {
      return {
        title: 'Codice Sorgente Python Windows & Guida Installazione',
        purpose:
          'Visualizza i moduli Python (solver.py, app_gui.py, exporter_excel.py) e le istruzioni per compilare ed eseguire il programma su Windows.',
        effect:
          'Permette di ispezionare o copiare i singoli file Python oppure scaricare il pacchetto .zip pronto all’uso.',
      };
    }
    if (lower.includes('importa turni da excel') || lower.includes('carica excel nello storico')) {
      return {
        title: 'Importa Turni nello Storico da File Excel (.xlsx)',
        purpose:
          'Carica uno o più file Excel (.xlsx) di turni passati direttamente dentro l’Archivio Storico Turni.',
        effect:
          'Legge automaticamente date, turni (Bar, Mattina, Pomeriggio), ore lavorate, domeniche e festività di ogni lavoratrice, salvando il mese nello storico permanente.',
        requirement:
          'Una volta importato il file Excel nello storico, il solver lo userà automaticamente per bilanciare ore, weekend/festività e rotazioni nei nuovi mesi.',
      };
    }
    if (lower.includes('esporta intero storico in excel')) {
      return {
        title: 'Esporta Intero Archivio Storico in Excel (.xlsx)',
        purpose:
          'Genera un unico file Excel (.xlsx) contenente tutti i mesi archiviati nello storico.',
        effect:
          'Scarica sul PC un foglio di calcolo riepilogativo plurimensile pronto per la consulenza del lavoro o il backup esterno.',
        requirement: 'Richiede che almeno un mese sia presente nello Storico Turni.',
      };
    }
    if (lower.includes('esporta excel') || lower.includes('scarica foglio excel') || lower === 'excel (.xlsx)') {
      return {
        title: 'Esporta Prospetto Turni in Formato Excel (.xlsx)',
        purpose:
          'Genera il file Microsoft Excel (.xlsx) identico al modello cartaceo con colori ufficiali e formule native.',
        effect:
          'Crea il 1° foglio con la griglia turni e la riga "Totale Ore Mensili" (=SOMMA(...)) dinamica + il 2° foglio "Analisi Costi Personale". Se modifichi un orario a mano in Excel, il totale ore si aggiorna da solo.',
        requirement: 'Richiede che il calcolo turni sia stato completato.',
      };
    }
    if (lower.includes('jpeg') || lower.includes('immagine')) {
      return {
        title: 'Esporta Immagine ad Alta Risoluzione 300 DPI (.jpeg)',
        purpose:
          'Genera un’immagine grafica nitida a 300 DPI della tabella turni.',
        effect:
          'Scarica il file .jpeg pronto per essere inviato su WhatsApp alle lavoratrici o stampato in bacheca.',
        requirement: 'Richiede che il calcolo turni sia stato completato.',
      };
    }
    if (lower.includes('salva e archivia') || lower.includes('archivia orario') || lower.includes('conferma e salva')) {
      return {
        title: 'Salva e Archivia Mese Corrente nello Storico Turni',
        purpose:
          'Registra l’orario attualmente visualizzato dentro l’archivio cronologico permanente.',
        effect:
          'Salva la griglia turni, le ore lavorate, le domeniche/festività e i costi del mese, rendendoli disponibili al solver per equilibrare i mesi futuri.',
      };
    }
    if (lower.includes('carica nell\'area') || lower.includes('carica nell’area')) {
      return {
        title: 'Carica Mese Storico nell’Area di Lavoro Attiva',
        purpose:
          'Ripristina nel pianificatore principale il calendario e le impostazioni del mese selezionato dallo storico.',
        effect:
          'Aggiorna le schede di lavoro con i dati di quel periodo e salva lo stato in memoria permanente.',
      };
    }
    if (lower.includes('anteprima griglia') || lower.includes('nascondi griglia')) {
      return {
        title: 'Visualizza / Nascondi Anteprima Griglia Turni',
        purpose:
          'Mostra a schermo la tabella completa giorno per giorno del mese archiviato selezionato.',
        effect:
          'Apre o chiude il riquadro di ispezione rapida senza sovrascrivere il mese su cui stai lavorando attualmente.',
      };
    }
    if (lower.includes('ricalcola') || lower.includes('calcola turni') || lower.includes('ottimizza')) {
      return {
        title: 'Avvia Risolutore Matematico Turni (CP-SAT)',
        purpose:
          'Esegue l’algoritmo di ottimizzazione tenendo conto di fabbisogni, ferie, vincoli CCNL e storico dei mesi passati.',
        effect:
          'Genera la distribuzione ottimale pareggiando le ore (~160h), i turni Mattina/Pomeriggio e ruotando equamente weekend e festività.',
      };
    }
    if (lower.includes('aggiungi lavoratrice') || lower.includes('+ aggiungi')) {
      return {
        title: 'Aggiungi Nuova Lavoratrice all’Organico',
        purpose:
          'Inserisce una nuova dipendente nella tabella del personale assegnandole il prossimo ID numerico progressivo immutabile.',
        effect:
          'Salva istantaneamente la nuova lavoratrice in memoria permanente e ricalcola la turnazione includendola.',
        requirement: 'Inserisci almeno il nome della lavoratrice prima di premere il pulsante.',
      };
    }
    if (lower.includes('elimina') || savedTitle.toLowerCase().includes('elimina') || savedTitle.toLowerCase().includes('rimuovi')) {
      return {
        title: 'Elimina Elemento Selezionato',
        purpose:
          'Rimuove definitivamente la riga selezionata (lavoratrice, assenza, eccezione oraria o record storico).',
        effect:
          'Cancella l’elemento, aggiorna istantaneamente la memoria permanente e ricalcola il piano turni.',
        requirement: 'Gli ID numerici delle altre lavoratrici restano invariati per non corrompere lo storico.',
      };
    }
    if (lower.includes('rinomina')) {
      return {
        title: 'Rinomina Lavoratrice',
        purpose:
          'Posiziona il cursore nella casella del nome della lavoratrice per modificarlo rapidamente.',
        effect:
          'Qualsiasi modifica al nome viene salvata automaticamente su disco e si riflette in tutte le schede e nello storico grazie all’ID numerico immutabile.',
      };
    }
    if (lower.includes('pari contratto') || lower.includes('40h')) {
      return {
        title: 'Allinea Contratti Lavoratrici Fisse a 40 Ore Settimanali',
        purpose:
          'Imposta a 40h/settimana il limite contrattuale di tutte le lavoratrici Fisse (inclusa l’addetta Bar).',
        effect:
          'Garantisce che tutte le dipendenti fisse concorrano allo stesso monte ore mensile (~160h) e salva la modifica.',
      };
    }
    if (lower.includes('carica profilo')) {
      return {
        title: 'Importa Backup Configurazione (.json)',
        purpose:
          'Ripristina l’intera configurazione del programma da un file di backup .json salvato in precedenza sul PC.',
        effect:
          'Aggiorna anagrafica, orari, ferie e storico salvandoli subito nella memoria permanente.',
      };
    }
    if (lower.includes('salva profilo')) {
      return {
        title: 'Esporta Backup Configurazione (.json)',
        purpose:
          'Salva su file esterno .json una copia di sicurezza di tutte le impostazioni attuali (personale, tariffe, assenze, storico).',
        effect:
          'Scarica il file .json sul computer (utile per trasferire i dati su un altro PC).',
      };
    }
    if (lower.includes('reset')) {
      return {
        title: 'Ripristina Configurazione Predefinita',
        purpose:
          'Riporta anagrafica, orari e calendario ai valori iniziali di fabbrica.',
        effect:
          'Sovrascrive le modifiche correnti con il profilo base predefinito.',
        requirement: 'Attenzione: usa prima "Salva Profilo" se desideri conservare una copia delle modifiche attuali.',
      };
    }

    return {
      title: labelText ? `Pulsante: ${labelText.slice(0, 48)}` : 'Comando Interattivo',
      purpose: savedTitle || `Esegue l’azione associata a "${labelText || 'questo controllo'}".`,
      effect:
        'Applica immediatamente l’operazione selezionata e aggiorna automaticamente i dati salvati in memoria permanente.',
    };
  }

  // 3. Match Input / Select / Textarea controls
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const inputType = (el as HTMLInputElement).type?.toLowerCase() || tag;
    const placeholder = el.getAttribute('placeholder') || '';

    if (inputType === 'checkbox') {
      return {
        title: 'Casella di Attivazione / Abilitazione',
        purpose:
          'Attiva o disattiva l’opzione o la mansione (es. Stato Attiva, Abilitazione Bar, Mattina, Pomeriggio o Festività).',
        effect:
          'Salva istantaneamente la preferenza in memoria permanente e aggiorna i vincoli del motore di calcolo turni.',
      };
    }
    if (inputType === 'range') {
      return {
        title: 'Cursore di Regolazione Priorità / Peso (1 - 10)',
        purpose:
          'Regola l’importanza matematica di questo criterio nella funzione obiettivo del solver CP-SAT.',
        effect:
          'Spostando il cursore verso 10 il solver darà priorità massima a questo bilanciamento, salvando subito la modifica.',
      };
    }
    if (inputType === 'number') {
      return {
        title: 'Campo Valore Numerico Configurabile',
        purpose:
          'Permette di inserire o modificare il parametro numerico (es. Ore retribuite, Tariffa Oraria €/h, Fabbisogno o Max Ore Settimanali).',
        effect:
          'Ricalcola automaticamente ore, turni e stime dei costi mensili salvando il nuovo valore in memoria permanente.',
      };
    }
    if (tag === 'select') {
      return {
        title: 'Menu di Selezione Opzione',
        purpose:
          'Consente di scegliere il valore desiderato tra le opzioni disponibili (es. Mese, Anno, Tipologia Contratto, Lavoratrice o Turno).',
        effect:
          'Applica immediatamente la scelta selezionata e aggiorna la memoria permanente.',
      };
    }

    return {
      title: placeholder ? `Campo di Inserimento: ${placeholder}` : 'Campo di Testo Modificabile',
      purpose:
        'Permette di digitare o modificare direttamente il testo (es. Nome lavoratrice, Orario turno "7-13", Etichetta periodo o Note).',
      effect:
        'Ogni carattere digitato viene memorizzato istantaneamente dal sistema di Auto-Save senza bisogno di conferme esterne.',
    };
  }

  // 4. Match Table Column Headers (<th>)
  if (tag === 'th') {
    return {
      title: `Colonna Tabella: ${labelText || 'Dati'}`,
      purpose: `Indica il contenuto verticale della colonna "${labelText}" all’interno del prospetto.`,
      effect:
        'I dati sottostanti sono collegati all’ID numerico immutabile e si aggiornano in tempo reale ad ogni modifica.',
    };
  }

  return null;
}

export const GlobalTooltipSystem: React.FC = () => {
  const [tooltip, setTooltip] = useState<{
    info: StructuredTooltipInfo;
    x: number;
    y: number;
  } | null>(null);

  const timerRef = useRef<number | null>(null);
  const currentTargetRef = useRef<HTMLElement | null>(null);
  const isTooltipVisibleRef = useRef<boolean>(false);

  useEffect(() => {
    const clearPending = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hideTooltipIfVisible = () => {
      if (isTooltipVisibleRef.current) {
        isTooltipVisibleRef.current = false;
        setTooltip(null);
      }
    };

    const handleMouseOver = (e: MouseEvent) => {
      const rawTarget = e.target as HTMLElement | null;
      if (!rawTarget || typeof rawTarget.closest !== 'function') return;

      const interactiveEl = rawTarget.closest(
        'button, input, select, textarea, th, [data-tt-title]'
      ) as HTMLElement | null;

      if (!interactiveEl) {
        clearPending();
        currentTargetRef.current = null;
        hideTooltipIfVisible();
        return;
      }

      if (currentTargetRef.current === interactiveEl) {
        return;
      }

      clearPending();
      hideTooltipIfVisible();
      currentTargetRef.current = interactiveEl;

      // Migrate native title attribute immediately so browser's native tooltip doesn't appear
      const nativeTitle = interactiveEl.getAttribute('title');
      if (nativeTitle) {
        interactiveEl.setAttribute('data-native-title', nativeTitle);
        interactiveEl.removeAttribute('title');
      }

      // 450ms delay: resolve tooltip text ONLY when user actually pauses cursor for 450ms
      timerRef.current = window.setTimeout(() => {
        if (!currentTargetRef.current) return;
        const info = resolveControlTooltip(currentTargetRef.current);
        if (!info) return;

        const rect = currentTargetRef.current.getBoundingClientRect();
        const tooltipWidth = 340;
        const tooltipHeight = 145;

        let x = rect.left + rect.width / 2 - tooltipWidth / 2;
        x = Math.max(12, Math.min(x, window.innerWidth - tooltipWidth - 12));

        let y = rect.bottom + 10;
        if (y + tooltipHeight > window.innerHeight - 12) {
          y = Math.max(12, rect.top - tooltipHeight - 10);
        }

        isTooltipVisibleRef.current = true;
        setTooltip({ info, x, y });
      }, 450);
    };

    const handleMouseOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (
        currentTargetRef.current &&
        related &&
        currentTargetRef.current.contains(related)
      ) {
        return;
      }
      clearPending();
      currentTargetRef.current = null;
      hideTooltipIfVisible();
    };

    const handleDismiss = () => {
      clearPending();
      hideTooltipIfVisible();
    };

    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('mousedown', handleDismiss, true);
    window.addEventListener('scroll', handleDismiss, true);

    return () => {
      clearPending();
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('mouseout', handleMouseOut, true);
      document.removeEventListener('mousedown', handleDismiss, true);
      window.removeEventListener('scroll', handleDismiss, true);
    };
  }, []);

  if (!tooltip) return null;

  return (
    <div
      style={{
        left: `${tooltip.x}px`,
        top: `${tooltip.y}px`,
        width: '340px',
      }}
      className="fixed z-[9999] pointer-events-none bg-slate-900/95 text-slate-100 border border-slate-700 rounded-lg shadow-xl p-3.5 text-xs leading-relaxed backdrop-blur-xs transition-opacity duration-150"
    >
      <div className="font-bold text-white text-[13px] mb-1.5 border-b border-slate-700/80 pb-1">
        {tooltip.info.title}
      </div>
      <div className="space-y-1.5 text-slate-200">
        <div>
          <span className="font-semibold text-amber-300">Funzione: </span>
          <span>{tooltip.info.purpose}</span>
        </div>
        <div>
          <span className="font-semibold text-emerald-300">Effetto: </span>
          <span>{tooltip.info.effect}</span>
        </div>
        {tooltip.info.requirement && (
          <div className="text-[11px] text-slate-300 pt-1 border-t border-slate-800">
            <span className="font-semibold text-sky-300">Nota / Requisito: </span>
            <span>{tooltip.info.requirement}</span>
          </div>
        )}
      </div>
    </div>
  );
};
