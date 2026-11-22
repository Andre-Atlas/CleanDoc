import { useEffect, useRef, useState } from 'react';
import type { Category, UserTerm } from './core/types';
import { AppHeader } from './ui/components';
import { emptyReview, emptyTerms, finalEntities, toUserTerms, type ReviewState, type TermFields } from './ui/review';
import { Aplicando } from './ui/screens/Aplicando';
import { Concluido } from './ui/screens/Concluido';
import { Entrada } from './ui/screens/Entrada';
import { Processamento } from './ui/screens/Processamento';
import { Revisao } from './ui/screens/Revisao';
import { useCleaner } from './ui/useCleaner';

type Screen = 'entrada' | 'processamento' | 'revisao' | 'aplicando' | 'concluido';

const TITLES: Record<Screen, string> = {
  entrada: 'Adicionar arquivos',
  processamento: 'Analisando',
  revisao: 'Revisar detecções',
  aplicando: 'Gerando arquivos limpos',
  concluido: 'Arquivos limpos',
};

const defaultWorker = () => new Worker(new URL('./worker/clean.worker.ts', import.meta.url), { type: 'module' });

export function App({ createWorker = defaultWorker }: { createWorker?: () => Worker }) {
  const c = useCleaner(createWorker);
  const [screenState, setScreen] = useState<Screen>('entrada');
  // aplicando → concluído quando cada arquivo pedido tiver resultado OU erro (derivado, sem efeito)
  const screen: Screen = screenState === 'aplicando' && c.pending.length === 0 ? 'concluido' : screenState;
  const [terms, setTerms] = useState<TermFields>(emptyTerms);
  const [extra, setExtra] = useState<UserTerm[]>([]);
  const [review, setReview] = useState<ReviewState>(emptyReview);
  const [stripRasterWatermark, setStripRasterWatermark] = useState(true);
  /** termos usados na última detecção, para saber se mudaram ao voltar da revisão */
  const detectedWith = useRef('');
  const allTerms = toUserTerms(terms, extra);
  const termsKey = JSON.stringify(allTerms);

  // Troca de tela: título do documento e foco no h1 (leitores de tela anunciam a nova tela).
  const first = useRef(true);
  useEffect(() => {
    document.title = `${TITLES[screen]} · Doc Cleaner`;
    if (first.current) { first.current = false; return; }
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main h1')?.focus());
  }, [screen]);

  // Novos arquivos: analisa (a detecção roda sobre todos, com os termos atuais, por causa da propagação).
  const start = () => {
    detectedWith.current = termsKey;
    c.analyze(allTerms, { stripRasterWatermark });
    setScreen('processamento');
  };
  const continueReview = () => {
    if (termsKey !== detectedWith.current) { detectedWith.current = termsKey; c.redetect(allTerms); setScreen('processamento'); }
    else setScreen('revisao');
  };
  const clear = () => {
    c.reset();
    setTerms(emptyTerms());
    setExtra([]);
    setReview(emptyReview());
    detectedWith.current = '';
    setScreen('entrada');
  };
  const cancel = () => { c.cancel(); setScreen('entrada'); };

  const addTerm = (text: string, category: Category) => {
    const next = [...extra, { text, category }];
    setExtra(next);
    const t = toUserTerms(terms, next);
    detectedWith.current = JSON.stringify(t);
    c.redetect(t);
  };

  const applyAll = () => {
    c.applyAll(c.files.filter((x) => x.status === 'pronto').map((f) => ({ id: f.id, entities: finalEntities(f.entities ?? [], review) })));
    setScreen('aplicando');
  };


  // avisa antes de fechar com arquivos ainda não baixados (nada é salvo)
  useEffect(() => {
    if (!c.files.length) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [c.files.length]);

  const step = screen === 'entrada' || screen === 'processamento' ? 1 : screen === 'revisao' ? 2 : 3;

  return (
    <div className="app">
      <AppHeader step={step} />
      {screen === 'entrada' && (
        <Entrada
          files={c.files}
          models={c.models}
          terms={terms}
          onTerms={setTerms}
          stripRasterWatermark={stripRasterWatermark}
          onStripRasterWatermark={setStripRasterWatermark}
          onAdd={c.addFiles}
          onRemove={c.removeFile}
          onClear={clear}
          onStart={start}
          onContinue={continueReview}
        />
      )}
      {screen === 'processamento' && <Processamento files={c.files} busy={c.busy} onCancel={cancel} onReview={() => setScreen('revisao')} />}
      {screen === 'revisao' && (
        <Revisao files={c.files} review={review} onReview={setReview} onAddTerm={addTerm} busy={c.busy} onBack={() => setScreen('entrada')} onApply={applyAll} />
      )}
      {screen === 'aplicando' && <Aplicando files={c.files} pending={c.pending} />}
      {screen === 'concluido' && <Concluido files={c.files} termsApplied={allTerms.length} onClear={clear} onRetry={applyAll} />}
    </div>
  );
}
