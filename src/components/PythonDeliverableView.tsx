import React, { useState } from 'react';
import { Copy, Check, Download, Terminal, FileCode, PackageCheck } from 'lucide-react';
import { AppConfig } from '../types';
import {
  downloadPythonWindowsSuiteZip,
  getPythonSuiteFiles,
} from '../services/pythonSuiteGenerator';

interface PythonDeliverableModalProps {
  config: AppConfig;
}

export const PythonDeliverableView: React.FC<PythonDeliverableModalProps> = ({ config }) => {
  const files = getPythonSuiteFiles(config);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [isZipping, setIsZipping] = useState(false);

  const activeFile = files[selectedFileIdx] || files[0];

  const handleCopy = async (code: string, filename: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedFile(filename);
    setTimeout(() => setCopiedFile(null), 2000);
  };

  const handleDownloadSingleFile = (filename: string, code: string) => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadZip = async () => {
    setIsZipping(true);
    try {
      await downloadPythonWindowsSuiteZip(config);
    } finally {
      setIsZipping(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Banner & One-Click ZIP Download */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-bold text-slate-900">
            Architettura Software Windows 10/11 (Python + Google OR-Tools CP-SAT + PyInstaller)
          </h2>
          <p className="text-sm text-slate-600 max-w-3xl">
            Codice sorgente completo, modulare e pronto alla compilazione in un unico eseguibile
            autoportante <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">TurniDonnePulizieRT.exe</code>.
            Include già il tuo profilo di configurazione attuale (<code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">profilo_turni.json</code>).
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleDownloadZip}
            disabled={isZipping}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <PackageCheck className="w-4 h-4" />
            {isZipping ? 'Creazione ZIP...' : 'Scarica Suite Completa Windows (.zip)'}
          </button>
        </div>
      </div>

      {/* Windows Installation & PyInstaller Instructions */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-slate-700" />
            Istruzioni per l&apos;installazione su Windows 10/11 e generazione dell&apos;eseguibile (.exe)
          </h3>
          <span className="text-xs text-slate-500">Python 3.10 / 3.11 / 3.12 consigliato</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2">
            <div className="font-bold text-slate-900">1. Installazione Requisiti</div>
            <p className="text-slate-600">
              Estrai lo ZIP in una cartella su Windows, apri il Prompt dei Comandi (cmd) o PowerShell
              nella cartella ed esegui:
            </p>
            <pre className="p-2 bg-slate-900 text-slate-100 rounded font-mono text-[11px] overflow-x-auto">
              pip install ortools customtkinter openpyxl Pillow pyinstaller
            </pre>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2">
            <div className="font-bold text-slate-900">2. Avvio Diretto da Sorgente</div>
            <p className="text-slate-600">
              Per avviare immediatamente l&apos;interfaccia grafica desktop Windows senza compilare:
            </p>
            <pre className="p-2 bg-slate-900 text-slate-100 rounded font-mono text-[11px] overflow-x-auto">
              python app_gui.py
            </pre>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2">
            <div className="font-bold text-slate-900">3. Compilazione in unico .EXE</div>
            <p className="text-slate-600">
              Doppio clic su <code className="font-mono">build_windows_exe.bat</code> oppure lancia il comando PyInstaller:
            </p>
            <pre className="p-2 bg-slate-900 text-slate-100 rounded font-mono text-[11px] overflow-x-auto">
              pyinstaller --noconfirm --onefile --windowed --name &quot;TurniDonnePulizieRT&quot; --collect-all customtkinter --collect-all ortools app_gui.py
            </pre>
          </div>
        </div>
      </div>

      {/* Modular File Browser */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {files.map((f, idx) => (
              <button
                key={f.filename}
                onClick={() => setSelectedFileIdx(idx)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  selectedFileIdx === idx
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-200/70'
                }`}
              >
                <FileCode className="w-3.5 h-3.5" />
                {f.filename}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleCopy(activeFile.code, activeFile.filename)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {copiedFile === activeFile.filename ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  Copiato
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copia Codice
                </>
              )}
            </button>
            <button
              onClick={() => handleDownloadSingleFile(activeFile.filename, activeFile.code)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Scarica {activeFile.filename}
            </button>
          </div>
        </div>

        <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 text-xs text-slate-600">
          <span className="font-mono font-semibold text-slate-900">{activeFile.filename}</span>
          <span className="mx-2">·</span>
          <span>{activeFile.description}</span>
        </div>

        <pre className="p-4 bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed overflow-x-auto max-h-[540px]">
          <code>{activeFile.code}</code>
        </pre>
      </div>
    </div>
  );
};
