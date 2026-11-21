/**
 * Utilidades OOXML sem DOMParser (indisponível em Web Workers): varredura linear de tags.
 * Um "segmento" é o texto concatenado dos nós de texto de um parágrafo (<w:p>, <a:p>) ou
 * item de string compartilhada (<si>). O mascaramento reescreve os nós de texto preservando
 * os runs e a formatação: o rótulo entra no nó onde a entidade começa e os caracteres
 * seguintes da entidade são removidos, mesmo que estejam em outros runs.
 */
import type { Entity } from '../core/types';

export interface TextNode {
  /** posição do conteúdo (após a tag de abertura) no XML */
  contentStart: number;
  contentEnd: number;
  /** abertura da tag, para forçar xml:space="preserve" */
  openStart: number;
  openEnd: number;
  text: string;
}

export interface XmlSegment {
  nodes: TextNode[];
  text: string;
}

export function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
  });
}

export const encodeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Extrai segmentos. `paraTag` delimita segmentos (ex.: "w:p", "si", "a:p"); `textTag` é o nó de texto ("w:t", "t", "a:t").
 * Parágrafos aninhados (caixas de texto) viram segmentos próprios.
 */
export function extractSegments(xml: string, paraTag: string, textTag: string, keepEmpty = false): XmlSegment[] {
  const esc = (t: string) => t.replace(':', '\\:');
  const re = new RegExp(`<(/?)(${esc(paraTag)}|${esc(textTag)})(?=[\\s/>])([^>]*)>`, 'g');
  const stack: XmlSegment[] = [];
  const out: XmlSegment[] = [];
  let openText: { openStart: number; openEnd: number } | null = null;
  for (const m of xml.matchAll(re)) {
    const [whole, close, tag, attrs] = m as unknown as [string, string, string, string];
    const at = m.index ?? 0;
    const selfClosing = attrs.endsWith('/');
    if (tag === paraTag) {
      if (!close && !selfClosing) stack.push({ nodes: [], text: '' });
      else if (selfClosing && keepEmpty) out.push({ nodes: [], text: '' });
      else if (close) {
        const seg = stack.pop();
        if (seg) out.push(seg);
      }
    } else if (tag === textTag) {
      if (!close && !selfClosing) openText = { openStart: at, openEnd: at + whole.length };
      else if (close && openText) {
        const raw = xml.slice(openText.openEnd, at);
        // NFC: texto decomposto (comum em arquivos do macOS) casa com termos e regras; o nó alterado é reescrito já normalizado
        const node: TextNode = { contentStart: openText.openEnd, contentEnd: at, openStart: openText.openStart, openEnd: openText.openEnd, text: decodeXml(raw).normalize('NFC') };
        const seg = stack[stack.length - 1];
        if (seg) { seg.nodes.push(node); seg.text += node.text; }
        openText = null;
      }
    }
  }
  // para strings compartilhadas (<si>) o índice importa: segmentos vazios são mantidos
  return keepEmpty ? out : out.filter((s) => s.nodes.length);
}

/** Aplica máscaras de cada segmento ao XML. `masks[i]` usa offsets do texto do segmento i. */
export function applySegmentMasks(xml: string, segments: XmlSegment[], masks: Entity[][], textTag: string): string {
  return applyEdits(xml, segmentEdits(xml, segments, masks, textTag));
}

export type Edit = { start: number; end: number; value: string };

/** Edições (offsets do XML original) que aplicam as máscaras; combináveis com outras edições. */
export function segmentEdits(xml: string, segments: XmlSegment[], masks: Entity[][], textTag: string): Edit[] {
  const edits: Edit[] = [];
  segments.forEach((seg, i) => {
    const ents = (masks[i] ?? []).slice().sort((a, b) => a.start - b.start);
    if (!ents.length) return;
    let base = 0;
    for (const node of seg.nodes) {
      let out = '';
      let changed = false;
      for (let k = 0; k < node.text.length; k++) {
        const g = base + k;
        const e = ents.find((x) => g >= x.start && g < x.end);
        if (!e) { out += node.text[k]; continue; }
        changed = true;
        if (g === e.start) out += e.label;
      }
      base += node.text.length;
      if (!changed) continue;
      edits.push({ start: node.contentStart, end: node.contentEnd, value: encodeXml(out) });
      const open = xml.slice(node.openStart, node.openEnd);
      if (!/xml:space=/.test(open) && textTag === 'w:t') edits.push({ start: node.openStart, end: node.openEnd, value: open.replace(/\/?>$/, ' xml:space="preserve">') });
    }
  });
  return edits;
}

export function applyEdits(s: string, edits: { start: number; end: number; value: string }[]): string {
  let out = '';
  let pos = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    if (e.start < pos) continue;
    out += s.slice(pos, e.start) + e.value;
    pos = e.end;
  }
  return out + s.slice(pos);
}

/** Remove elementos (com conteúdo) cujo trecho satisfaz `pred`. Assume que o elemento não se aninha nele mesmo. */
export function removeElements(xml: string, tag: string, pred: (inner: string) => boolean = () => true): { xml: string; count: number } {
  const esc = tag.replace(':', '\\:');
  let count = 0;
  const re = new RegExp(`<${esc}(?=[\\s>/])[^>]*?(?:/>|>[\\s\\S]*?</${esc}>)`, 'g');
  const out = xml.replace(re, (m) => (pred(m) ? (count++, '') : m));
  return { xml: out, count };
}

/** Desembrulha elementos (mantém o conteúdo). */
export function unwrapElements(xml: string, tag: string): string {
  const esc = tag.replace(':', '\\:');
  return xml.replace(new RegExp(`<${esc}(?=[\\s>])[^>]*>`, 'g'), '').replace(new RegExp(`</${esc}>`, 'g'), '');
}

/** Esvazia o conteúdo de elementos simples (ex.: dc:creator) sem removê-los. */
export function blankElements(xml: string, tags: string[]): { xml: string; count: number } {
  let count = 0;
  for (const t of tags) {
    const esc = t.replace(':', '\\:');
    xml = xml.replace(new RegExp(`<${esc}(\\s[^>]*)?>[\\s\\S]*?</${esc}>`, 'g'), (m, attrs: string | undefined) => {
      if (m.replace(/<[^>]+>/g, '').trim()) count++;
      return `<${t}${attrs ?? ''}></${t}>`;
    });
  }
  return { xml, count };
}
