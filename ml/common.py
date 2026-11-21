"""Funções compartilhadas entre treino (Python) e inferência (TypeScript).

ATENÇÃO: `fold`, `tokenize`, `token_features`, `cap_spans` e `span_features` têm espelho
exato em src/detect/features.ts. Qualquer mudança aqui exige a mesma mudança lá; o teste
de paridade (src/detect/crf.test.ts) quebra se divergirem.
"""
import re
import unicodedata

ABBREVIATIONS = {
    'sr.', 'sra.', 'srta.', 'dr.', 'dra.', 'prof.', 'profa.', 'eng.', 'adv.', 'exmo.', 'exma.', 'ilmo.', 'ilma.',
    'ltda.', 'cia.', 'av.', 'r.', 'n.', 'nº.', 'no.', 'pça.', 'rod.', 'est.', 'al.', 'tv.', 'me.', 'epp.', 'eireli.',
}

L = r"[^\W\d_]"  # letra unicode
TOKEN_RE = re.compile(
    rf"{L}+(?:[-'’]{L}+)*\.?|\d+(?:[.,/-]\d+)*|[^\s\w]|_",
    re.UNICODE,
)

PARTICLES = {'de', 'da', 'do', 'das', 'dos', 'e'}
COMPANY_SUFFIX = {'ltda', 'ltda.', 's.a.', 's/a', 'sa', 'me', 'epp', 'eireli', 'cia', 'cia.', 'limitada'}
HONORIFICS = {'sr.', 'sra.', 'srta.', 'dr.', 'dra.', 'prof.', 'profa.', 'eng.', 'exmo.', 'exma.', 'ilmo.', 'ilma.',
              'senhor', 'senhora', 'doutor', 'doutora'}


def fold_char(ch):
    base = unicodedata.normalize('NFD', ch)
    base = ''.join(c for c in base if not unicodedata.combining(c)).lower()
    if len(base) == 1:
        return base
    lo = ch.lower()
    return lo[:1] or ch


def fold(s):
    return ''.join(fold_char(c) for c in s)


def tokenize(text):
    toks = []
    for m in TOKEN_RE.finditer(text):
        t, start = m.group(0), m.start()
        if len(t) > 1 and t.endswith('.') and fold(t) not in ABBREVIATIONS:
            toks.append((t[:-1], start, start + len(t) - 1))
            toks.append(('.', start + len(t) - 1, start + len(t)))
        else:
            toks.append((t, start, start + len(t)))
    return toks


def shape(w):
    out = []
    for c in w:
        if c.isdigit():
            s = 'd'
        elif c.isalpha():
            s = 'X' if c.isupper() else 'x'
        else:
            s = c
        if not out or out[-1] != s:
            out.append(s)
    return ''.join(out)[:6]


def is_title(w):
    return len(w) > 0 and w[0].isalpha() and w[0].isupper()


def is_upper(w):
    letters = [c for c in w if c.isalpha()]
    return len(letters) >= 2 and all(c.isupper() for c in letters)


def token_features(words, i, gaz):
    w = words[i]
    f = fold(w)
    feats = {
        'bias': 1.0,
        'w=' + f: 1.0,
        'suf3=' + f[-3:]: 1.0,
        'pre2=' + f[:2]: 1.0,
        'shape=' + shape(w): 1.0,
    }
    if is_title(w):
        feats['title'] = 1.0
    if is_upper(w):
        feats['upper'] = 1.0
    if w.isdigit():
        feats['digit'] = 1.0
    if f in gaz['first']:
        feats['gaz_first'] = 1.0
    if f in gaz['last']:
        feats['gaz_last'] = 1.0
    if f in gaz['org']:
        feats['gaz_org'] = 1.0
    if f in gaz['loc']:
        feats['gaz_loc'] = 1.0
    if f in COMPANY_SUFFIX:
        feats['co_suffix'] = 1.0
    if f in HONORIFICS:
        feats['honor'] = 1.0
    for d in (-2, -1, 1, 2):
        j = i + d
        if 0 <= j < len(words):
            wj = words[j]
            feats[f'w[{d}]=' + fold(wj)] = 1.0
            if is_title(wj):
                feats[f'title[{d}]'] = 1.0
            if abs(d) == 1 and fold(wj) in HONORIFICS:
                feats[f'honor[{d}]'] = 1.0
        elif abs(d) == 1:
            feats['BOS' if d < 0 else 'EOS'] = 1.0
    return feats


def sent_features(words, gaz):
    return [token_features(words, i, gaz) for i in range(len(words))]


def cap_spans(words):
    """Sequências maximais de palavras capitalizadas (com partículas internas). Retorna (i, j) com j exclusivo."""
    spans = []
    i, n = 0, len(words)
    while i < n:
        if is_title(words[i]) and fold(words[i]) not in HONORIFICS:
            j = i + 1
            while j < n:
                if is_title(words[j]) or (fold(words[j]) in COMPANY_SUFFIX and j > i):
                    j += 1
                elif fold(words[j]) in PARTICLES and j + 1 < n and is_title(words[j + 1]):
                    j += 2
                else:
                    break
            spans.append((i, j))
            i = j
        else:
            i += 1
    return spans


def span_features(words, i, j, gaz):
    ws = words[i:j]
    fs = [fold(w) for w in ws]
    feats = {'bias': 1.0, 'n=' + str(min(len(ws), 5)): 1.0, 'first=' + fs[0]: 1.0, 'last=' + fs[-1]: 1.0}
    for f in fs:
        feats['w=' + f] = 1.0
    for d, name in ((-1, 'prev1'), (-2, 'prev2'), (0, 'next1')):
        k = i + d if d < 0 else j
        if 0 <= k < len(words):
            feats[name + '=' + fold(words[k])] = 1.0
        else:
            feats[name + '=<none>'] = 1.0
    if fs[0] in gaz['first']:
        feats['gaz_first_first'] = 1.0
    if fs[-1] in gaz['last']:
        feats['gaz_last_last'] = 1.0
    if any(f in gaz['org'] for f in fs):
        feats['has_org_word'] = 1.0
    if any(f in gaz['loc'] for f in fs):
        feats['has_loc_word'] = 1.0
    if fs[-1] in COMPANY_SUFFIX:
        feats['co_suffix'] = 1.0
    if all(is_upper(w) for w in ws):
        feats['allcaps'] = 1.0
    if i == 0 or words[i - 1] in ('.', ':', ';', '\n', '!', '?'):
        feats['sent_start'] = 1.0
    if i > 0 and fold(words[i - 1]) in HONORIFICS:
        feats['after_honor'] = 1.0
    return feats
