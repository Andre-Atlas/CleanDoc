/**
 * Avaliação de recall/precisão por categoria no conjunto de teste PT-BR (templates não vistos no treino).
 * Gate de release: recall "mascarado" ≥ 99% por categoria (o dado foi coberto por alguma máscara).
 * Sem o transformer (pesado); rode com NER=1 (e --environment node) para o ensemble completo.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATEGORIES, type Category } from '../core/types';
import { Crf, SpanClassifier } from '../detect/crf';
import { toGazetteer } from '../detect/features';
import { detectAll } from '../detect/pipeline';
import { loadBertNer, type WordClassifier } from '../detect/transformer';

const root = resolve(__dirname, '../..');
const read = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf-8'));
const docs: { text: string; spans: [number, number, Category, string][] }[] = readFileSync(resolve(root, 'ml/data/test.jsonl'), 'utf-8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const classic = { crf: new Crf(read('public/models/crf.json')), span: new SpanClassifier(read('public/models/logreg.json')), gaz: toGazetteer(read('public/models/gazetteer.json')) };

const WITH_NER = process.env.NER === '1';

it(`recall ≥ 99% por categoria (dado mascarado) e precisão ≥ 90%${WITH_NER ? ' — com transformer' : ''}`, async () => {
  const ner: WordClassifier | undefined = WITH_NER ? await loadBertNer({ modelPath: resolve(root, 'public/models') + '/' }) : undefined;
  const stats = Object.fromEntries(CATEGORIES.map((c) => [c, { gold: 0, masked: 0, exact: 0 }])) as Record<Category, { gold: number; masked: number; exact: number }>;
  let predChars = 0, predGoldChars = 0;
  const misses: string[] = [];
  // processa documento a documento (sem propagação entre docs de teste independentes)
  for (const d of docs) {
    const [ents] = await detectAll([d.text], { terms: [], classic, ner });
    const cover = new Uint8Array(d.text.length);
    for (const e of ents!) for (let k = e.start; k < e.end; k++) cover[k] = 1;
    const gold = new Uint8Array(d.text.length);
    for (const [s, e, cat] of d.spans) {
      for (let k = s; k < e; k++) gold[k] = 1;
      const st = stats[cat];
      st.gold++;
      let c = 0;
      for (let k = s; k < e; k++) c += cover[k]!;
      // mascarado = ≥ 90% dos caracteres não-espaço cobertos
      const nonSpace = d.text.slice(s, e).replace(/\s/g, '').length;
      if (c >= Math.ceil(nonSpace * 0.9)) st.masked++;
      else misses.push(`${cat}: «${d.text.slice(s, e)}» em «${d.text.slice(Math.max(0, s - 30), e + 20)}»`);
      if (ents!.some((x) => x.start <= s && x.end >= e && x.category === cat)) st.exact++;
    }
    for (const e of ents!) for (let k = e.start; k < e.end; k++) { if (!/\s/.test(d.text[k]!)) { predChars++; predGoldChars += gold[k]!; } }
  }
  const report = CATEGORIES.filter((c) => stats[c].gold).map((c) => ({
    categoria: c,
    ocorrencias: stats[c].gold,
    recall_mascarado: +(stats[c].masked / stats[c].gold).toFixed(4),
    recall_categoria_exata: +(stats[c].exact / stats[c].gold).toFixed(4),
  }));
  const precision = predGoldChars / predChars;
  writeFileSync(resolve(root, `docs/atlas/2026-11-21-doc-cleaner/eval${WITH_NER ? '-ner' : ''}.json`), JSON.stringify({ precisao_caracteres: +precision.toFixed(4), categorias: report, exemplos_de_falha: misses.slice(0, 40) }, null, 2));
  console.table(report);
  for (const r of report) expect.soft(r.recall_mascarado, r.categoria).toBeGreaterThanOrEqual(0.99);
  expect(precision).toBeGreaterThanOrEqual(0.9);
}, 1800000);
