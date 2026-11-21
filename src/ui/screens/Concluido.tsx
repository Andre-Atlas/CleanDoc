import JSZip from 'jszip';
import { useState } from 'react';
import { CATEGORY_NAMES } from '../../core/types';
import { Button, Icon } from '../components';
import type { FileItem } from '../useCleaner';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Relatório sem valores originais: só contagens por rótulo e o que foi removido. */
export function buildReport(files: FileItem[], termsApplied: number): string {
  const lines = ['Relatório Doc Cleaner', `Gerado em ${new Date().toLocaleString('pt-BR')}`, 'Este relatório NÃO contém os valores originais.', ''];
  for (const f of files) {
    const r = f.result?.report;
    if (!r) continue;
    lines.push(`# ${r.fileName} → ${f.result!.fileName}`, `Itens mascarados: ${r.maskedCount}`);
    for (const e of r.entities) lines.push(`  - ${CATEGORY_NAMES[e.category]} ${e.label}: ${e.count}`);
    if (r.metadata.length) lines.push('Removido:', ...r.metadata.map((m) => `  - ${m.description}${m.count > 1 ? ` (${m.count})` : ''}`));
    if (r.warnings.length) lines.push('Avisos:', ...r.warnings.map((w) => `  - ${w}`));
    lines.push('');
  }
  lines.push(`Termos informados pelo usuário aplicados: ${termsApplied}`);
  return lines.join('\n');
}

export function Concluido({ files, termsApplied, onClear, onRetry }: { files: FileItem[]; termsApplied: number; onClear: () => void; onRetry: () => void }) {
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState(false);
  const done = files.filter((f) => f.result);
  const failed = files.filter((f) => f.applyError || f.status === 'erro');
  const masked = done.reduce((s, f) => s + (f.result?.report.maskedCount ?? 0), 0);
  const meta = done.reduce((s, f) => s + (f.result?.report.metadata.reduce((a, m) => a + m.count, 0) ?? 0), 0);
  const wm = done.reduce((s, f) => s + (f.result?.report.watermarksRemoved ?? 0), 0);

  const zipAll = async () => {
    setZipping(true);
    setZipError(false);
    try {
      const z = new JSZip();
      const used = new Set<string>();
      for (const f of done) {
        // nomes iguais não se sobrescrevem no .zip
        let name = f.result!.fileName;
        for (let i = 2; used.has(name); i++) name = f.result!.fileName.replace(/(\.[^.]+)?$/, `_${i}$1`);
        used.add(name);
        z.file(name, f.result!.blob, { date: new Date(Date.UTC(2000, 0, 1)) });
      }
      download(await z.generateAsync({ type: 'blob', compression: 'DEFLATE' }), 'documentos_limpos.zip');
    } catch {
      setZipError(true);
    } finally {
      setZipping(false);
    }
  };

  return (
    <main className="main-col">
      <div className="stack gap-3">
        <span className="ok-icon"><Icon name="check" size={24} /></span>
        <h1 className="t-title" tabIndex={-1}>{done.length} {done.length === 1 ? 'arquivo limpo' : 'arquivos limpos'}</h1>
        <p className="t-body c-secondary">Confira o resumo e baixe. Os arquivos ficam só na memória desta aba até você baixar ou limpar a sessão.</p>
      </div>
      {failed.length > 0 && (
        <div className="notice danger stack gap-2" role="alert">
          <strong className="t-label">{failed.length === 1 ? '1 arquivo NÃO foi limpo' : `${failed.length} arquivos NÃO foram limpos`}. Não compartilhe os originais.</strong>
          <ul className="t-caption" style={{ margin: 0, paddingLeft: 18 }}>
            {failed.map((f) => <li key={f.id}>{f.file.name}: {f.applyError ?? f.error}</li>)}
          </ul>
          {failed.some((f) => f.applyError) && <Button variant="secondary" onClick={onRetry} style={{ alignSelf: 'flex-start' }}>Tentar de novo</Button>}
        </div>
      )}
      <div className="stats">
        {[[masked, 'itens mascarados'], [meta, 'metadados removidos'], [wm, "marcas d'água removidas"], [termsApplied, 'termos seus aplicados']].map(([n, l]) => (
          <div key={l} className="stat stack gap-1"><span className="t-title">{n}</span><span className="t-caption c-secondary">{l}</span></div>
        ))}
      </div>
      <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {done.map((f) => {
          const r = f.result!.report;
          const warn = r.warnings.find((w) => /escaneado/.test(w));
          return (
            <li key={f.id} className="list-row">
              <Icon name="file" size={18} className="c-secondary" />
              <span className="file-text">
                <span className="t-strong truncate">{f.result!.fileName}</span>
                <span className={`t-caption ${warn ? 'c-warning' : 'c-secondary'}`}>{warn ? 'Só metadados (PDF escaneado)' : `${r.maskedCount} itens · ${r.metadata.reduce((a, m) => a + m.count, 0)} metadados`}</span>
              </span>
              <Button variant="secondary" onClick={() => download(f.result!.blob, f.result!.fileName)} aria-label={`Baixar ${f.result!.fileName}`}>
                <Icon name="download" /> Baixar
              </Button>
            </li>
          );
        })}
      </ul>
      <button className="link row gap-2" onClick={() => download(new Blob([buildReport(done, termsApplied)], { type: 'text/plain;charset=utf-8' }), 'relatorio_doc_cleaner.txt')}>
        <Icon name="file" /> Baixar relatório do que foi removido (sem os valores originais)
      </button>
      <div className="row between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="stack gap-1">
          <button className="btn-danger-link" onClick={onClear}>Limpar sessão</button>
          <span className="t-caption c-muted">Apaga arquivos, termos e resultados desta aba.</span>
        </div>
        <div className="stack gap-1" style={{ alignItems: 'flex-end' }}>
          <Button onClick={zipAll} disabled={zipping || !done.length}><Icon name="download" /> {zipping ? 'Compactando…' : 'Baixar todos (.zip)'}</Button>
          {zipError && <span className="t-caption c-danger" role="alert">Não foi possível gerar o .zip. Baixe os arquivos um a um.</span>}
        </div>
      </div>
    </main>
  );
}
