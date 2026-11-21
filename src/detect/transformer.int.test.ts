/**
 * Integração com o modelo real (172 MB). Roda só com NER=1 e o modelo baixado (`npm run models:fetch`).
 *   NER=1 npx vitest run src/detect/transformer.int.test.ts
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectTransformer, loadBertNer } from './transformer';

const modelPath = resolve(__dirname, '../../public/models') + '/';
const run = process.env.NER === '1' && existsSync(modelPath + 'ner/onnx/model_quantized.onnx');

describe.skipIf(!run)('BERTimbau NER (ONNX local)', () => {
  it('detecta pessoa, organização e local com offsets corretos', async () => {
    const ner = await loadBertNer({ modelPath });
    const t = 'O réu Joaquim Barbosa Neto, funcionário da Petrobras, mora em Belo Horizonte desde 2010.';
    const c = (await detectTransformer(t, ner)).map((x) => `${x.category}:${t.slice(x.start, x.end)}`);
    expect(c).toContain('pessoa:Joaquim Barbosa Neto');
    expect(c).toContain('empresa:Petrobras');
    expect(c).toContain('local:Belo Horizonte');
  }, 120000);
});
