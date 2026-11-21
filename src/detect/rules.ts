import type { Candidate, Category } from '../core/types';

/** Camada 1: regras com validação. Alta precisão; offsets do texto original. */

const digits = (s: string) => s.replace(/\D/g, '');

export function isValidCPF(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export function isValidCNPJ(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * w[i]!;
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export function luhn(raw: string): boolean {
  const d = digits(raw);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const NUM_WORDS =
  'zero|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzent[oa]s|trezent[oa]s|quatrocent[oa]s|quinhent[oa]s|seiscent[oa]s|setecent[oa]s|oitocent[oa]s|novecent[oa]s|mil|milh[aã]o|milh[oõ]es|bilh[aã]o|bilh[oõ]es';
const CURRENCY_WORDS = 'reais|real|d[oó]lares|d[oó]lar|euros?|centavos?';
const SCALE = '(?:mil|milh(?:ão|ao|ões|oes)|bi(?:lhão|lhao|lhões|lhoes)?|mi|k)';

interface Rule {
  re: RegExp;
  category: Category;
  label: string;
  confidence: number;
  validate?: (m: string) => boolean;
  /** índice do grupo que contém o trecho a mascarar (padrão: match inteiro) */
  group?: number;
}

const RULES: Rule[] = [
  // Documentos
  { re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, category: 'documento', label: '[CPF]', confidence: 0.99, validate: isValidCPF },
  { re: /(?<![\d./-])\d{11}(?![\d./-])/g, category: 'documento', label: '[CPF]', confidence: 0.9, validate: isValidCPF },
  { re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, category: 'documento', label: '[CNPJ]', confidence: 0.99, validate: isValidCNPJ },
  { re: /(?<![\d./-])\d{14}(?![\d./-])/g, category: 'documento', label: '[CNPJ]', confidence: 0.9, validate: isValidCNPJ },
  // CPF formatado com DV inválido ainda é dado pessoal (erro de digitação) — confiança menor, mas mascara.
  { re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, category: 'documento', label: '[CPF]', confidence: 0.75 },
  { re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, category: 'documento', label: '[CNPJ]', confidence: 0.75 },
  { re: /\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b/g, category: 'documento', label: '[RG]', confidence: 0.9 },
  { re: /\b(?:RG|R\.G\.|identidade|carteira de identidade)\s*(?:n[º°o.]*\s*)?:?\s*([\dXx.-]{5,14})/gi, category: 'documento', label: '[RG]', confidence: 0.9, group: 1 },
  { re: /\b(?:OAB|CRM|CREA|CRC|CRO|CRP|COREN)\s*[/-]?\s*[A-Z]{2}\s*(?:n[º°o.]*\s*)?\d[\d.]{2,9}\b/g, category: 'documento', label: '[registro profissional]', confidence: 0.95 },
  { re: /\b(?:PIS|PASEP|NIT|CNH|título de eleitor|passaporte)\s*(?:n[º°o.]*\s*)?:?\s*([A-Z]{0,2}[\d.-]{6,15})/gi, category: 'documento', label: '[documento]', confidence: 0.9, group: 1 },
  { re: /\b[A-Z]{3}-?\d[A-Z\d]\d{2}\b/g, category: 'documento', label: '[placa]', confidence: 0.85 },
  // Contatos
  { re: /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, category: 'contato', label: '[e-mail]', confidence: 0.99 },
  { re: /(?:\+55\s?)?(?:\(\d{2}\)|\b\d{2}\b)\s?\d{4,5}[-\s]?\d{4}\b/g, category: 'contato', label: '[telefone]', confidence: 0.9 },
  // telefone sem separadores: celular (DDD + 9 + 8 dígitos) e fixo (DDD + 2-5 + 7 dígitos); CPF válido vence por confiança
  { re: /(?<![\d./-])(?:55)?[1-9]{2}9\d{8}(?![\d./-])/g, category: 'contato', label: '[telefone]', confidence: 0.8 },
  { re: /(?<![\d./-])(?:55)?[1-9]{2}[2-5]\d{7}(?![\d./-])/g, category: 'contato', label: '[telefone]', confidence: 0.7 },
  { re: /\b0(?:800|300|500|900)[\s-]?\d{3}[\s-]?\d{4}\b/g, category: 'contato', label: '[telefone]', confidence: 0.9 },
  { re: /\bhttps?:\/\/[^\s<>"]+/g, category: 'contato', label: '[link]', confidence: 0.8 },
  // Local
  { re: /\b\d{5}-\d{3}\b/g, category: 'local', label: '[CEP]', confidence: 0.95 },
  { re: /\bCEP\s*:?\s*(\d{2}\.?\d{3}-?\d{3})\b/gi, category: 'local', label: '[CEP]', confidence: 0.98, group: 1 },
  {
    re: /\b(?:Rua|R\.|Avenida|Av\.|Alameda|Al\.|Travessa|Tv\.|Rodovia|Rod\.|Estrada|Est\.|Praça|Pça\.|Largo|Quadra|SQN|SQS|SHIS|SHIN|Viela|Ladeira|Beco|Ramal)\s+[\p{L}\d][\p{L}\d .'-]{1,60}?(?:,\s*(?:n[º°o.]*\s*)?\d+[A-Za-z]?)?(?:,\s*(?:apto|apartamento|sala|bloco|casa|lote|conj\.?)\s*[\w-]+)*(?=[,.;\n)]|\s+-\s|$)/gu,
    category: 'local',
    label: '[endereço]',
    confidence: 0.9,
  },
  // Tipos de logradouro ambíguos (também nomes de empresa/pessoa): só com número.
  {
    re: /\b(?:Setor|Conjunto|Condomínio|Residencial|Loteamento|Núcleo|Vila|Vale|Sítio|Chácara|Fazenda|Recanto|Vereda|Trecho|Parque|Jardim|Lagoa|Lago|Morro|Pátio|Passarela|Esplanada|Colônia|Distrito|Campo|Via|Caminho|Acesso|Área|Aeroporto|Feira|Rampa|Margem|Ponte|Favela|Comunidade|Viaduto|Rotatória|Servidão|Balneário|Estação|Entrequadra)\s+[\p{L}\d][\p{L}\d .'-]{1,60}?,\s*(?:n[º°o.]*\s*)?\d{1,5}[A-Za-z]?\b/gu,
    category: 'local',
    label: '[endereço]',
    confidence: 0.9,
  },
  // Valores
  // número: com separador de milhar OU dígitos corridos ("1500"); nunca para no meio de um número
  { re: new RegExp(String.raw`(?:R\$|US\$|U\$|€|£|USD|BRL|EUR)\s?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)(?:\s?${SCALE}\b)?`, 'g'), category: 'valor', label: '[valor]', confidence: 0.99 },
  { re: new RegExp(String.raw`(?<![\d.,])(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?\s?${SCALE}?\s?(?:reais|d[oó]lares|euros)\b`, 'gi'), category: 'valor', label: '[valor]', confidence: 0.95 },
  {
    re: new RegExp(String.raw`\b(?:(?:${NUM_WORDS})(?:\s+e\s+|\s+|,\s*)){0,12}(?:${NUM_WORDS})\s+(?:de\s+)?(?:${CURRENCY_WORDS})(?:\s+e\s+(?:(?:${NUM_WORDS})\s+(?:e\s+)?)+centavos?)?\b`, 'gi'),
    category: 'valor',
    label: '[valor]',
    confidence: 0.95,
  },
  // Bancário
  { re: /\bag(?:ê|e)ncia\s*(?:n[º°o.]*\s*)?:?\s*\d{3,5}(?:-[\dXx])?/gi, category: 'bancario', label: '[dado bancário]', confidence: 0.95 },
  { re: /\bconta(?:\s+(?:corrente|poupança|poupanca|pagamento|salário|salario))?\s*(?:n[º°o.]*\s*)?:?\s*\d{3,12}-[\dXx]/gi, category: 'bancario', label: '[dado bancário]', confidence: 0.95 },
  { re: /\b(?:\d{4}[\s-]?){3}\d{1,7}\b/g, category: 'bancario', label: '[cartão]', confidence: 0.95, validate: luhn },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, category: 'bancario', label: '[chave PIX]', confidence: 0.9 },
  { re: /\bBR\d{2}(?:\s?[\dA-Z]{4}){6}\s?[\dA-Z]{1,3}\b/g, category: 'bancario', label: '[IBAN]', confidence: 0.95 },
];

export function detectRules(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const full = m[0];
      if (rule.validate && !rule.validate(full)) continue;
      let start = m.index ?? 0;
      let end = start + full.length;
      if (rule.group !== undefined) {
        const g = m[rule.group];
        if (!g) continue;
        const off = full.lastIndexOf(g);
        start += off;
        end = start + g.length;
      }
      // apara espaços e pontuação final
      while (end > start && /[\s.,;:]/.test(text[end - 1]!)) end--;
      out.push({ start, end, category: rule.category, label: rule.label, source: 'regra', confidence: rule.confidence });
    }
  }
  return dropShadowed(out);
}

/** Remove candidatos estritamente contidos em outro de mesma categoria e confiança ≥ (ex.: CPF inválido sob CPF válido). */
function dropShadowed(c: Candidate[]): Candidate[] {
  return c.filter(
    (a, i) =>
      !c.some(
        (b, j) =>
          j !== i &&
          b.start <= a.start &&
          b.end >= a.end &&
          (b.end - b.start > a.end - a.start || (b.confidence > a.confidence || (b.confidence === a.confidence && j < i))) &&
          (b.category === a.category || b.confidence >= a.confidence),
      ),
  );
}
