import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CATEGORIES, CATEGORY_NAMES, DEFAULT_LABEL, type Category, type Entity } from '../../core/types';
import { Badge, Button, Icon, MaskChip } from '../components';
import { entityKey, isActive, withOverrides, type ReviewState } from '../review';
import type { FileItem } from '../useCleaner';

const SOURCE_NAMES: Record<string, string> = { termo: 'Seus termos', regra: 'Regra validada', crf: 'CRF', logreg: 'Classificador', transformer: 'Transformer', nlu: 'NLU', propagacao: 'Propagação' };
const PREVIEW_LIMIT = 60_000;

interface Props {
  files: FileItem[];
  review: ReviewState;
  onReview: (r: ReviewState) => void;
  onAddTerm: (text: string, category: Category) => void;
  busy: boolean;
  onBack: () => void;
  onApply: () => void;
}

interface Pop { e: Entity; x: number; y: number; origin: HTMLElement }

export function Revisao({ files, review, onReview, onAddTerm, busy, onBack, onApply }: Props) {
  const ready = useMemo(() => files.filter((f) => f.status === 'pronto'), [files]);
  const [sel, setSel] = useState(ready[0]?.id);
  const [mode, setMode] = useState<'limpo' | 'original' | 'lado'>('limpo');
  const [tab, setTab] = useState<'deteccoes' | 'documento'>('deteccoes');
  const [pop, setPop] = useState<Pop | null>(null);
  const file = ready.find((f) => f.id === sel) ?? ready[0];
  const previewRef = useRef<HTMLElement>(null);

  const all = useMemo(() => ready.flatMap((f) => withOverrides(f.entities ?? [], review)), [ready, review]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(CATEGORIES.map((k) => [k, 0])) as Record<Category, number>;
    for (const e of all) if (!review.excluded.includes(entityKey(e))) c[e.category]++;
    return c;
  }, [all, review.excluded]);
  const active = all.filter((e) => isActive(e, review)).length;
  const occurrences = (e: Entity) => all.filter((x) => entityKey(x) === entityKey(e)).length;

  const toggleCat = (c: Category) => onReview({ ...review, disabled: review.disabled.includes(c) ? review.disabled.filter((x) => x !== c) : [...review.disabled, c] });
  const toggleExcluded = (e: Entity) => {
    const k = entityKey(e);
    onReview({ ...review, excluded: review.excluded.includes(k) ? review.excluded.filter((x) => x !== k) : [...review.excluded, k] });
  };
  const recategorize = (e: Entity, c: Category) => onReview({ ...review, recategorized: { ...review.recategorized, [entityKey(e)]: c } });

  const closePop = useCallback((restore = true) => {
    setPop((p) => {
      if (p && restore) {
        // o elemento de origem pode ter sido trocado (chip ↔ marca); procura pelo início da entidade
        const target = p.origin.isConnected ? p.origin : previewRef.current?.querySelector<HTMLElement>(`[data-start="${p.e.start}"]`);
        requestAnimationFrame(() => (target ?? previewRef.current)?.focus({ preventScroll: true }));
      }
      return null;
    });
  }, []);

  // fecha o popover ao rolar o preview (ele é fixo na tela)
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !pop) return;
    const h = () => closePop(false);
    el.addEventListener('scroll', h, { passive: true });
    return () => el.removeEventListener('scroll', h);
  }, [pop, closePop]);

  const openPop = (e: Entity, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 300, Math.max(8, r.left));
    const y = r.bottom + 8 + 220 > window.innerHeight ? Math.max(8, r.top - 228) : r.bottom + 8;
    setPop({ e, x, y, origin: el });
  };

  return (
    <main className="review" data-tab={tab}>
      <h1 className="sr-only" tabIndex={-1}>Revisar detecções</h1>
      <div className="segmented tabs-mobile" role="group" aria-label="Visualização">
        <button aria-pressed={tab === 'deteccoes'} onClick={() => setTab('deteccoes')}>Detecções · {active}</button>
        <button aria-pressed={tab === 'documento'} onClick={() => setTab('documento')}>Documento</button>
      </div>

      <nav className="pane pane-left" aria-label="Arquivos">
        <span className="t-label c-muted" style={{ padding: '0 10px 8px' }} aria-hidden="true">ARQUIVOS · {ready.length}</span>
        <ul className="stack gap-1" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {ready.map((f) => {
            const n = withOverrides(f.entities ?? [], review).filter((e) => isActive(e, review)).length;
            const warn = f.warnings.length > 0;
            const current = f.id === file?.id;
            return (
              <li key={f.id}>
                <button aria-current={current ? 'true' : undefined} className="file-tab" onClick={() => { setSel(f.id); setTab('documento'); }}>
                  <span className="dot" aria-hidden="true" style={{ background: warn ? 'var(--status-warning)' : 'var(--status-success)' }} />
                  <span className="t-label truncate" style={{ flex: 1 }}>{f.file.name}</span>
                  <span className={`t-mono ${current ? 'c-accent' : 'c-secondary'}`}>{n}</span>
                  <span className="sr-only">{n === 1 ? 'item' : 'itens'}{warn ? ', com aviso' : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section className="preview" aria-label="Pré-visualização" ref={previewRef} tabIndex={-1}>
        <div className="row between" style={{ width: 'min(680px, 100%)' }}>
          <div className="segmented" role="group" aria-label="Modo de visualização">
            {(['limpo', 'original', 'lado'] as const).map((m) => (
              <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'limpo' ? 'Limpo' : m === 'original' ? 'Original' : 'Lado a lado'}</button>
            ))}
          </div>
          <span className="t-caption c-muted truncate" style={{ maxWidth: 260 }}>{file?.file.name}</span>
        </div>
        {file?.warnings.map((w) => (
          <p key={w} className="notice warning t-caption" style={{ width: 'min(680px, 100%)' }}><Icon name="alert" />{w}</p>
        ))}
        {file && (
          <div className={`page${mode === 'lado' ? ' split' : ''}`}>
            {mode !== 'original' && <Doc file={file} review={review} clean onPick={openPop} />}
            {mode !== 'limpo' && <Doc file={file} review={review} clean={false} onPick={openPop} />}
          </div>
        )}
        {!file?.text?.trim() && <p className="t-caption c-muted">Nenhum texto extraído deste arquivo.</p>}
      </section>

      <aside className="pane pane-right" aria-label="Detecções">
        <div className="row between" style={{ paddingBottom: 8 }}>
          <h2 className="t-heading">{active} {active === 1 ? 'item' : 'itens'} a mascarar</h2>
          <Badge tone="accent">Todos os arquivos</Badge>
        </div>
        <p className="sr-only" aria-live="polite">{busy ? 'Atualizando detecções…' : `${active} itens a mascarar`}</p>
        {all.length === 0 && <p className="t-caption c-secondary" style={{ padding: '8px 12px' }}>Nada encontrado. Adicione termos se algo ficou de fora.</p>}
        {CATEGORIES.filter((c) => counts[c] > 0).map((c) => {
          const on = !review.disabled.includes(c);
          return (
            <label key={c} className={`cat-row${on ? '' : ' off'}`}>
              <MaskChip category={c} label={DEFAULT_LABEL[c]} />
              <span className="cat-name t-body">{CATEGORY_NAMES[c]}</span>
              <span className="t-mono c-secondary">{counts[c]}</span>
              <input type="checkbox" role="switch" className="switch" checked={on} onChange={() => toggleCat(c)} aria-label={`Mascarar ${CATEGORY_NAMES[c]} (${counts[c]})`} />
            </label>
          );
        })}
        <AddTerm onAdd={onAddTerm} busy={busy} />
        <MetaList file={file} />
        <div className="sticky-actions">
          <Button variant="secondary" onClick={onBack}>Voltar</Button>
          <Button style={{ flex: 1 }} disabled={busy} onClick={onApply}>{busy ? 'Atualizando…' : 'Aplicar e baixar'}</Button>
        </div>
      </aside>

      {pop && (
        <Popover pop={pop} onClose={closePop}>
          <div className="row gap-2" id="pop-title">
            <MaskChip category={pop.e.category} label={pop.e.label} />
            <span className="t-label">{CATEGORY_NAMES[pop.e.category]}</span>
          </div>
          <p className="t-caption c-secondary">Original: “{pop.e.text}” · {occurrences(pop.e)} {occurrences(pop.e) === 1 ? 'ocorrência' : 'ocorrências'}</p>
          <p className="t-caption c-secondary">Fontes: {pop.e.detections.map((d) => `${SOURCE_NAMES[d.source]} ${d.confidence.toFixed(2).replace('.', ',')}`).join(' · ')}</p>
          <label className="row gap-2 t-caption c-secondary">
            Categoria
            <select value={pop.e.category} onChange={(ev) => { recategorize(pop.e, ev.target.value as Category); closePop(); }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_NAMES[c]}</option>)}
            </select>
          </label>
          <div className="row gap-3">
            <button className="btn-danger-link" onClick={() => { toggleExcluded(pop.e); closePop(); }}>
              {review.excluded.includes(entityKey(pop.e)) ? 'Voltar a mascarar' : 'Não mascarar'}
            </button>
          </div>
        </Popover>
      )}
      <span id="chip-hint" hidden>Abre detalhes da detecção</span>
    </main>
  );
}

function Doc({ file, review, clean, onPick }: { file: FileItem; review: ReviewState; clean: boolean; onPick: (e: Entity, el: HTMLElement) => void }) {
  const text = file.text ?? '';
  const ents = useMemo(() => withOverrides(file.entities ?? [], review).sort((a, b) => a.start - b.start), [file.entities, review]);
  const nodes: ReactNode[] = [];
  let pos = 0;
  const limit = Math.min(text.length, PREVIEW_LIMIT);
  for (const e of ents) {
    if (e.start >= limit) break;
    if (e.start < pos) continue;
    nodes.push(text.slice(pos, e.start));
    const on = isActive(e, review);
    nodes.push(
      clean && on ? (
        <MaskChip key={e.start} category={e.category} label={e.label} dataStart={e.start} describedBy="chip-hint" onClick={(ev) => onPick(e, ev.currentTarget)} />
      ) : (
        <button
          type="button"
          key={e.start}
          data-start={e.start}
          className={`orig${on ? '' : ' chip-off'}`}
          style={{ borderColor: `var(--mask-${e.category}-text)` }}
          aria-describedby="chip-hint"
          title={`${CATEGORY_NAMES[e.category]}: ${on ? 'será mascarado' : 'não será mascarado'}`}
          onClick={(ev) => onPick(e, ev.currentTarget)}
        >
          {e.text}
          {!on && <span className="sr-only"> (não será mascarado)</span>}
        </button>
      ),
    );
    pos = e.end;
  }
  nodes.push(text.slice(pos, limit));
  return (
    <div>
      {nodes}
      {text.length > limit && <p className="t-caption c-muted">… prévia limitada aos primeiros {PREVIEW_LIMIT.toLocaleString('pt-BR')} caracteres. O arquivo inteiro será limpo.</p>}
    </div>
  );
}

function Popover({ pop, onClose, children }: { pop: { x: number; y: number }; onClose: (restore?: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('select, button')?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(false); };
    const focus = (e: FocusEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(false); };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    const t = setTimeout(() => document.addEventListener('mousedown', click));
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('mousedown', click);
    };
  }, []);
  return <div ref={ref} className="popover" role="dialog" aria-modal="false" aria-labelledby="pop-title" style={{ left: pop.x, top: pop.y }}>{children}</div>;
}

function AddTerm({ onAdd, busy }: { onAdd: (t: string, c: Category) => void; busy: boolean }) {
  const [t, setT] = useState('');
  const [c, setC] = useState<Category>('pessoa');
  const submit = () => { if (t.trim() && !busy) { onAdd(t.trim(), c); setT(''); } };
  return (
    <form className="add-term" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Icon name="plus" className="c-accent" />
      {/* readOnly (não disabled) para não perder o foco enquanto re-detecta */}
      <input aria-label="Termo que ficou de fora" placeholder="Adicionar termo que ficou de fora" value={t} onChange={(e) => setT(e.target.value)} readOnly={busy} aria-busy={busy} />
      <span className="add-term-actions">
        <select aria-label="Categoria do termo" value={c} onChange={(e) => setC(e.target.value as Category)}>
          {CATEGORIES.map((k) => <option key={k} value={k}>{CATEGORY_NAMES[k]}</option>)}
        </select>
        <button className="btn btn-ghost" style={{ height: 34 }} type="submit" aria-disabled={busy || !t.trim()}>Adicionar</button>
      </span>
    </form>
  );
}

function MetaList({ file }: { file?: FileItem }) {
  const kind = file?.kind;
  const items =
    kind === 'pdf' ? ['Autor, título, software e datas', 'Metadados XMP e ID do documento', "Marcas d'água e camadas de marca d'água", 'Arquivos anexados']
    : kind === 'docx' ? ['Autor, empresa e datas do arquivo', 'Comentários e histórico de revisões', "Marca d'água nos cabeçalhos", 'EXIF/GPS das imagens', 'Variáveis e modelo do documento']
    : kind === 'xlsx' ? ['Autor, empresa e datas do arquivo', 'Comentários, notas e autores', 'Caminho do arquivo no computador', 'Vínculos externos', 'EXIF/GPS das imagens']
    : ['CSV não tem metadados embutidos'];
  return (
    <div className="stack gap-2" style={{ paddingTop: 20 }}>
      <h3 className="t-label c-muted" style={{ margin: 0 }}>METADADOS E MARCAS D'ÁGUA A REMOVER</h3>
      <ul className="stack gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((m) => (
          <li key={m} className="row gap-2 t-caption c-secondary"><Icon name="check" size={14} className="c-success" />{m}</li>
        ))}
      </ul>
    </div>
  );
}
