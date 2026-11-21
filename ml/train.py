"""Treina CRF (rotulagem de sequência) e regressão logística (classificação de spans) e exporta pesos JSON.

Uso: ml/.venv/bin/python ml/train.py
Saídas: public/models/{crf,logreg,gazetteer}.json e src/detect/__fixtures__/parity.json
"""
import json
from pathlib import Path

import sklearn_crfsuite
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn_crfsuite import metrics

from common import cap_spans, sent_features, span_features, tokenize

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'ml' / 'data'
MODELS = ROOT / 'public' / 'models'
FIXT = ROOT / 'src' / 'detect' / '__fixtures__'
CRF_CATS = {'pessoa': 'PES', 'empresa': 'ORG', 'local': 'LOC'}


def load(name):
    with open(DATA / f'{name}.jsonl', encoding='utf-8') as fh:
        return [json.loads(line) for line in fh]


def load_gaz():
    with open(DATA / 'gazetteer.json', encoding='utf-8') as fh:
        g = json.load(fh)
    return {k: set(v) for k, v in g.items()}, g


def bio(doc):
    toks = tokenize(doc['text'])
    labels = ['O'] * len(toks)
    for s, e, cat, label in doc['spans']:
        if cat not in CRF_CATS or label in ('[endereço]', '[CEP]'):
            continue
        tag = CRF_CATS[cat]
        inside = [k for k, (_, ts, te) in enumerate(toks) if ts >= s and te <= e]
        for n, k in enumerate(inside):
            labels[k] = ('B-' if n == 0 else 'I-') + tag
    return [t[0] for t in toks], labels, toks


def span_dataset(docs, gaz):
    X, y = [], []
    for d in docs:
        words, labels, toks = bio(d)
        for i, j in cap_spans(words):
            s, e = toks[i][1], toks[j - 1][2]
            cls = 'none'
            for gs, ge, cat, label in d['spans']:
                if cat in CRF_CATS and label not in ('[endereço]', '[CEP]'):
                    ov = max(0, min(e, ge) - max(s, gs))
                    if ov / max(1, (e - s)) >= 0.5:
                        cls = cat
                        break
            X.append(span_features(words, i, j, gaz))
            y.append(cls)
    return X, y


def main():
    gaz, gaz_raw = load_gaz()
    train, test = load('train'), load('test')

    # ---------- CRF ----------
    tr = [bio(d) for d in train]
    te = [bio(d) for d in test]
    Xtr = [sent_features(w, gaz) for w, _, _ in tr]
    ytr = [l for _, l, _ in tr]
    Xte = [sent_features(w, gaz) for w, _, _ in te]
    yte = [l for _, l, _ in te]
    crf = sklearn_crfsuite.CRF(algorithm='lbfgs', c1=0.05, c2=0.01, max_iterations=150, all_possible_transitions=True)
    crf.fit(Xtr, ytr)
    pred = crf.predict(Xte)
    labels = [l for l in crf.classes_ if l != 'O']
    print(metrics.flat_classification_report(yte, pred, labels=sorted(labels), digits=3))

    state = {}
    for (attr, label), w in crf.state_features_.items():
        if abs(w) >= 0.01:
            state.setdefault(attr, {})[label] = round(w, 4)
    trans = {f'{a}|{b}': round(w, 4) for (a, b), w in crf.transition_features_.items()}
    MODELS.mkdir(parents=True, exist_ok=True)
    with open(MODELS / 'crf.json', 'w', encoding='utf-8') as fh:
        json.dump({'labels': list(crf.classes_), 'trans': trans, 'state': state}, fh, ensure_ascii=False, separators=(',', ':'))
    print('crf attrs', len(state))

    # ---------- Regressão logística de spans ----------
    Xs, ys = span_dataset(train, gaz)
    Xst, yst = span_dataset(test, gaz)
    vec = DictVectorizer()
    A = vec.fit_transform(Xs)
    clf = LogisticRegression(max_iter=2000, C=2.0, class_weight='balanced')
    clf.fit(A, ys)
    print('logreg acc test', round(clf.score(vec.transform(Xst), yst), 4))
    names = vec.get_feature_names_out()
    coef = {}
    for k, name in enumerate(names):
        col = [round(float(clf.coef_[c][k]), 4) for c in range(len(clf.classes_))]
        if max(abs(v) for v in col) >= 0.01:
            coef[name] = col
    with open(MODELS / 'logreg.json', 'w', encoding='utf-8') as fh:
        json.dump({'classes': list(clf.classes_), 'intercept': [round(float(v), 4) for v in clf.intercept_], 'coef': coef}, fh, ensure_ascii=False, separators=(',', ':'))
    with open(MODELS / 'gazetteer.json', 'w', encoding='utf-8') as fh:
        json.dump(gaz_raw, fh, ensure_ascii=False, separators=(',', ':'))

    # ---------- Fixtures de paridade Python × TS ----------
    FIXT.mkdir(parents=True, exist_ok=True)
    sample = test[:80]
    fx = []
    for d in sample:
        words, _, toks = bio(d)
        feats = sent_features(words, gaz)
        marg = crf.predict_marginals_single(feats)
        spans = []
        for i, j in cap_spans(words):
            p = clf.predict_proba(vec.transform([span_features(words, i, j, gaz)]))[0]
            spans.append({'i': i, 'j': j, 'proba': [round(float(v), 4) for v in p]})
        fx.append({
            'text': d['text'],
            'tokens': [[t, s, e] for t, s, e in toks],
            'crf': crf.predict_single(feats),
            'marg': [round(max(m.values()), 4) for m in marg],
            'spans': spans,
        })
    with open(FIXT / 'parity.json', 'w', encoding='utf-8') as fh:
        json.dump(fx, fh, ensure_ascii=False)
    print('fixtures', len(fx))


if __name__ == '__main__':
    main()
