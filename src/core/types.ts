/** Contratos centrais do Doc Cleaner. Toda camada de detecção, formato e UI fala por estes tipos. */

export const CATEGORIES = [
  'pessoa',
  'empresa',
  'local',
  'valor',
  'documento',
  'contato',
  'bancario',
  'outro',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_NAMES: Record<Category, string> = {
  pessoa: 'Pessoas',
  empresa: 'Empresas',
  local: 'Locais',
  valor: 'Valores',
  documento: 'Documentos',
  contato: 'Contatos',
  bancario: 'Bancários',
  outro: 'Outros',
};

/** Rótulo padrão por categoria; subtipos (CPF, e-mail…) sobrescrevem via `Entity.label`. */
export const DEFAULT_LABEL: Record<Category, string> = {
  pessoa: '[nome pessoal]',
  empresa: '[empresa]',
  local: '[local]',
  valor: '[valor]',
  documento: '[documento]',
  contato: '[contato]',
  bancario: '[dado bancário]',
  outro: '[informação]',
};

/** Quem detectou. Camadas 0–1 são de alta precisão; 2–4 são estatísticas. */
export type DetectorSource = 'termo' | 'regra' | 'crf' | 'logreg' | 'transformer' | 'nlu' | 'propagacao';

export const HIGH_PRECISION_SOURCES: ReadonlySet<DetectorSource> = new Set(['termo', 'regra']);

export interface Detection {
  source: DetectorSource;
  /** 0..1 */
  confidence: number;
}

/** Trecho a mascarar, em offsets de caractere (UTF-16) do texto analisado. `end` exclusivo. */
export interface Entity {
  start: number;
  end: number;
  text: string;
  category: Category;
  label: string;
  detections: Detection[];
  /** Confiança fundida 0..1 */
  confidence: number;
}

/** Saída crua de um detector, antes da fusão. */
export interface Candidate {
  start: number;
  end: number;
  category: Category;
  label?: string;
  source: DetectorSource;
  confidence: number;
}

/** Termo informado pelo usuário num campo da interface. */
export interface UserTerm {
  text: string;
  category: Category;
  /** Rótulo livre para a categoria "outro" (ex.: "[projeto]"). */
  label?: string;
}

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'csv';

export interface MetadataRemoval {
  /** Descrição legível sem valores originais, ex.: "Autor e empresa do arquivo". */
  description: string;
  count: number;
}

export interface CleanReport {
  fileName: string;
  kind: FileKind;
  entities: { category: Category; label: string; count: number }[];
  maskedCount: number;
  metadata: MetadataRemoval[];
  watermarksRemoved: number;
  warnings: string[];
}

export interface CleanResult {
  blob: Blob;
  fileName: string;
  report: CleanReport;
}
