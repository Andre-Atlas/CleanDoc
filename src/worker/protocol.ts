import type { CleanReport, Entity, FileKind, UserTerm } from '../core/types';
import type { Stage } from '../detect/pipeline';

/** Mensagens UI → worker */
export type ToWorker =
  | { type: 'init' }
  | { type: 'analyze'; files: { id: string; name: string; buffer: ArrayBuffer }[]; terms: UserTerm[]; stripRasterWatermark?: boolean }
  | { type: 'redetect'; terms: UserTerm[] }
  | { type: 'apply'; id: string; runId: number; entities: Entity[] }
  | { type: 'reset' };

export type FileStage = 'ler' | 'ocr' | Stage | 'pronto';

/** Mensagens worker → UI */
export type FromWorker =
  | { type: 'models'; classic: 'ok' | 'erro'; ner: 'carregando' | 'ok' | 'indisponivel'; progress?: number }
  | { type: 'progress'; id: string; stage: FileStage; progress: number }
  | { type: 'analyzed'; id: string; kind: FileKind; text: string; entities: Entity[]; warnings: string[] }
  | { type: 'file-error'; id: string; runId?: number; code: 'formato' | 'senha' | 'corrompido' | 'interno'; message: string }
  | { type: 'cleaned'; id: string; runId: number; blob: Blob; fileName: string; report: CleanReport }
  | { type: 'done' };
