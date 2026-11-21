import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CleanReport, Entity, FileKind, UserTerm } from '../core/types';
import type { FileStage, FromWorker, ToWorker } from '../worker/protocol';

export type FileStatus = 'fila' | 'processando' | 'pronto' | 'erro';

export interface FileItem {
  id: string;
  file: File;
  status: FileStatus;
  stage?: FileStage;
  progress: number;
  kind?: FileKind;
  text?: string;
  entities?: Entity[];
  warnings: string[];
  /** erro de leitura/análise */
  error?: string;
  /** erro ao gerar o arquivo limpo (o arquivo continua analisado) */
  applyError?: string;
  result?: { blob: Blob; fileName: string; report: CleanReport };
}

export interface ModelState {
  classic: 'carregando' | 'ok' | 'erro';
  ner: 'carregando' | 'ok' | 'indisponivel';
  progress: number;
}

const ACCEPT = /\.(pdf|docx|xlsx|csv)$/i;
export const MAX_BYTES = 50 * 1024 * 1024;

let seq = 0;

/**
 * Estado do app + ponte com o Web Worker. Nada é persistido: tudo vive em memória
 * (React state + worker). "Limpar sessão" e "Cancelar" encerram o worker.
 */
export function useCleaner(createWorker: () => Worker) {
  const worker = useRef<Worker | null>(null);
  /** geração do worker: mensagens/ações de uma geração anterior são ignoradas */
  const gen = useRef(0);
  /** rodada de aplicação: `cleaned` de rodadas antigas é descartado */
  const run = useRef(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [models, setModels] = useState<ModelState>({ classic: 'carregando', ner: 'carregando', progress: 0 });
  const [busy, setBusy] = useState(false);
  /** ids aguardando resultado da aplicação */
  const [pending, setPending] = useState<string[]>([]);

  const patch = useCallback((id: string, p: Partial<FileItem> | ((f: FileItem) => Partial<FileItem>)) =>
    setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...(typeof p === 'function' ? p(f) : p) } : f))), []);

  const send = useCallback((m: ToWorker, transfer: Transferable[] = []) => worker.current?.postMessage(m, transfer), []);

  const boot = useCallback(() => {
    const myGen = ++gen.current;
    const w = createWorker();
    const onMessage = (e: MessageEvent<FromWorker>) => {
      if (myGen !== gen.current) return;
      const m = e.data;
      switch (m.type) {
        case 'models': setModels({ classic: m.classic === 'ok' ? 'ok' : 'erro', ner: m.ner, progress: m.progress ?? 0 }); break;
        case 'progress':
          // re-detecção não rebaixa um arquivo já analisado (evita a Revisão esvaziar)
          patch(m.id, (f) => (f.entities && m.stage !== 'pronto' ? { stage: m.stage } : { status: m.stage === 'pronto' ? 'pronto' : 'processando', stage: m.stage, progress: m.progress }));
          break;
        case 'analyzed': patch(m.id, { status: 'pronto', kind: m.kind, text: m.text, entities: m.entities, warnings: m.warnings, progress: 1, error: undefined }); break;
        case 'file-error':
          if (m.runId !== undefined) {
            if (m.runId !== run.current) return;
            patch(m.id, { applyError: m.message });
            setPending((p) => p.filter((x) => x !== m.id));
          } else patch(m.id, { status: 'erro', error: m.message, progress: 1 });
          break;
        case 'cleaned':
          if (m.runId !== run.current) return;
          patch(m.id, { result: { blob: m.blob, fileName: m.fileName, report: m.report }, applyError: undefined });
          setPending((p) => p.filter((x) => x !== m.id));
          break;
        case 'done': setBusy(false); break;
      }
    };
    const crash = () => {
      if (myGen !== gen.current) return;
      setModels((m) => ({ ...m, classic: m.classic === 'ok' ? 'ok' : 'erro' }));
      setBusy(false);
      setPending([]);
      setFiles((fs) => fs.map((f) => (f.status === 'processando' ? { ...f, status: 'erro', error: 'O processamento foi interrompido (memória insuficiente?). Tente de novo com menos arquivos.' } : f)));
    };
    w.onmessage = onMessage;
    w.onerror = crash;
    w.onmessageerror = crash;
    w.postMessage({ type: 'init' } satisfies ToWorker);
    worker.current = w;
  }, [createWorker, patch]);

  useEffect(() => {
    boot();
    // gen/worker são contadores e handles do worker, não nós do DOM
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { gen.current++; worker.current?.terminate(); };
  }, [boot]);

  /** Adiciona arquivos à fila; devolve os rejeitados com motivo. */
  const addFiles = useCallback((list: File[]) => {
    const rejected: { name: string; reason: 'formato' | 'tamanho' | 'duplicado' }[] = [];
    const ok: FileItem[] = [];
    for (const file of list) {
      if (!ACCEPT.test(file.name)) rejected.push({ name: file.name, reason: 'formato' });
      else if (file.size > MAX_BYTES) rejected.push({ name: file.name, reason: 'tamanho' });
      else if ([...files, ...ok].some((f) => f.file.name === file.name && f.file.size === file.size)) rejected.push({ name: file.name, reason: 'duplicado' });
      else ok.push({ id: `f${++seq}`, file, status: 'fila', progress: 0, warnings: [] });
    }
    setFiles((fs) => [...fs, ...ok]);
    return rejected;
  }, [files]);

  const removeFile = useCallback((id: string) => setFiles((fs) => fs.filter((f) => f.id !== id)), []);

  const analyze = useCallback(async (terms: UserTerm[]) => {
    const pendingFiles = files.filter((f) => f.status === 'fila' || f.status === 'erro');
    if (!pendingFiles.length) return;
    const myGen = gen.current;
    setBusy(true);
    setFiles((fs) => fs.map((f) => (pendingFiles.some((p) => p.id === f.id) ? { ...f, status: 'processando', progress: 0.02, error: undefined } : f)));
    let payload: { id: string; name: string; buffer: ArrayBuffer }[];
    try {
      payload = await Promise.all(pendingFiles.map(async (f) => ({ id: f.id, name: f.file.name, buffer: await f.file.arrayBuffer() })));
    } catch {
      setBusy(false);
      setFiles((fs) => fs.map((f) => (pendingFiles.some((p) => p.id === f.id) ? { ...f, status: 'erro', error: 'Não foi possível ler o arquivo do disco.' } : f)));
      return;
    }
    if (myGen !== gen.current) return; // cancelado durante a leitura
    send({ type: 'analyze', files: payload, terms }, payload.map((p) => p.buffer));
  }, [files, send]);

  const redetect = useCallback((terms: UserTerm[]) => { setBusy(true); send({ type: 'redetect', terms }); }, [send]);

  /** Gera os arquivos limpos. Cada chamada é uma nova rodada; resultados antigos são descartados. */
  const applyAll = useCallback((items: { id: string; entities: Entity[] }[]) => {
    const runId = ++run.current;
    setFiles((fs) => fs.map((f) => (items.some((i) => i.id === f.id) ? { ...f, result: undefined, applyError: undefined } : f)));
    setPending(items.map((i) => i.id));
    for (const it of items) send({ type: 'apply', id: it.id, runId, entities: it.entities });
  }, [send]);

  const restart = useCallback(() => {
    worker.current?.terminate();
    setBusy(false);
    setPending([]);
    run.current++;
    setModels({ classic: 'carregando', ner: 'carregando', progress: 0 });
    boot();
  }, [boot]);

  /** Interrompe a análise e mantém arquivos (voltam para a fila). */
  const cancel = useCallback(() => {
    restart();
    setFiles((fs) => fs.map((f) => ({ id: f.id, file: f.file, status: 'fila', progress: 0, warnings: [] })));
  }, [restart]);

  /** Descarta tudo da memória. */
  const reset = useCallback(() => {
    restart();
    setFiles([]);
  }, [restart]);

  return useMemo(
    () => ({ files, models, busy, pending, addFiles, removeFile, analyze, redetect, applyAll, cancel, reset }),
    [files, models, busy, pending, addFiles, removeFile, analyze, redetect, applyAll, cancel, reset],
  );
}
