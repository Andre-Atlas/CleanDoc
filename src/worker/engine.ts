/**
 * Motor do worker, separado do `self.onmessage` para ser testável em Node.
 * Mantém os arquivos abertos SÓ em memória; `reset` descarta tudo.
 */
import { joinSegments, splitEntities } from '../core/segments';
import type { Entity, UserTerm } from '../core/types';
import { Crf, SpanClassifier, type ClassicModels, type CrfModel, type LogRegModel } from '../detect/crf';
import { toGazetteer, type GazetteerJson } from '../detect/features';
import { detectAll } from '../detect/pipeline';
import type { WordClassifier, WordLabel } from '../detect/transformer';
import { parseCsv } from '../formats/csv';
import { parseDocx } from '../formats/docx';
import { parseImage } from '../formats/image';
import type { OcrEngine } from '../formats/ocr';
import { parsePdf } from '../formats/pdf';
import { kindOf, MAX_FILE_BYTES, UnsupportedFileError, type ParsedFile } from '../formats/types';
import { parseXlsx } from '../formats/xlsx';
import type { FromWorker, ToWorker } from './protocol';

export interface EngineDeps {
  fetchJson: <T>(path: string) => Promise<T>;
  loadNer?: (onProgress: (p: number) => void) => Promise<WordClassifier>;
  ocr?: OcrEngine;
  post: (m: FromWorker) => void;
}

export const NER_TIMEOUT_MS = 180_000;

interface OpenFile { id: string; parsed: ParsedFile; text: string; starts: number[] }

/** Cache das inferências do transformer por janela, para re-detectar rápido quando o usuário adiciona termos. */
function cached(ner: WordClassifier): WordClassifier {
  const cache = new Map<string, WordLabel[]>();
  return {
    async classifyWords(words) {
      const k = words.join('\u0001');
      let r = cache.get(k);
      if (!r) { r = await ner.classifyWords(words); cache.set(k, r); }
      return r;
    },
  };
}

export class Engine {
  private classic?: ClassicModels;
  private ner?: WordClassifier;
  private nerPromise?: Promise<void>;
  private files: OpenFile[] = [];

  constructor(private readonly deps: EngineDeps) {}

  async handle(msg: ToWorker): Promise<void> {
    switch (msg.type) {
      case 'init': return this.init();
      case 'analyze': return this.analyze(msg.files, msg.terms, msg.stripRasterWatermark ?? true);
      case 'redetect': return this.detect(this.files, msg.terms);
      case 'apply': return this.apply(msg.id, msg.runId, msg.entities);
      case 'reset':
        this.files = [];
        await this.deps.ocr?.terminate();
        return;
    }
  }

  private async init() {
    if (this.classic) return;
    try {
      const [crf, logreg, gaz] = await Promise.all([
        this.deps.fetchJson<CrfModel>('crf.json'),
        this.deps.fetchJson<LogRegModel>('logreg.json'),
        this.deps.fetchJson<GazetteerJson>('gazetteer.json'),
      ]);
      this.classic = { crf: new Crf(crf), span: new SpanClassifier(logreg), gaz: toGazetteer(gaz) };
    } catch {
      this.deps.post({ type: 'models', classic: 'erro', ner: 'indisponivel' });
      return;
    }
    if (!this.deps.loadNer) { this.deps.post({ type: 'models', classic: 'ok', ner: 'indisponivel' }); return; }
    this.deps.post({ type: 'models', classic: 'ok', ner: 'carregando', progress: 0 });
    // Se o transformer não ficar pronto a tempo, segue sem ele (as outras camadas cobrem) em vez de travar a análise.
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), NER_TIMEOUT_MS));
    this.nerPromise = Promise.race([this.deps.loadNer((p) => this.deps.post({ type: 'models', classic: 'ok', ner: 'carregando', progress: p })), timeout])
      .then((n) => { this.ner = cached(n); this.deps.post({ type: 'models', classic: 'ok', ner: 'ok', progress: 1 }); })
      .catch(() => this.deps.post({ type: 'models', classic: 'ok', ner: 'indisponivel' }));
  }

  private async analyze(files: { id: string; name: string; buffer: ArrayBuffer }[], terms: UserTerm[], stripRasterWatermark = true) {
    if (!this.classic) await this.init();
    const opened: OpenFile[] = [];
    for (const f of files) {
      this.deps.post({ type: 'progress', id: f.id, stage: 'ler', progress: 0.05 });
      try {
        if (f.buffer.byteLength > MAX_FILE_BYTES) throw new UnsupportedFileError('Arquivo grande demais (limite de 500 MB).', 'formato');
        const kind = kindOf(f.name, new Uint8Array(f.buffer.slice(0, 12)));
        if (!kind) throw new UnsupportedFileError('Formato não suportado. Use PDF, DOCX, XLSX, CSV ou imagens (PNG/JPG/WEBP).', 'formato');
        const parsed =
          kind === 'pdf'
            ? await parsePdf(f.name, f.buffer, {
                ocr: this.deps.ocr,
                stripRasterWatermark,
                onPageProgress: (p, total) =>
                  this.deps.post({ type: 'progress', id: f.id, stage: 'ocr', progress: 0.05 + 0.1 * (p / Math.max(1, total)) }),
              })
            : kind === 'image'
              ? await (async () => {
                  this.deps.post({ type: 'progress', id: f.id, stage: 'ocr', progress: 0.08 });
                  return parseImage(f.name, f.buffer, { ocr: this.deps.ocr, stripRasterWatermark });
                })()
              : kind === 'docx'
                ? await parseDocx(f.name, f.buffer)
                : kind === 'xlsx'
                  ? await parseXlsx(f.name, f.buffer)
                  : await parseCsv(f.name, f.buffer);
        const { text, starts } = joinSegments(parsed.segments);
        opened.push({ id: f.id, parsed, text, starts });
      } catch (e) {
        const code = e instanceof UnsupportedFileError ? e.code : 'corrompido';
        const message = e instanceof UnsupportedFileError ? e.message : 'Não foi possível ler o arquivo. Ele pode estar corrompido.';
        this.deps.post({ type: 'file-error', id: f.id, code, message });
      }
    }
    // espera o transformer se ainda está baixando (a primeira vez); as outras camadas já estão prontas
    if (this.nerPromise) await this.nerPromise;
    this.files = [...this.files.filter((o) => !opened.some((n) => n.id === o.id)), ...opened];
    await this.detect(this.files, terms);
  }

  private async detect(files: OpenFile[], terms: UserTerm[]) {
    const stageProgress = { termos: 0.15, regras: 0.25, crf: 0.4, transformer: 0.6, nlu: 0.85 } as const;
    try {
      const ents = await detectAll(
        files.map((f) => f.text),
        {
          terms,
          classic: this.classic,
          ner: this.ner,
          onStage: (stage, i) => { const f = files[i]; if (f) this.deps.post({ type: 'progress', id: f.id, stage, progress: stageProgress[stage] }); },
        },
      );
      files.forEach((f, i) => {
        let entities = ents[i] ?? [];
        if (f.parsed.augment) {
          const per = f.parsed.augment(splitEntities(entities, f.parsed.segments, f.starts));
          entities = per.flatMap((es, k) => es.map((e) => ({ ...e, start: e.start + f.starts[k]!, end: e.end + f.starts[k]! })));
        }
        this.deps.post({ type: 'progress', id: f.id, stage: 'pronto', progress: 1 });
        this.deps.post({ type: 'analyzed', id: f.id, kind: f.parsed.kind, text: f.text, entities, warnings: f.parsed.warnings });
      });
    } catch {
      // nunca deixa a UI presa: cada arquivo recebe erro explícito
      for (const f of files) this.deps.post({ type: 'file-error', id: f.id, code: 'interno', message: 'Falha na detecção. Tente de novo; se persistir, processe este arquivo sozinho.' });
    } finally {
      this.deps.post({ type: 'done' });
    }
  }

  private async apply(id: string, runId: number, entities: Entity[]) {
    const f = this.files.find((x) => x.id === id);
    if (!f) { this.deps.post({ type: 'file-error', id, runId, code: 'interno', message: 'Arquivo não está mais na memória. Adicione de novo.' }); return; }
    try {
      const res = await f.parsed.apply(splitEntities(entities, f.parsed.segments, f.starts));
      this.deps.post({ type: 'cleaned', id, runId, ...res });
    } catch {
      this.deps.post({ type: 'file-error', id, runId, code: 'interno', message: 'Falha ao gerar o arquivo limpo.' });
    }
  }
}
