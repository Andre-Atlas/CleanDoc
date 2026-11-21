import { detectUserTerms, termVariants } from './userTerms';

const hits = (text: string, ...terms: Parameters<typeof detectUserTerms>[1]) =>
  detectUserTerms(text, terms).map((c) => text.slice(c.start, c.end));

describe('termos do usuário', () => {
  it('gera variações de pessoa', () => {
    const v = termVariants({ text: 'João da Silva Mendes', category: 'pessoa' });
    expect(v).toEqual(expect.arrayContaining(['joao da silva mendes', 'joao mendes', 'mendes', 'j. mendes']));
  });
  it('casa sem acento, abreviado e só o sobrenome', () => {
    const t = 'Joao da Silva Mendes assinou. J. Mendes confirmou; MENDES saiu.';
    expect(hits(t, { text: 'João da Silva Mendes', category: 'pessoa' })).toEqual(['Joao da Silva Mendes', 'J. Mendes', 'MENDES']);
  });
  it('não casa dentro de outra palavra', () => {
    expect(hits('Alfabeto e Alfa.', { text: 'Alfa', category: 'empresa' })).toEqual(['Alfa']);
  });
  it('empresa sem sufixo societário', () => {
    expect(hits('A Construtora Alfa entregou. Construtora Alfa Ltda. assina.', { text: 'Construtora Alfa Ltda', category: 'empresa' })).toEqual([
      'Construtora Alfa',
      'Construtora Alfa Ltda',
    ]);
  });
  it('rótulo livre em outras informações', () => {
    const [c] = detectUserTerms('Projeto Aurora começa.', [{ text: 'Projeto Aurora', category: 'outro', label: 'projeto' }]);
    expect(c?.label).toBe('[projeto]');
  });
});
