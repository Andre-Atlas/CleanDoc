import { fold } from '../core/text';
import type { Candidate, Category, Entity } from '../core/types';

/**
 * Camada 4: NLU PT-BR. Usa pistas linguísticas (tratamentos, papéis contratuais,
 * sufixos societários, preposições de lugar) para propor entidades, e propaga
 * entidades já aceitas para todas as ocorrências.
 */

// Sequência de palavras capitalizadas com partículas internas (da, de, dos…).
const NAME = String.raw`(?<!\p{L})\p{Lu}[\p{L}\p{M}'’-]+(?:[^\S\n]{1,3}(?:(?:d[aeo]s?|e)[^\S\n]{1,3})?\p{Lu}[\p{L}\p{M}'’-]+){0,6}`;
const CAP_SEQ = String.raw`(?<!\p{L})\p{Lu}[\p{L}\p{M}&'’.-]*(?:[^\S\n]{1,3}(?:(?:d[aeo]s?|e|&)[^\S\n]{1,3})?[\p{Lu}\d][\p{L}\p{M}&'’.\d-]*){0,7}`;

interface Pattern {
  re: RegExp;
  category: Category;
  confidence: number;
}

const PATTERNS: Pattern[] = [
  // Tratamentos: mascara o nome, mantém o título.
  { re: new RegExp(String.raw`(?<=\b(?:Sr|Sra|Srta|Dr|Dra|Prof|Profa|Eng|Exmo|Exma|Ilmo|Ilma|Des|Min)\.?[^\S\n]{1,3})${NAME}`, 'gu'), category: 'pessoa', confidence: 0.9 },
  { re: new RegExp(String.raw`(?<=\b(?:Senhor|Senhora|Doutor|Doutora|Professor|Professora|Advogad[oa]|Engenheir[oa]|Testemunha|Requerente|Requerid[oa]|Autor|Autora|Réu|Ré|Paciente|Cliente|Locador[a]?|Locatári[oa]|Contratante|Contratad[oa]|Fiador[a]?|Outorgante|Outorgad[oa]|Herdeir[oa]|Cônjuge|Sóci[oa])[^\S\n]{0,3}:?[^\S\n]{1,3})${NAME}`, 'gu'), category: 'pessoa', confidence: 0.75 },
  { re: new RegExp(String.raw`(?<=\b(?:representad[oa]s?[^\S\n]{1,3}(?:legalmente[^\S\n]{1,3})?(?:por|pel[oa])|assinad[oa][^\S\n]{1,3}por|em[^\S\n]{1,3}nome[^\S\n]{1,3}de|aos[^\S\n]{1,3}cuidados[^\S\n]{1,3}de|a/c|At\.?|Atenciosamente,?|Eu,)[^\S\n]{1,3}(?:(?:Sr|Sra|Dr|Dra)\.?[^\S\n]{1,3})?)${NAME}`, 'gu'), category: 'pessoa', confidence: 0.85 },
  { re: new RegExp(String.raw`(?<=\b(?:filh[oa][^\S\n]{1,3}de|casad[oa][^\S\n]{1,3}com|viúv[oa][^\S\n]{1,3}de|neto[^\S\n]{1,3}de|neta[^\S\n]{1,3}de|mãe|pai)[^\S\n]{0,3}:?[^\S\n]{1,3})${NAME}`, 'gu'), category: 'pessoa', confidence: 0.85 },
  // Empresas e instituições
  { re: new RegExp(String.raw`${CAP_SEQ}[^\S\n]{0,3},?[^\S\n]{1,3}(?:Ltda\.?|LTDA\.?|S\.?[^\S\n]?/?[^\S\n]?A\.?|S/A|ME|EPP|EIRELI|Eireli|Cia\.?|Limitada)(?![\p{L}])`, 'gu'), category: 'empresa', confidence: 0.95 },
  { re: new RegExp(String.raw`\b(?:Banco|Construtora|Incorporadora|Instituto|Universidade|Faculdade|Escola|Colégio|Hospital|Clínica|Laboratório|Fundação|Associação|Cooperativa|Sindicato|Federação|Confederação|Grupo|Companhia|Indústria|Indústrias|Comércio|Transportadora|Distribuidora|Editora|Agropecuária|Mineradora|Seguradora|Corretora|Imobiliária|Consultoria|Agência|Restaurante|Farmácia|Supermercado|Loja|Escritório|Igreja|Prefeitura|Secretaria|Ministério|Tribunal|Câmara|Assembleia|Defensoria|Procuradoria|Promotoria|Delegacia|Cartório|Tabelionato|Conselho|Autarquia|Departamento|Superintendência|Diretoria|Gerência|Coordenação)[^\S\n]{1,3}(?:(?:d[aeo]s?|of|de)[^\S\n]{1,3})?${CAP_SEQ}`, 'gu'), category: 'empresa', confidence: 0.8 },
  { re: /\b[A-Z][A-Z&]{2,}(?:[^\S\n]{1,3}[A-Z][A-Z&]{1,})*[^\S\n]{1,3}(?:LTDA|S\/?A|ME|EPP|EIRELI)\b/g, category: 'empresa', confidence: 0.95 },
  // Locais
  { re: new RegExp(String.raw`(?<=\b(?:[Cc]idade|[Mm]unic[ií]pio|[Cc]omarca|[Ee]stado|[Bb]airro|[Dd]istrito|[Rr]egi[aã]o|[Vv]ila|[Pp]ovoado|[Ff]azenda|[Ss][ií]tio|[Cc]h[aá]cara|[Cc]ondom[ií]nio|[Ee]dif[ií]cio|[Rr]esidencial|[Ll]oteamento|[Ll]ocalidade)[^\S\n]{1,3}(?:de[^\S\n]{1,3}|do[^\S\n]{1,3}|da[^\S\n]{1,3})?)${CAP_SEQ}`, 'gu'), category: 'local', confidence: 0.85 },
  { re: new RegExp(String.raw`\b${NAME}[^\S\n]?/[^\S\n]?(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b`, 'gu'), category: 'local', confidence: 0.9 },
  { re: new RegExp(String.raw`(?<=\b(?:residente[^\S\n]{1,3}e[^\S\n]{1,3}domiciliad[oa][^\S\n]{1,3}(?:em|na|no)|domiciliad[oa][^\S\n]{1,3}(?:em|na|no)|sediad[oa][^\S\n]{1,3}(?:em|na|no)|com[^\S\n]{1,3}sede[^\S\n]{1,3}(?:em|na|no)|natural[^\S\n]{1,3}de|nascid[oa][^\S\n]{1,3}em|situad[oa][^\S\n]{1,3}(?:em|na|no|à|ao)|localizad[oa][^\S\n]{1,3}(?:em|na|no|à|ao)|sit[oa][^\S\n]{1,3}(?:em|na|no|à|ao)|filial[^\S\n]{1,3}de|unidade[^\S\n]{1,3}de|sucursal[^\S\n]{1,3}de|escritório[^\S\n]{1,3}de|fábrica[^\S\n]{1,3}de|obra[^\S\n]{1,3}de|ag[eê]ncia[^\S\n]{1,3}de)[^\S\n]{1,3})${CAP_SEQ}`, 'gu'), category: 'local', confidence: 0.85 },
  // Endereço genérico: sequência capitalizada seguida de ", número" (ex.: "Núcleo da Mata, 2199")
  { re: new RegExp(String.raw`(?<=\b(?:na|no|em|à|ao)[^\S\n]{1,3})${CAP_SEQ},[^\S\n]{0,3}(?:n[º°o.]*[^\S\n]{0,3})?\d{1,5}[A-Za-z]?\b`, 'gu'), category: 'local', confidence: 0.6 },
  // Empresa por papel: "fornecedor Novaes", "a empresa Guerra", "filial ... da Guerra faturou"
  { re: new RegExp(String.raw`(?<=\b(?:fornecedor[a]?|empresa|cliente|parceir[oa]|contratad[oa]|contratante|prestador[a]?|distribuidor[a]?|fabricante|loja|marca|startup|holding|grupo|banco|operadora|seguradora|construtora|transportadora|razão social|nome fantasia)[^\S\n]{0,3}:?[^\S\n]{1,3})(?:d[aeo]s?[^\S\n]{1,3})?${CAP_SEQ}`, 'gu'), category: 'empresa', confidence: 0.7 },
  // Sobrenome com partícula no início da frase seguido de verbo institucional ("O da Luz informa")
  { re: new RegExp(String.raw`(?<=(?:^|[.!?][^\S\n]{1,3}|\n)(?:O|A)[^\S\n]{1,3})d[aeo]s?[^\S\n]{1,3}${CAP_SEQ}(?=[^\S\n]{1,3}(?:informa|comunica|declara|esclarece|notifica|avisa|solicita|confirma|anuncia|lamenta)\b)`, 'gu'), category: 'empresa', confidence: 0.7 },
  { re: new RegExp(String.raw`(?<=\b(?:acordo|contrato|parceria|ajuste|convênio)[^\S\n]{1,3}(?:entre[^\S\n]{1,3})?)(?:d[aeo]s?[^\S\n]{1,3})?${CAP_SEQ}(?=[^\S\n]{0,3},[^\S\n]{0,3}(?:CNPJ|inscrit[ao]))`, 'gu'), category: 'empresa', confidence: 0.8 },
  { re: new RegExp(String.raw`(?<=\b(?:filial|unidade|sucursal|matriz|sede)[^\S\n]{1,3}de[^\S\n]{1,3}${CAP_SEQ}(?:[^\S\n]?/[^\S\n]?[A-Z]{2})?[^\S\n]{1,3}d[ao][^\S\n]{1,3})${CAP_SEQ}`, 'gu'), category: 'empresa', confidence: 0.75 },
  { re: new RegExp(String.raw`(?<=(?:^|[.!?][^\S\n]{1,3}|\n)(?:O|A)[^\S\n]{1,3})${CAP_SEQ}(?=[^\S\n]{1,3}(?:informa|comunica|declara|esclarece|notifica|avisa|solicita|confirma|anuncia|lamenta)\b)`, 'gu'), category: 'empresa', confidence: 0.7 },
];

const LOWER_STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/** Remove partículas e pontuação finais, preservando o ponto de abreviações societárias. */
function trimTail(s: string): string {
  const t = s.replace(/(?:\s+(?:d[aeo]s?|e))+$/u, '');
  if (/\b(?:Ltda|LTDA|Cia|S\.A|S\/A)\.$/u.test(t)) return t;
  return t.replace(/[\s,.;:]+$/u, '');
}

export function detectNlu(text: string, firstNames?: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const start = m.index ?? 0;
      const end = start + trimTail(m[0]).length;
      if (end - start < 2) continue;
      out.push({ start, end, category: p.category, source: 'nlu', confidence: p.confidence });
    }
  }
  if (firstNames?.size) out.push(...detectByFirstName(text, firstNames));
  return out;
}

/** Sequência capitalizada iniciada por um primeiro nome conhecido (gazetteer) com ≥ 2 nomes. */
function detectByFirstName(text: string, firstNames: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  const re = new RegExp(NAME, 'gu');
  for (const m of text.matchAll(re)) {
    const words = m[0].split(/\s+/).filter((w) => !LOWER_STOP.has(w));
    if (words.length < 2) continue;
    const first = fold(words[0]!);
    if (!firstNames.has(first)) continue;
    // não é início de frase só com palavra comum: exige 2º nome capitalizado (garantido por NAME)
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, category: 'pessoa', source: 'nlu', confidence: 0.7 });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROPAGATE: ReadonlySet<Category> = new Set(['pessoa', 'empresa', 'local', 'outro']);

/** Superfícies a propagar a partir de entidades aceitas (texto exato + sobrenome de pessoas). */
export function propagationKeys(entities: Entity[]): Map<string, { category: Category; label: string; confidence: number }> {
  const keys = new Map<string, { category: Category; label: string; confidence: number }>();
  const add = (k: string, category: Category, label: string, confidence: number) => {
    const f = fold(k.trim());
    if (f.length < 3) return;
    const prev = keys.get(f);
    if (!prev || prev.confidence < confidence) keys.set(f, { category, label, confidence });
  };
  for (const e of entities) {
    if (!PROPAGATE.has(e.category)) continue;
    add(e.text, e.category, e.label, e.confidence);
    if (e.category === 'pessoa') {
      const names = e.text.split(/\s+/).filter((w) => !LOWER_STOP.has(w.toLowerCase()) && !/\.$/.test(w));
      const last = names[names.length - 1];
      if (names.length >= 2 && last && last.length >= 4) add(last, 'pessoa', e.label, e.confidence * 0.9);
    }
    if (e.category === 'empresa') {
      const base = e.text.replace(/\s*,?\s*\b(?:ltda\.?|s\.?\/?a\.?|me|epp|eireli)\s*$/i, '');
      if (base !== e.text) add(base, 'empresa', e.label, e.confidence * 0.95);
    }
  }
  return keys;
}

export function propagate(text: string, keys: Map<string, { category: Category; label: string; confidence: number }>): Candidate[] {
  if (!keys.size) return [];
  const folded = fold(text);
  const sorted = [...keys.keys()].sort((a, b) => b.length - a.length);
  const out: Candidate[] = [];
  // lotes para não estourar o tamanho da regex
  for (let i = 0; i < sorted.length; i += 400) {
    const batch = sorted.slice(i, i + 400);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${batch.map((k) => escapeRe(k).replace(/\s+/g, '[^\\S\\n]+')).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of folded.matchAll(re)) {
      const start = m.index ?? 0;
      const original = text.slice(start, start + m[0].length);
      // sobrenome isolado só se estiver capitalizado no original (evita "costa" substantivo)
      if (!/^\p{Lu}/u.test(original)) continue;
      const info = keys.get(m[0].replace(/\s+/g, ' '));
      if (!info) continue;
      out.push({ start, end: start + m[0].length, category: info.category, label: info.label, source: 'propagacao', confidence: Math.min(0.95, info.confidence) });
    }
  }
  return out;
}
