import { detectNlu, propagate, propagationKeys } from './nlu';
import { fuse } from './fuse';
import type { Candidate } from '../core/types';

const spans = (text: string, cs: Candidate[]) => cs.map((c) => `${c.category}:${text.slice(c.start, c.end)}`);

describe('NLU PT-BR', () => {
  it('tratamentos e papéis contratuais', () => {
    const t = 'neste ato representada por Maria Clara dos Santos, e o Dr. Paulo Mendes, testemunha.';
    const s = spans(t, detectNlu(t));
    expect(s).toContain('pessoa:Maria Clara dos Santos');
    expect(s).toContain('pessoa:Paulo Mendes');
  });
  it('empresas por sufixo e por tipo de instituição', () => {
    const t = 'A Construtora Horizonte Ltda. e o Banco Atlântico do Sul firmam com a Universidade Federal de Goiás.';
    const s = spans(t, detectNlu(t));
    expect(s).toContain('empresa:Construtora Horizonte Ltda.');
    expect(s).toContain('empresa:Banco Atlântico do Sul');
    expect(s).toContain('empresa:Universidade Federal de Goiás');
  });
  it('locais por preposição e cidade/UF', () => {
    const t = 'residente e domiciliado em Taguatinga, natural de Campina Grande, assinado em Brasília/DF.';
    const s = spans(t, detectNlu(t));
    expect(s).toContain('local:Taguatinga');
    expect(s).toContain('local:Campina Grande');
    expect(s).toContain('local:Brasília/DF');
  });
  it('gazetteer de primeiros nomes', () => {
    const t = 'Ficou acordado que Renata Albuquerque Lima fará a entrega.';
    expect(spans(t, detectNlu(t, new Set(['renata'])))).toContain('pessoa:Renata Albuquerque Lima');
  });
});

describe('propagação', () => {
  it('propaga nome completo e sobrenome capitalizado, ignora minúsculo', () => {
    const base = 'Contratante: Ana Beatriz Costa.';
    const ents = fuse(base, detectNlu(base));
    const keys = propagationKeys(ents);
    const t = 'Ana Beatriz Costa assina. A Sra. Costa concorda. A costa é bonita.';
    expect(spans(t, propagate(t, keys))).toEqual(['pessoa:Ana Beatriz Costa', 'pessoa:Costa']);
  });
});

describe('fusão', () => {
  const t = 'CPF 529.982.247-25 de João Silva';
  it('alta precisão define o trecho e a categoria', () => {
    const e = fuse(t, [
      { start: 4, end: 18, category: 'documento', label: '[CPF]', source: 'regra', confidence: 0.99 },
      { start: 0, end: 18, category: 'pessoa', source: 'transformer', confidence: 0.6 },
    ]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ text: '529.982.247-25', category: 'documento', label: '[CPF]' });
  });
  it('estatístico abaixo do limiar é descartado; acima passa', () => {
    expect(fuse(t, [{ start: 22, end: 32, category: 'pessoa', source: 'crf', confidence: 0.3 }])).toHaveLength(0);
    const e = fuse(t, [
      { start: 22, end: 32, category: 'pessoa', source: 'crf', confidence: 0.3 },
      { start: 22, end: 32, category: 'pessoa', source: 'transformer', confidence: 0.3 },
    ]);
    expect(e[0]?.confidence).toBeCloseTo(0.51, 2);
  });
  it('termo do usuário vence categoria do modelo', () => {
    const e = fuse(t, [
      { start: 22, end: 32, category: 'empresa', source: 'transformer', confidence: 0.9 },
      { start: 22, end: 32, category: 'pessoa', label: '[cliente]', source: 'termo', confidence: 1 },
    ]);
    expect(e[0]).toMatchObject({ category: 'pessoa', label: '[cliente]' });
  });
});

describe('desempenho (ReDoS)', () => {
  it('espaços longos e letras repetidas não travam a NLU', () => {
    const t0 = performance.now();
    detectNlu('Abc' + ' '.repeat(10000) + 'Contratante:' + ' '.repeat(5000) + 'Ana');
    detectNlu('A'.repeat(50000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
