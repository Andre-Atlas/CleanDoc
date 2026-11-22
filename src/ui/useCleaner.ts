import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CleanReport, Entity, FileKind, UserTerm } from '../core/types';
import { MAX_FILE_BYTES, UnsupportedFileError } from '../formats/types';
import { extractZipFiles } from '../formats/zip';
import type { FileStage, FromWorker, ToWorker } from '../worker/protocol';

export type FileStatus = 'fila' | 'processando' | 'pronto' | 'erro';

export interface FileRejection {
  name: string;
  reason: 'formato' | 'tamanho' | 'duplicado' | 'zip';
  detail?: string;
}

export interface FileItem {
  id: string;
  file: File;
  /** Caminho relativo original quando extraído de um .zip (ex.: "pasta/contrato.pdf"). */
  relativePath?: string;
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

const ACCEPT = /\.(pdf|docx|xlsx|csv|png|jpe?g|webp|zip)$/i;
export const MAX_BYTES = MAX_FILE_BYTES;
export const MAX_QUEUE_BYTES = 1024 * 1024 * 1024; // 1 GB somado na fila para evitar OOM no worker

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
  const filesRef = useRef<FileItem[]>(files);
  useEffect(() => { filesRef.current = files; }, [files]);
  const addQueueRef = useRef<Promise<unknown>>(Promise.resolve());
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

  /** Adiciona arquivos à fila (serializado, descompactando .zip com segurança); devolve os rejeitados com motivo. */
  const addFiles = useCallback((list: File[]): Promise<FileRejection[]> => {
    const myGen = gen.current;
    const task = addQueueRef.current.then(async (): Promise<FileRejection[]> => {
      if (myGen !== gen.current) return [];
      const rejected: FileRejection[] = [];
      const ok: FileItem[] = [];
      let queueBytes = filesRef.current.reduce((s, f) => s + f.file.size, 0);

      const pushItem = (file: File, relativePath?: string) => {
        const displayName = relativePath ?? file.name;
        if (file.size > MAX_BYTES) {
          rejected.push({ name: displayName, reason: 'tamanho' });
        } else if (queueBytes + file.size > MAX_QUEUE_BYTES) {
          rejected.push({ name: displayName, reason: 'tamanho', detail: 'limite total de 1 GB na fila atingido' });
        } else if ([...filesRef.current, ...ok].some((f) => (f.relativePath ?? f.file.name) === displayName && f.file.size === file.size)) {
          rejected.push({ name: displayName, reason: 'duplicado' });
        } else {
          queueBytes += file.size;
          ok.push({ id: `f${++seq}`, file, relativePath, status: 'fila', progress: 0, warnings: [] });
        }
      };

      for (const file of list) {
        if (myGen !== gen.current) return [];
        if (!ACCEPT.test(file.name)) {
          rejected.push({ name: file.name, reason: 'formato' });
          continue;
        }
        if (file.size > MAX_BYTES) {
          rejected.push({ name: file.name, reason: 'tamanho' });
          continue;
        }
        if (/\.zip$/i.test(file.name)) {
          try {
            const { files: inner, skipped } = await extractZipFiles(await file.arrayBuffer(), file.name);
            if (myGen !== gen.current) return [];
            if (!inner.length) {
              rejected.push({
                name: file.name,
                reason: 'zip',
                detail: 'nenhum arquivo suportado encontrado dentro do ZIP',
              });
              continue;
            }
            for (const entry of inner) pushItem(entry.file, entry.relativePath);
            if (skipped.length) {
              rejected.push({
                name: file.name,
                reason: 'zip',
                detail: `${skipped.length} ${skipped.length === 1 ? 'item não suportado ignorado' : 'itens não suportados ignorados'} dentro do ZIP`,
              });
            }
          } catch (e) {
            if (myGen !== gen.current) return [];
            rejected.push({
              name: file.name,
              reason: 'zip',
              detail: e instanceof UnsupportedFileError ? e.message : 'não foi possível descompactar o ZIP',
            });
          }
        } else {
          pushItem(file);
        }
      }
      if (myGen !== gen.current) return [];
      if (ok.length) {
        const next = [...filesRef.current, ...ok];
        filesRef.current = next;
        setFiles(next);
      }
      return rejected;
    });
    addQueueRef.current = task.catch(() => {});
    return task;
  }, []);

  const removeFile = useCallback((id: string) => setFiles((fs) => fs.filter((f) => f.id !== id)), []);

  const analyze = useCallback(async (terms: UserTerm[], opts: { stripRasterWatermark?: boolean } = {}) => {
    const pendingFiles = filesRef.current.filter((f) => f.status === 'fila' || f.status === 'erro');
    if (!pendingFiles.length) return;
    const myGen = gen.current;
    setBusy(true);
    setFiles((fs) => fs.map((f) => (pendingFiles.some((p) => p.id === f.id) ? { ...f, status: 'processando', progress: 0.02, error: undefined } : f)));
    let payload: { id: string; name: string; buffer: ArrayBuffer }[];
    try {
      payload = await Promise.all(pendingFiles.map(async (f) => ({ id: f.id, name: f.file.name, buffer: await f.file.arrayBuffer() })));
    } catch {
      if (myGen !== gen.current) return;
      setBusy(false);
      setFiles((fs) => fs.map((f) => (pendingFiles.some((p) => p.id === f.id) ? { ...f, status: 'erro', error: 'Não foi possível ler o arquivo do disco.' } : f)));
      return;
    }
    if (myGen !== gen.current) return; // cancelado durante a leitura
    send({ type: 'analyze', files: payload, terms, stripRasterWatermark: opts.stripRasterWatermark ?? true }, payload.map((p) => p.buffer));
  }, [send]);

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
    setFiles((fs) => fs.map((f) => ({ id: f.id, file: f.file, relativePath: f.relativePath, status: 'fila', progress: 0, warnings: [] })));
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
