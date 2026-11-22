import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractZipFiles, sanitizeZipPath } from './zip';

describe('zip extraction', () => {
  it('rejeita path traversal e caminhos de sistema', () => {
    expect(sanitizeZipPath('../secreto.pdf')).toBeNull();
    expect(sanitizeZipPath('pasta/../../fora.csv')).toBeNull();
    expect(sanitizeZipPath('C:\\windows\\system.csv')).toBeNull();
    expect(sanitizeZipPath('__MACOSX/._doc.pdf')).toBeNull();
    expect(sanitizeZipPath('relatorios/2026/contrato.pdf')).toBe('relatorios/2026/contrato.pdf');
    expect(sanitizeZipPath('/pasta/planilha.xlsx')).toBe('pasta/planilha.xlsx');
  });

  it('extrai arquivos suportados preservando subpastas e ignora não suportados', async () => {
    const z = new JSZip();
    z.file('equipe/lista.csv', 'nome;cpf\nAna;123');
    z.file('scans/pagina.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    z.file('ignorado/slides.pptx', 'PK');
    z.file('__MACOSX/._lista.csv', 'mac');

    const buf = (await z.generateAsync({ type: 'arraybuffer' })) as ArrayBuffer;
    const res = await extractZipFiles(buf, 'lote.zip');

    expect(res.files.map((f) => f.relativePath).sort()).toEqual(['equipe/lista.csv', 'scans/pagina.png']);
    expect(res.skipped).toContain('ignorado/slides.pptx');
  });

  it('bloqueia path traversal real (unsafeOriginalName) e symlinks Unix dentro do ZIP', async () => {
    const z = new JSZip();
    z.file('../fora.csv', 'nome;cpf\nEvil;123');
    z.file('link.csv', '/etc/passwd', { unixPermissions: 0o120777 });
    z.file('ok/dados.csv', 'nome;cpf\nAna;123');

    const buf = (await z.generateAsync({ type: 'arraybuffer', platform: 'UNIX' })) as ArrayBuffer;
    const res = await extractZipFiles(buf, 'misto.zip');

    expect(res.files.map((f) => f.relativePath)).toEqual(['ok/dados.csv']);
    expect(res.skipped).toContain('../fora.csv');
    expect(res.skipped).toContain('link.csv');
  });

  it('falha com UnsupportedFileError em ZIP corrompido', async () => {
    await expect(extractZipFiles(new Uint8Array([1, 2, 3, 4]).buffer, 'quebrado.zip')).rejects.toThrow(/Não foi possível abrir o ZIP/i);
  });
});
