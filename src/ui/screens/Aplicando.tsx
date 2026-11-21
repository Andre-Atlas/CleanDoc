import { Icon, ProgressBar } from '../components';
import type { FileItem } from '../useCleaner';

/** Geração dos arquivos limpos: progresso real = arquivos com resultado / pedidos. */
export function Aplicando({ files, pending }: { files: FileItem[]; pending: string[] }) {
  const ready = files.filter((f) => f.status === 'pronto');
  const done = ready.length - pending.length;
  return (
    <main className="main-col">
      <div className="stack gap-2">
        <h1 className="t-title" tabIndex={-1}>Gerando arquivos limpos</h1>
        <p className="t-body c-secondary">Aplicando as máscaras e removendo metadados e marcas d'água.</p>
      </div>
      <div className="stack gap-2">
        <span className="t-label" role="status">{done} de {ready.length} {ready.length === 1 ? 'arquivo gerado' : 'arquivos gerados'}</span>
        <ProgressBar large value={ready.length ? done / ready.length : 0} label="Progresso da geração" />
      </div>
      <ul className="stack gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {ready.map((f) => {
          const waiting = pending.includes(f.id);
          return (
            <li key={f.id} className="file-row">
              <span className="file-icon"><Icon name="file" size={18} /></span>
              <span className="file-text"><span className="t-strong truncate">{f.file.name}</span></span>
              {waiting ? <Icon name="loader" size={18} className="spin c-accent" /> : f.applyError ? <Icon name="x" size={18} className="c-danger" /> : <Icon name="check" size={18} className="c-success" />}
              <span className="sr-only">{waiting ? 'gerando' : f.applyError ? 'erro' : 'pronto'}</span>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
