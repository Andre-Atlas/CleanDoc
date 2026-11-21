import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EVIDENCE = resolve(import.meta.dirname, '../docs/atlas/2026-11-21-doc-cleaner/evidence');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`), fullPage: false });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
async function docx(): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file(
    'word/document.xml',
    `<w:document ${W}><w:body>` +
      '<w:p><w:r><w:t>CONTRATO DE PRESTAÇÃO DE SERVIÇOS</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Pelo presente instrumento, a Construtora Horizonte Ltda., inscrita no CNPJ sob o nº 11.222.333/0001-81, com sede na Rua das Acácias, nº 120, Goiânia/GO, neste ato representada por Marcos Vinícius Prado, portador do CPF 529.982.247-25, doravante CONTRATANTE.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Cláusula 2ª. O valor total é de R$ 48.500,00 (quarenta e oito mil e quinhentos reais), pago via PIX para a chave marcos.prado@horizonte.com.br, agência 1234-5, conta corrente 98765-4.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Cláusula 3ª. A execução ocorrerá na Fazenda Boa Vista, sob supervisão da Dra. Helena Duarte. Contato: (62) 99876-5432. O Sr. Prado aprova.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  );
  z.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Marcos Prado</dc:creator></cp:coreProperties>');
  return z.generateAsync({ type: 'nodebuffer' });
}
const csv = Buffer.from('nome;cpf;salário;cidade\nHelena Duarte;390.533.447-05;12500,00;Anápolis\nRenato Siqueira;111.444.777-35;9800,00;Goiânia\n', 'utf-8');

const SECRETS = ['Marcos', 'Prado', 'Helena', 'Duarte', 'Renato', '529.982.247-25', '390.533.447-05', '11.222.333/0001-81', 'R$ 48.500', 'quarenta e oito', 'horizonte.com.br', '99876-5432', 'Acácias', '12500,00', 'Horizonte Ltda', 'Fazenda Boa Vista'];

test('fluxo completo: entrada → processamento → revisão → concluído, sem rede externa e sem persistência', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Limpe documentos antes de compartilhar' })).toBeVisible();
  await shot(page, '01-entrada-vazio');

  await page.locator('input[type=file]').setInputFiles([
    { name: 'contrato.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await docx() },
    { name: 'equipe.csv', mimeType: 'text/csv', buffer: csv },
  ]);
  const pessoas = page.getByLabel('Nomes de pessoas');
  await pessoas.fill('Fazenda Boa Vista');
  await pessoas.press('Enter');
  // termo foi para o campo errado: remove e coloca em Locais
  await page.getByRole('button', { name: 'Remover Fazenda Boa Vista' }).click();
  await page.getByLabel('Locais').fill('Fazenda Boa Vista');
  await page.getByLabel('Locais').press('Enter');
  await expect(page.getByText('1 termo')).toBeVisible();
  await shot(page, '02-entrada-arquivos-termos');

  const start = page.getByRole('button', { name: 'Limpar 2 arquivos' });
  await expect(start).toBeEnabled({ timeout: 60_000 });
  // o transformer precisa carregar de verdade (runtime e pesos servidos pela própria origem)
  await expect(page.getByText('Pronto para limpar')).toBeVisible({ timeout: 120_000 });
  await start.click();
  await shot(page, '03-processamento');

  const review = page.getByRole('button', { name: 'Revisar 2 arquivos' });
  await expect(review).toBeEnabled({ timeout: 180_000 });
  await review.click();
  await expect(page.getByRole('heading', { name: /itens a mascarar/ })).toBeVisible();
  // foco vai para o título da nova tela (leitores de tela anunciam a troca)
  await expect(page.getByRole('heading', { level: 1, name: 'Revisar detecções' })).toBeFocused();
  // Voltar → Entrada mostra os arquivos como analisados e oferece seguir para a revisão
  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByText('Analisado')).toHaveCount(2);
  await page.getByRole('button', { name: 'Continuar para revisão' }).click();
  await expect(page.getByRole('heading', { name: /itens a mascarar/ })).toBeVisible();
  await page.getByRole('button', { name: /contrato\.docx/ }).click();
  // título do documento não é entidade
  await expect(page.locator('.page').first()).toContainText('CONTRATO DE PRESTAÇÃO DE SERVIÇOS');
  await shot(page, '04-revisao');

  // popover de uma detecção
  await page.locator('.page button.chip', { hasText: '[nome pessoal]' }).first().click();
  const dialog = page.getByRole('dialog', { name: /Pessoas/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Transformer');
  await shot(page, '05-revisao-popover');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Aplicar e baixar' }).click();
  await expect(page.getByRole('heading', { name: '2 arquivos limpos' })).toBeVisible({ timeout: 60_000 });
  await shot(page, '06-concluido');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Baixar todos/ }).click()]);
  const zip = await JSZip.loadAsync(readFileSync((await dl.path())!));
  expect(Object.keys(zip.files).sort()).toEqual(['contrato_limpo.docx', 'equipe_limpo.csv']);
  const cleanDocx = await JSZip.loadAsync(await zip.file('contrato_limpo.docx')!.async('uint8array'));
  const docText = (await Promise.all(Object.keys(cleanDocx.files).map((p) => cleanDocx.file(p)?.async('string') ?? ''))).join('\n');
  const csvText = await zip.file('equipe_limpo.csv')!.async('string');
  for (const s of SECRETS) {
    expect(docText, `DOCX vazou: ${s}`).not.toContain(s);
    expect(csvText, `CSV vazou: ${s}`).not.toContain(s);
  }
  expect(docText).toContain('[nome pessoal]');
  expect(csvText).toContain('[valor]');

  // nada saiu da origem
  const external = requests.filter((u) => !u.startsWith(baseURL!) && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(external, external.join('\n')).toEqual([]);
  // nada persistido além do cache do modelo
  const persisted = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    idb: (await indexedDB.databases?.())?.map((d) => d.name) ?? [],
    caches: await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname))),
  }));
  expect(persisted.local).toBe(0);
  expect(persisted.session).toBe(0);
  expect(persisted.idb).toEqual([]);
  for (const p of persisted.caches.flat()) expect(p).toMatch(/^\/models\//);

  await page.getByRole('button', { name: 'Limpar sessão' }).click();
  await expect(page.getByRole('heading', { name: 'Limpe documentos antes de compartilhar' })).toBeVisible();
  await expect(page.getByText('contrato.docx')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('arquivo em formato não suportado mostra erro na dropzone', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles([{ name: 'slides.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK') }]);
  await expect(page.getByRole('alert').filter({ hasText: 'slides.pptx' })).toContainText('Formato não suportado');
  await expect(page.locator('.dropzone')).toContainText('Formato não suportado');
});

test('telas em tema escuro e mobile', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await shot(page, '07-entrada-escuro');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await shot(page, '08-entrada-mobile');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
