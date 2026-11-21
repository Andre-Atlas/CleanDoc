import { useRef, useState, type DragEvent } from 'react';
import { Badge, Button, Icon, ProgressBar, TermInput, formatBytes } from '../components';
import type { FileItem, ModelState } from '../useCleaner';
import { countTerms, type TermFields } from '../review';

type Rejection = { name: string; reason: 'formato' | 'tamanho' | 'duplicado' };

interface Props {
  files: FileItem[];
  models: ModelState;
  terms: TermFields;
  onTerms: (t: TermFields) => void;
  onAdd: (files: File[]) => Rejection[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onStart: () => void;
  onContinue: () => void;
}

const REASON: Record<Rejection['reason'], [string, string]> = {
  formato: ['Formato não suportado', 'use PDF, DOCX, XLSX ou CSV'],
  tamanho: ['Arquivo grande demais', 'limite de 50 MB por arquivo'],
  duplicado: ['Arquivo já adicionado', 'ignorado para não processar duas vezes'],
};

export function Entrada({ files, models, terms, onTerms, onAdd, onRemove, onClear, onStart, onContinue }: Props) {
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const [open, setOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const queued = files.filter((f) => f.status === 'fila' || f.status === 'erro');
  const analyzed = files.filter((f) => f.status === 'pronto');
  const total = files.reduce((s, f) => s + f.file.size, 0);

  const take = (list: FileList | null) => {
    if (!list?.length) return;
    setRejected(onAdd([...list]));
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); take(e.dataTransfer.files); };
  const err = rejected[0];

  return (
    <main className="main-col">
      <div className="stack gap-3">
        <h1 className="t-display" tabIndex={-1}>Limpe documentos antes de compartilhar</h1>
        <p className="t-body c-secondary" style={{ maxWidth: 640 }}>
          Nomes, empresas, locais, valores, documentos e contatos viram rótulos como <span className="chip chip-empresa">[empresa]</span>. Metadados e marcas d'água são removidos. Tudo roda no seu navegador; nenhum arquivo sai do seu computador.
        </p>
      </div>

      <div className="stack gap-2">
        <div
          role="button"
          tabIndex={0}
          aria-label="Adicionar arquivos: arraste ou pressione Enter para selecionar"
          aria-describedby="dz-hint"
          className={`dropzone${files.length ? ' compact' : ''}${dragging ? ' dragging' : ''}${err ? ' error' : ''}`}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={onDrop}
        >
          <span className="dz-icon"><Icon name={err ? 'alert' : 'upload'} size={22} /></span>
          <span className="t-heading">{dragging ? 'Solte para adicionar' : err ? REASON[err.reason][0] : 'Arraste seus arquivos aqui'}</span>
          <span id="dz-hint" className="t-caption c-secondary">PDF, DOCX, XLSX ou CSV · vários de uma vez · até 50 MB cada</span>
          {!dragging && <span className="t-label c-accent">ou clique para selecionar</span>}
        </div>
        <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.xlsx,.csv" onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
        <div role="alert" className="t-caption c-danger">
          {err && `${REASON[err.reason][0]}: ${err.name} · ${REASON[err.reason][1]}${rejected.length > 1 ? ` (+${rejected.length - 1} ${rejected.length - 1 === 1 ? 'outro' : 'outros'})` : ''}`}
        </div>
      </div>

      {files.length > 0 && (
        <section className="stack gap-2" aria-label="Arquivos adicionados">
          <div className="row between">
            <span className="t-label c-secondary">{files.length} {files.length === 1 ? 'arquivo' : 'arquivos'} · {formatBytes(total)}</span>
            <button className="link" onClick={() => { setRejected([]); onClear(); }}>Remover todos</button>
          </div>
          <ul className="stack gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {files.map((f) => {
              const done = f.status === 'pronto';
              return (
                <li key={f.id} className="file-row">
                  <span className="file-icon"><Icon name="file" size={18} /></span>
                  <span className="file-text">
                    <span className="t-strong truncate">{f.file.name}</span>
                    <span className={`t-caption ${f.error ? 'c-danger' : 'c-secondary'}`} role={f.error ? 'alert' : undefined}>
                      {f.file.name.split('.').pop()?.toUpperCase()} · {formatBytes(f.file.size)} · {f.error ?? (done ? `${f.entities?.length ?? 0} itens detectados` : 'Aguardando')}
                    </span>
                  </span>
                  {f.error ? <Badge tone="danger">Erro</Badge> : done ? <Badge tone="success">Analisado</Badge> : <Badge tone="neutral">Na fila</Badge>}
                  <button className="icon-btn" aria-label={`Remover ${f.file.name}`} onClick={() => { setRejected([]); onRemove(f.id); }}><Icon name="x" /></button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card stack gap-5" aria-labelledby="termos-titulo">
        <button className="disclosure" aria-expanded={open} aria-controls={open ? 'termos-campos' : undefined} aria-describedby="termos-desc" onClick={() => setOpen(!open)}>
          <span className="stack gap-1">
            <span id="termos-titulo" className="t-heading">Termos a mascarar {countTerms(terms) > 0 && <span className="t-caption c-accent">· {countTerms(terms)}</span>}</span>
            <span id="termos-desc" className="t-caption c-secondary">Opcional. Termos daqui sempre serão mascarados, em todos os arquivos, junto com o que os modelos detectarem. Variações (sem acento, iniciais, só o sobrenome) entram automaticamente.</span>
          </span>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={20} />
        </button>
        {open && (
          <div id="termos-campos" className="terms-grid">
            <TermInput label="Nomes de pessoas" terms={terms.pessoa} onChange={(v) => onTerms({ ...terms, pessoa: v })} placeholder="Ex.: João da Silva, Maria Oliveira" />
            <TermInput label="Empresas e instituições" terms={terms.empresa} onChange={(v) => onTerms({ ...terms, empresa: v })} placeholder="Ex.: Construtora Alfa Ltda" />
            <TermInput label="Locais" terms={terms.local} onChange={(v) => onTerms({ ...terms, local: v })} placeholder="Ex.: Fazenda Boa Vista" />
            <div className="stack gap-2">
              <TermInput label="Outras informações" terms={terms.outro} onChange={(v) => onTerms({ ...terms, outro: v })} placeholder="Ex.: Projeto Aurora, nº do processo" />
              <label className="stack gap-1 t-caption c-secondary">
                Rótulo para estes termos (opcional)
                <input className="label-input" value={terms.outroLabel} placeholder="informação" onChange={(e) => onTerms({ ...terms, outroLabel: e.target.value })} />
              </label>
            </div>
          </div>
        )}
      </section>

      <div className="row between gap-4" style={{ flexWrap: 'wrap' }}>
        <ModelStatus models={models} empty={!files.length} />
        {queued.length || !analyzed.length ? (
          <Button disabled={!queued.length || models.classic !== 'ok'} onClick={onStart}>
            {queued.length ? `Limpar ${queued.length} ${queued.length === 1 ? 'arquivo' : 'arquivos'}` : 'Limpar arquivos'}
          </Button>
        ) : (
          <Button onClick={onContinue}>Continuar para revisão</Button>
        )}
      </div>
    </main>
  );
}

function ModelStatus({ models, empty }: { models: ModelState; empty: boolean }) {
  // região live fixa; só os marcos mudam o texto anunciado
  const milestone =
    models.classic === 'erro' ? 'Não foi possível carregar os modelos locais. Recarregue a página.'
    : models.ner === 'carregando' ? 'Preparando o modelo de linguagem local.'
    : models.ner === 'indisponivel' && models.classic === 'ok' ? 'Modelo transformer indisponível: usando regras, termos, CRF e NLU.'
    : models.classic === 'ok' ? (empty ? 'Nenhum arquivo adicionado' : 'Pronto para limpar') : '';
  return (
    <div className="stack gap-1" style={{ minWidth: 240 }}>
      <p className={`t-caption ${models.classic === 'erro' ? 'c-danger' : models.ner === 'carregando' ? 'c-secondary' : 'c-muted'}`} aria-live="polite">{milestone}</p>
      {models.ner === 'carregando' && models.classic !== 'erro' && (
        <>
          <ProgressBar value={models.progress} label="Download do modelo local" />
          <span className="t-caption c-muted">{Math.round(models.progress * 100)}% · só na primeira vez; depois fica no cache do navegador.</span>
        </>
      )}
    </div>
  );
}
