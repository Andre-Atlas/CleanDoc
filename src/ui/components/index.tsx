import { useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import type { Category } from '../../core/types';
import { Icon } from './Icon';

export { Icon };

export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button type="button" className={`btn btn-${variant} ${className}`} {...p} />;
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function MaskChip({ category, label, onClick, dataStart, describedBy }: { category: Category; label: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; dataStart?: number; describedBy?: string }) {
  const cls = `chip chip-${category}`;
  // nome acessível = texto visível (WCAG 2.5.3); a dica vai em aria-describedby
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} data-start={dataStart} aria-describedby={describedBy}>{label}</button>
  ) : (
    <span className={cls}>{label}</span>
  );
}

export function PrivacySeal() {
  return (
    <span className="seal t-label" title="Processado no seu dispositivo · nada é enviado">
      <Icon name="shield" />
      <span className="seal-text">Processado no seu dispositivo · nada é enviado</span>
    </span>
  );
}

const STEPS = ['Adicionar', 'Revisar', 'Baixar'];
export function AppHeader({ step }: { step: 1 | 2 | 3 }) {
  return (
    <header className="header">
      <div className="logo">
        <span className="logo-mark" aria-hidden="true">[ ]</span>
        <span>Doc Cleaner</span>
      </div>
      <nav aria-label="Etapas">
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li key={s} className={`step t-label${i + 1 < step ? ' done' : ''}`} aria-current={i + 1 === step ? 'step' : undefined}>
              <span className="step-num">{i + 1 < step ? <Icon name="check" size={12} /> : i + 1}</span>
              <span className="step-label">{s}</span>
              <span className="sr-only">{i + 1 < step ? ' (concluída)' : i + 1 === step ? ' (atual)' : ''}</span>
              {i < 2 && <span className="step-line" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </nav>
      <PrivacySeal />
    </header>
  );
}

/** Campo multi-termo: Enter, vírgula ou colar lista criam chips; Backspace no vazio remove o último. */
export function TermInput({ label, terms, onChange, placeholder = 'Digite e pressione Enter' }: { label: string; terms: string[]; onChange: (t: string[]) => void; placeholder?: string }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const items = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    const next = [...terms];
    for (const it of items) if (!next.some((t) => t.toLowerCase() === it.toLowerCase())) next.push(it);
    if (next.length !== terms.length) onChange(next);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && draft.trim()) { e.preventDefault(); add(draft); }
    else if (e.key === 'Backspace' && !e.repeat && !draft && terms.length) onChange(terms.slice(0, -1));
  };
  return (
    <div className="stack gap-2">
      <div className="row between">
        <label htmlFor={id} className="t-label">{label}</label>
        <span className="t-caption c-muted" aria-live="polite">{terms.length ? `${terms.length} ${terms.length === 1 ? 'termo' : 'termos'}` : ''}</span>
      </div>
      {/* clique na área vazia foca o campo (conveniência de ponteiro; teclado chega ao input pelo Tab) */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="term-field" onClick={() => input.current?.focus()}>
        {terms.map((t) => (
          <span key={t} className="term-chip">
            {t}
            <button type="button" aria-label={`Remover ${t}`} onClick={(e) => { e.stopPropagation(); onChange(terms.filter((x) => x !== t)); }}>
              <Icon name="x" size={14} />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={input}
          value={draft}
          placeholder={terms.length ? 'Digite e pressione Enter' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && add(draft)}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\n,;]/.test(t)) { e.preventDefault(); add(draft + t); } }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

export function ProgressBar({ value, large, label }: { value: number; large?: boolean; label?: string }) {
  return (
    <div className={`bar${large ? ' lg' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
