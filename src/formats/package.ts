/** Operações comuns a pacotes OPC (DOCX/XLSX): partes, relações, propriedades, mídia e autoverificação. */
import JSZip from 'jszip';
import { fold } from '../core/text';
import type { Entity, MetadataRemoval } from '../core/types';
import { blankElements, decodeXml, extractSegments, removeElements, segmentEdits, type Edit, type XmlSegment } from './ooxml';
import { stripImage } from './images';
import { UnsupportedFileError } from './types';

export const FIXED_DATE = new Date(Date.UTC(2000, 0, 1));

/** Limites contra zip bomb: descompactado total e número de entradas. */
export const MAX_UNCOMPRESSED = 1024 * 1024 * 1024;
export const MAX_ENTRIES = 5000;

/** Passes de texto: [elemento que delimita o segmento, elemento de texto]. */
export const TEXT_PASSES: [string, string][] = [
  ['w:p', 'w:t'], // parágrafos do Word (inclui caixas de texto)
  ['a:p', 'a:t'], // DrawingML: formas, SmartArt, títulos de gráficos
  ['m:oMath', 'm:t'], // equações
  ['c:pt', 'c:v'], // caches de dados de gráficos
];

/** Uma parte XML aberta com todos os segmentos de texto de todos os passes. */
export interface TextPart {
  path: string;
  xml: string;
  passes: { textTag: string; segs: XmlSegment[] }[];
}

export function openTextPart(path: string, xml: string, passes = TEXT_PASSES): TextPart {
  return { path, xml, passes: passes.map(([para, text]) => ({ textTag: text, segs: extractSegments(xml, para, text) })).filter((p) => p.segs.length) };
}

export const partSegments = (p: TextPart) => p.passes.flatMap((x) => x.segs.map((s) => s.text));
export const partSegCount = (p: TextPart) => p.passes.reduce((n, x) => n + x.segs.length, 0);

/** Edições de todos os passes de uma parte (offsets do XML original; passes não se sobrepõem). */
export function partEdits(p: TextPart, masks: Entity[][]): Edit[] {
  const edits: Edit[] = [];
  let k = 0;
  for (const pass of p.passes) {
    edits.push(...segmentEdits(p.xml, pass.segs, masks.slice(k, k + pass.segs.length), pass.textTag));
    k += pass.segs.length;
  }
  return edits;
}

export class OpcPackage {
  readonly removals = new Map<string, number>();
  private constructor(readonly zip: JSZip) {}

  static async load(buf: ArrayBuffer): Promise<OpcPackage> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      throw new UnsupportedFileError('Arquivo corrompido ou inválido.', 'corrompido');
    }
    const entries = Object.values(zip.files);
    const size = entries.reduce((s, f) => s + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
    if (entries.length > MAX_ENTRIES || size > MAX_UNCOMPRESSED)
      throw new UnsupportedFileError('Arquivo grande demais depois de descompactado (limite de 1 GB).', 'corrompido');
    return new OpcPackage(zip);
  }

  note(description: string, count = 1) {
    if (count > 0) this.removals.set(description, (this.removals.get(description) ?? 0) + count);
  }

  files(re: RegExp): string[] {
    return Object.keys(this.zip.files).filter((p) => re.test(p) && !this.zip.files[p]!.dir);
  }

  async read(path: string): Promise<string> {
    return (await this.zip.file(path)?.async('string')) ?? '';
  }

  write(path: string, content: string | Uint8Array) {
    this.zip.file(path, content, { date: FIXED_DATE });
  }

  /** Remove a parte, as relações que apontam para ela e o override de content type. */
  async removePart(path: string) {
    if (!this.zip.file(path)) return false;
    this.zip.remove(path);
    const base = path.split('/').pop()!;
    for (const rels of this.files(/\.rels$/)) {
      const xml = await this.read(rels);
      const r = removeElements(xml, 'Relationship', (el) => new RegExp(`Target="[^"]*/?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(el));
      if (r.count) this.write(rels, r.xml);
    }
    const ct = await this.read('[Content_Types].xml');
    const r = removeElements(ct, 'Override', (el) => el.includes(`PartName="/${path}"`));
    if (r.count) this.write('[Content_Types].xml', r.xml);
    const rel = path.replace(/([^/]+)$/, '_rels/$1.rels');
    this.zip.remove(rel);
    return true;
  }

  /** Remove partes por padrão e anota. */
  async removeParts(re: RegExp, description: string) {
    let n = 0;
    for (const p of this.files(re)) if (await this.removePart(p)) n++;
    this.note(description, n);
    return n;
  }

  /** Limpa docProps (core, app, custom, miniatura) e customXml. */
  async cleanProperties() {
    const core = await this.read('docProps/core.xml');
    if (core) {
      const r = blankElements(core, ['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'cp:keywords', 'dc:description', 'cp:category', 'cp:contentStatus', 'dc:identifier', 'cp:version', 'cp:revision', 'cp:lastPrinted']);
      let xml = r.xml.replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, '$12000-01-01T00:00:00Z$2');
      xml = xml.replace(/<cp:lastPrinted><\/cp:lastPrinted>/g, '');
      this.write('docProps/core.xml', xml);
      this.note('Autor, título e datas do arquivo', r.count + 1);
    }
    const app = await this.read('docProps/app.xml');
    if (app) {
      const r = blankElements(app, ['Company', 'Manager', 'Template', 'HyperlinkBase']);
      // TitlesOfParts/HeadingPairs listam nomes de abas, títulos e partes
      let xml = removeElements(r.xml, 'TitlesOfParts').xml;
      xml = removeElements(xml, 'HeadingPairs').xml;
      this.write('docProps/app.xml', xml.replace(/<TotalTime>\d+<\/TotalTime>/, '<TotalTime>0</TotalTime>'));
      this.note('Empresa, gestor, modelo e lista de partes do arquivo', r.count + 1);
    }
    if (await this.removePart('docProps/custom.xml')) this.note('Propriedades personalizadas');
    await this.removeParts(/^docProps\/thumbnail\.\w+$/, 'Miniatura da primeira página');
    const custom = this.files(/^customXml\//);
    for (const p of custom) await this.removePart(p);
    if (custom.length) this.note('Metadados de servidor (customXml)', 1);
  }

  /** Remove relações de imagem/link/objeto que a parte não usa mais (ex.: marca d'água removida). */
  async pruneRels(partPath: string, xml: string) {
    const relsPath = partPath.replace(/([^/]+)$/, '_rels/$1.rels');
    const rels = await this.read(relsPath);
    if (!rels) return;
    const r = removeElements(rels, 'Relationship', (el) => {
      if (!/Type="[^"]*\/(?:image|hyperlink|oleObject|package|video|audio|media)"/.test(el)) return false;
      const id = /\bId="([^"]+)"/.exec(el)?.[1];
      return !!id && !xml.includes(`"${id}"`);
    });
    if (r.count) this.write(relsPath, r.xml);
  }

  /** Apaga mídia que nenhuma relação referencia mais. */
  async removeOrphanMedia(dir: RegExp) {
    const allRels = (await Promise.all(this.files(/\.rels$/).map((p) => this.read(p)))).join('\n');
    let n = 0;
    for (const p of this.files(dir)) {
      const base = p.split('/').pop()!;
      if (!allRels.includes(base)) { this.zip.remove(p); n++; }
    }
    this.note('Imagens que não eram mais usadas (ex.: marca d\'água)', n);
  }

  async stripMedia(dir: RegExp) {
    let n = 0;
    for (const p of this.files(dir)) {
      const data = await this.zip.file(p)!.async('uint8array');
      const r = stripImage(p, data);
      if (r.removed) { this.write(p, r.data); n++; }
    }
    this.note('EXIF/GPS de imagens JPEG/PNG', n);
  }

  /** Alvos externos nas relações (mailto:, URLs, caminhos C:\Users\…) são neutralizados. */
  async neutralizeExternalLinks() {
    let n = 0;
    for (const rels of this.files(/\.rels$/)) {
      const xml = await this.read(rels);
      const out = xml.replace(/<Relationship\b[^>]*>/g, (el) => {
        if (!/TargetMode="External"/.test(el)) return el;
        n++;
        return el.replace(/Target="[^"]*"/, 'Target="#removido"');
      });
      if (out !== xml) this.write(rels, out);
    }
    this.note('Destinos externos (e-mails, URLs, caminhos de arquivo)', n);
  }

  /** Remove atributos de rastreio de edição e de autoria. */
  static stripTracking(xml: string): string {
    return xml.replace(/\s(?:w:rsid\w*|w14:paraId|w14:textId|xr:uid|xr\d*:uid|w:author|w:initials|w:date|w16du:dateUtc|w:ed)="[^"]*"/g, '');
  }

  /** Atributos com texto livre: alt text, títulos de objetos, nomes de controles de conteúdo. */
  static stripAttributes(xml: string): string {
    return xml
      .replace(/\s(?:descr|title)="[^"]*"/g, (m, offset: number) => (/<[\w:]*(?:docPr|cNvPr)\b[^>]*$/.test(xml.slice(Math.max(0, offset - 400), offset)) ? '' : m))
      .replace(/(<w:(?:alias|tag)\b[^>]*\sw:val=")[^"]*"/g, '$1"');
  }

  /**
   * Autoverificação: procura o texto de cada entidade mascarada (≥ 4 caracteres) em todas as partes do pacote.
   * Devolve as partes onde algo sobrou.
   */
  async verify(entities: Entity[]): Promise<string[]> {
    const needles = [...new Set(entities.map((e) => fold(e.text.trim())).filter((t) => t.replace(/\W/g, '').length >= 4))];
    if (!needles.length) return [];
    const hits: string[] = [];
    for (const p of this.files(/\.(xml|rels|vml)$/)) {
      const txt = fold(decodeXml(await this.read(p)));
      if (needles.some((n) => txt.includes(n))) hits.push(p);
    }
    return hits;
  }

  report(): MetadataRemoval[] {
    return [...this.removals].map(([description, count]) => ({ description, count }));
  }

  async toBlob(mime: string): Promise<Blob> {
    (this.zip as unknown as { comment?: string }).comment = '';
    for (const f of Object.values(this.zip.files)) {
      f.date = FIXED_DATE;
      (f as unknown as { comment?: string }).comment = '';
    }
    const data = await this.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, comment: '', platform: 'DOS' });
    return new Blob([data as BlobPart], { type: mime });
  }
}
