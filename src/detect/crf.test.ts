import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenize } from '../core/text';
import { Crf, SpanClassifier, detectClassic } from './crf';
import { capSpans, spanFeatures, toGazetteer, tokenFeatures } from './features';

const read = (p: string) => JSON.parse(readFileSync(resolve(__dirname, p), 'utf-8'));
const gaz = toGazetteer(read('../../public/models/gazetteer.json'));
const crf = new Crf(read('../../public/models/crf.json'));
const span = new SpanClassifier(read('../../public/models/logreg.json'));
const fixtures: { text: string; tokens: [string, number, number][]; crf: string[]; marg: number[]; spans: { i: number; j: number; proba: number[] }[] }[] =
  read('./__fixtures__/parity.json');

describe('paridade Python × TypeScript', () => {
  it('tokenização idêntica', () => {
    for (const fx of fixtures) expect(tokenize(fx.text).map((t) => [t.text, t.start, t.end])).toEqual(fx.tokens);
  });
  it('CRF: mesmos rótulos e marginais (±0,01)', () => {
    for (const fx of fixtures) {
      const words = fx.tokens.map((t) => t[0]);
      const r = crf.tag(words.map((_, i) => tokenFeatures(words, i, gaz)));
      expect(r.labels).toEqual(fx.crf);
      r.marg.forEach((m, i) => expect(m).toBeCloseTo(fx.marg[i]!, 2));
    }
  });
  it('LogReg: mesmos spans e probabilidades (±0,01)', () => {
    for (const fx of fixtures) {
      const words = fx.tokens.map((t) => t[0]);
      const sp = capSpans(words);
      expect(sp).toEqual(fx.spans.map((s) => [s.i, s.j]));
      sp.forEach(([i, j], k) => span.proba(spanFeatures(words, i, j, gaz)).forEach((p, c) => expect(p).toBeCloseTo(fx.spans[k]!.proba[c]!, 2)));
    }
  });
});

describe('detectClassic', () => {
  it('encontra pessoa, empresa e local numa frase nova', () => {
    const t = 'Segundo Fernanda Ribeiro, a Transportadora Rio Doce Ltda abriu filial em Uberlândia.';
    const s = detectClassic(t, { crf, span, gaz }).map((c) => `${c.category}:${t.slice(c.start, c.end)}`);
    expect(s).toContain('pessoa:Fernanda Ribeiro');
    expect(s.some((x) => x.startsWith('empresa:Transportadora Rio Doce'))).toBe(true);
    expect(s).toContain('local:Uberlândia');
  });
});
