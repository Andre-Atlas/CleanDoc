import { detectRules, isValidCPF, isValidCNPJ, luhn } from './rules';
import { detectAll } from './pipeline';
import { maskText } from '../core/segments';

const found = (text: string) => detectRules(text).map((c) => ({ t: text.slice(c.start, c.end), cat: c.category, label: c.label }));

describe('validadores', () => {
  it('CPF com dígito verificador', () => {
    expect(isValidCPF('529.982.247-25')).toBe(true);
    expect(isValidCPF('529.982.247-24')).toBe(false);
    expect(isValidCPF('111.111.111-11')).toBe(false);
  });
  it('CNPJ com dígito verificador', () => {
    expect(isValidCNPJ('11.222.333/0001-81')).toBe(true);
    expect(isValidCNPJ('11.222.333/0001-80')).toBe(false);
  });
  it('Luhn', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true);
    expect(luhn('4111 1111 1111 1112')).toBe(false);
  });
});

describe('detectRules', () => {
  it('documentos', () => {
    const r = found('CPF 529.982.247-25, CNPJ 11.222.333/0001-81 e RG 12.345.678-9 SSP/SP.');
    expect(r).toContainEqual({ t: '529.982.247-25', cat: 'documento', label: '[CPF]' });
    expect(r).toContainEqual({ t: '11.222.333/0001-81', cat: 'documento', label: '[CNPJ]' });
    expect(r).toContainEqual({ t: '12.345.678-9', cat: 'documento', label: '[RG]' });
  });
  it('CPF sem pontuação mas com DV válido', () => {
    expect(found('cpf: 52998224725')).toContainEqual({ t: '52998224725', cat: 'documento', label: '[CPF]' });
  });
  it('contatos', () => {
    const r = found('Fale com ana.souza@exemplo.com.br ou (61) 99876-5432, CEP 70040-010.');
    expect(r).toContainEqual({ t: 'ana.souza@exemplo.com.br', cat: 'contato', label: '[e-mail]' });
    expect(r).toContainEqual({ t: '(61) 99876-5432', cat: 'contato', label: '[telefone]' });
    expect(r).toContainEqual({ t: '70040-010', cat: 'local', label: '[CEP]' });
  });
  it('endereço com logradouro e número', () => {
    const r = found('com sede na Rua das Acácias, nº 120, Bairro Centro');
    expect(r.some((x) => x.t.startsWith('Rua das Acácias, nº 120') && x.cat === 'local')).toBe(true);
  });
  it('valores numéricos e por extenso', () => {
    const r = found('O valor é de R$ 12.500,00 (doze mil e quinhentos reais) ou US$ 3 mil e 15% de multa.');
    expect(r).toContainEqual({ t: 'R$ 12.500,00', cat: 'valor', label: '[valor]' });
    expect(r).toContainEqual({ t: 'doze mil e quinhentos reais', cat: 'valor', label: '[valor]' });
    expect(r).toContainEqual({ t: 'US$ 3 mil', cat: 'valor', label: '[valor]' });
  });
  it('dados bancários e cartão', () => {
    const r = found('Banco 341, agência 1234-5, conta corrente 98765-4. Cartão 4111 1111 1111 1111.');
    expect(r).toContainEqual({ t: 'agência 1234-5', cat: 'bancario', label: '[dado bancário]' });
    expect(r).toContainEqual({ t: 'conta corrente 98765-4', cat: 'bancario', label: '[dado bancário]' });
    expect(r).toContainEqual({ t: '4111 1111 1111 1111', cat: 'bancario', label: '[cartão]' });
  });
  it('chave PIX aleatória e placa', () => {
    const r = found('PIX 123e4567-e89b-12d3-a456-426614174000, placa ABC1D23.');
    expect(r).toContainEqual({ t: '123e4567-e89b-12d3-a456-426614174000', cat: 'bancario', label: '[chave PIX]' });
    expect(r).toContainEqual({ t: 'ABC1D23', cat: 'documento', label: '[placa]' });
  });
  it('não marca datas nem números soltos como documento', () => {
    const r = found('Assinado em 12/03/2025, cláusula 4.1, item 3.');
    expect(r.filter((x) => x.cat === 'documento')).toHaveLength(0);
  });
});

describe('regressões da revisão de corretude', () => {
  const clean = async (t: string) => { const [e] = await detectAll([t], { terms: [] }); return maskText(t, e!); };
  it.each([
    ['Valor: R$ 1500,00 mensais', 'Valor: [valor] mensais'],
    ['pago R$ 12000 hoje', 'pago [valor] hoje'],
    ['R$ 8500.50', '[valor]'],
    ['US$ 2500', '[valor]'],
    ['cobrou 12000,50 reais', 'cobrou [valor]'],
    ['total de 1500 reais', 'total de [valor]'],
    ['tel (61) 99876-5432 e 61998765432', 'tel [telefone] e [telefone]'],
    ['ligar 5561998765432', 'ligar [telefone]'],
  ])('%s', async (t, out) => { expect(await clean(t)).toBe(out); });
  it('CPF válido sem pontuação continua CPF (não telefone)', async () => {
    expect(await clean('cpf 52998224725')).toBe('cpf [CPF]');
  });
  it('sem custo quadrático em corridas longas', () => {
    const t0 = performance.now();
    detectRules('um '.repeat(16000) + ('a.'.repeat(8000) + '@'));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
