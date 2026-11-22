import { Badge, Button, Icon, ProgressBar, formatBytes } from '../components';
import type { FileItem } from '../useCleaner';

const STAGES = [
  ['ler', 'Ler'],
  ['ocr', 'OCR (imagens)'],
  ['termos', 'Termos e regras'],
  ['crf', 'ML clássico (CRF)'],
  ['transformer', 'Transformer PT-BR'],
  ['nlu', 'NLU e propagação'],
  ['pronto', 'Pronto para revisar'],
] as const;
const ORDER: Record<string, number> = { ler: 0, ocr: 1, termos: 2, regras: 2, crf: 3, transformer: 4, nlu: 5, pronto: 6 };

export function Processamento({ files, busy, onCancel, onReview }: { files: FileItem[]; busy: boolean; onCancel: () => void; onReview: () => void }) {
  const done = files.filter((f) => f.status === 'pronto').length;
  const errors = files.filter((f) => f.status === 'erro').length;
  const overall = files.reduce((s, f) => s + f.progress, 0) / Math.max(1, files.length);
  const current = Math.min(...files.filter((f) => f.status === 'processando').map((f) => ORDER[f.stage ?? 'ler'] ?? 0), 5);

  return (
    <main className="main-col">
      <div className="stack gap-2">
        <h1 className="t-title" tabIndex={-1}>{busy ? `Limpando ${files.length} ${files.length === 1 ? 'arquivo' : 'arquivos'}` : 'Análise concluída'}</h1>
        <p className="t-body c-secondary">Lendo, detectando e preparando a limpeza no seu dispositivo.</p>
      </div>
      <div className="stack gap-2" aria-live="polite">
        <div className="row between">
          <span className="t-label">{done} de {files.length} {files.length === 1 ? 'pronto' : 'prontos'}{errors ? ` · ${errors} com erro` : ''}</span>
        </div>
        <ProgressBar large value={overall} label="Progresso geral" />
        <ol className="pipeline t-caption c-secondary" aria-label="Etapas da análise">
          {STAGES.map(([k, l], i) => {
            const st = busy ? (i < current ? 'done' : i === current ? 'active' : '') : 'done';
            return (
              <li key={k} className={st} aria-current={st === 'active' ? 'step' : undefined}>
                <i aria-hidden="true" />{l}<span className="sr-only">{st === 'done' ? ' (concluída)' : st === 'active' ? ' (em andamento)' : ' (pendente)'}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <ul className="stack gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {files.map((f) => <Row key={f.id} f={f} />)}
      </ul>
      <div className="row gap-3" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button disabled={busy || !done} onClick={onReview}>{done ? `Revisar ${done} ${done === 1 ? 'arquivo' : 'arquivos'}` : 'Revisar'}</Button>
      </div>
    </main>
  );
}

function Row({ f }: { f: FileItem }) {
  const ext = f.file.name.split('.').pop()?.toUpperCase();
  const scanned = f.warnings.some((w) => /escaneado/.test(w));
  let badge = <Badge tone="neutral">Na fila</Badge>;
  let icon = <Icon name="clock" size={18} className="c-muted" />;
  let meta = 'Aguardando';
  if (f.status === 'processando') {
    badge = <Badge tone="accent">Detectando</Badge>;
    icon = <Icon name="loader" size={18} className="spin c-accent" />;
    const stage = f.stage === 'regras' ? 'termos' : f.stage;
    meta = `${STAGES.find(([k]) => k === stage)?.[1] ?? 'Lendo'} · ${Math.round(f.progress * 100)}%`;
  } else if (f.status === 'erro') {
    badge = <Badge tone="danger">Erro</Badge>;
    icon = <Icon name="x" size={18} className="c-danger" />;
    meta = f.error ?? 'Erro';
  } else if (f.status === 'pronto') {
    const n = f.entities?.length ?? 0;
    badge = scanned ? <Badge tone="warning">Atenção</Badge> : <Badge tone="success">Pronto</Badge>;
    icon = scanned ? <Icon name="alert" size={18} className="c-warning" /> : <Icon name="check" size={18} className="c-success" />;
    meta = scanned ? 'Escaneado: sem texto. Só os metadados serão limpos.' : `${n} ${n === 1 ? 'item detectado' : 'itens detectados'}`;
  }
  const displayName = f.relativePath ?? f.file.name;
  return (
    <li className="file-row">
      <span className="file-icon"><Icon name="file" size={18} /></span>
      <span className="file-text">
        <span className="t-strong truncate">{displayName}</span>
        <span className={`t-caption ${f.status === 'erro' ? 'c-danger' : scanned ? 'c-warning' : 'c-secondary'}`} role={f.status === 'erro' ? 'alert' : undefined}>{ext} · {formatBytes(f.file.size)} · {meta}</span>
        {f.status === 'processando' && <ProgressBar value={f.progress} label={`Progresso de ${displayName}`} />}
      </span>
      {badge}
      {icon}
    </li>
  );
}
