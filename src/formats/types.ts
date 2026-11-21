import { fold } from '../core/text';
import type { CleanResult, Entity, FileKind } from '../core/types';

/** Um arquivo aberto: segmentos de texto para a detecção e uma função que gera o arquivo limpo. */
export interface ParsedFile {
  kind: FileKind;
  name: string;
  segments: string[];
  warnings: string[];
  /** Ajuste específico do formato após a detecção (ex.: inferência por coluna em tabelas). */
  augment?(masks: Entity[][]): Entity[][];
  apply(masks: Entity[][]): Promise<CleanResult>;
}

export class UnsupportedFileError extends Error {
  constructor(message: string, readonly code: 'formato' | 'senha' | 'corrompido') {
    super(message);
  }
}

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/** Nome do arquivo limpo. Termos mascarados no conteúdo também saem do nome (ex.: "Contrato_Joao_Silva.pdf"). */
export function cleanName(name: string, entities: Entity[] = []): string {
  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const words = [...new Set(entities.flatMap((e) => e.text.split(/[\s_.,;:/\\-]+/)).filter((w) => w.length >= 3).map((w) => fold(w)))];
  if (words.length) {
    const folded = fold(base);
    let out = '';
    for (const m of base.matchAll(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu)) {
      const tok = m[0];
      const f = folded.slice(m.index ?? 0, (m.index ?? 0) + tok.length);
      out += words.includes(f) ? 'X' : tok;
    }
    base = out.replace(/X(?:[\s_-]*X)+/g, 'X');
  }
  return `${base}_limpo${ext}`;
}

export function kindOf(name: string, head: Uint8Array): FileKind | null {
  const ext = name.toLowerCase().split('.').pop();
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  const isOle = head[0] === 0xd0 && head[1] === 0xcf; // OOXML criptografado com senha vira OLE
  if (isOle && (ext === 'docx' || ext === 'xlsx')) throw new UnsupportedFileError('Arquivo protegido por senha. Remova a senha e adicione de novo.', 'senha');
  if (ext === 'pdf' && isPdf) return 'pdf';
  if (ext === 'docx' && isZip) return 'docx';
  if (ext === 'xlsx' && isZip) return 'xlsx';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  return null;
}
