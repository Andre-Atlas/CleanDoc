/// <reference lib="webworker" />
import { loadBertNer } from '../detect/transformer';
import { Engine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const MODELS = new URL('/models/', self.location.origin).href;

async function nerAvailable(): Promise<boolean> {
  try {
    const r = await fetch(MODELS + 'ner/config.json', { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

const engine = new Engine({
  // só a própria origem (CSP connect-src 'self'); nada sai do dispositivo
  fetchJson: async (path) => {
    const r = await fetch(MODELS + path);
    if (!r.ok) throw new Error(path);
    return r.json();
  },
  loadNer: async (onProgress) => {
    if (!(await nerAvailable())) throw new Error('modelo NER ausente');
    // caminho RELATIVO: o transformers.js ignora caminhos locais que são URLs completas
    return loadBertNer({ modelPath: '/models/', wasmBase: new URL('/ort/', self.location.origin).href, onProgress });
  },
  post: (m: FromWorker) => self.postMessage(m),
});

// fila: processa uma mensagem por vez
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ToWorker>) => {
  queue = queue
    .then(() => engine.handle(e.data))
    .catch(() => {
      // erro inesperado: libera a UI em vez de engolir silenciosamente
      self.postMessage({ type: 'done' } satisfies FromWorker);
    });
};
