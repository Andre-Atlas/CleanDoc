"""Gerador de corpus sintético PT-BR anotado (spans por caractere).

Saída: ml/data/{train,test}.jsonl com {"text": str, "spans": [[start, end, categoria, rotulo]]}.
O teste usa sementes e TEMPLATES DIFERENTES do treino (generalização, não memorização).
"""
import json
import random
import re
import sys
from pathlib import Path

from faker import Faker

OUT = Path(__file__).parent / 'data'

CITIES = ['São Paulo', 'Rio de Janeiro', 'Brasília', 'Salvador', 'Fortaleza', 'Belo Horizonte', 'Manaus', 'Curitiba', 'Recife',
          'Goiânia', 'Belém', 'Porto Alegre', 'Guarulhos', 'Campinas', 'São Luís', 'São Gonçalo', 'Maceió', 'Duque de Caxias',
          'Campo Grande', 'Natal', 'Teresina', 'São Bernardo do Campo', 'Nova Iguaçu', 'João Pessoa', 'Santo André', 'Osasco',
          'Jaboatão dos Guararapes', 'Ribeirão Preto', 'Uberlândia', 'Contagem', 'Sorocaba', 'Aracaju', 'Feira de Santana',
          'Cuiabá', 'Joinville', 'Aparecida de Goiânia', 'Londrina', 'Juiz de Fora', 'Ananindeua', 'Porto Velho', 'Serra',
          'Niterói', 'Caxias do Sul', 'Macapá', 'Florianópolis', 'Vila Velha', 'Mauá', 'São João de Meriti', 'São José dos Campos',
          'Santos', 'Mogi das Cruzes', 'Betim', 'Diadema', 'Campina Grande', 'Jundiaí', 'Maringá', 'Montes Claros', 'Piracicaba',
          'Carapicuíba', 'Olinda', 'Cariacica', 'Rio Branco', 'Anápolis', 'Bauru', 'Vitória', 'Caucaia', 'Itaquaquecetuba',
          'São Vicente', 'Caruaru', 'Vitória da Conquista', 'Blumenau', 'Franca', 'Pelotas', 'Ponta Grossa', 'Canoas', 'Petrolina',
          'Boa Vista', 'Palmas', 'Taguatinga', 'Ceilândia', 'Sobradinho', 'Águas Claras', 'Petrópolis', 'Chapecó', 'Dourados']
UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']
ORG_TYPES = ['Construtora', 'Incorporadora', 'Banco', 'Instituto', 'Grupo', 'Transportadora', 'Distribuidora', 'Consultoria',
             'Clínica', 'Laboratório', 'Fundação', 'Associação', 'Cooperativa', 'Editora', 'Seguradora', 'Imobiliária', 'Agropecuária',
             'Indústria', 'Comércio', 'Hospital', 'Escola', 'Colégio', 'Farmácia', 'Supermercado', 'Mineradora', 'Agência']
ORG_NAMES = ['Horizonte', 'Atlântico', 'Nova Era', 'Aurora', 'Primavera', 'Planalto', 'Cerrado', 'Ipê', 'Jacarandá', 'Boa Vista',
             'Vale Verde', 'Sol Nascente', 'Estrela', 'Bandeirantes', 'Pioneira', 'União', 'Progresso', 'Alfa', 'Ômega', 'Delta',
             'Vitória', 'Esperança', 'Santa Clara', 'São Jorge', 'Rio Doce', 'Serra Azul', 'Brasil Central', 'Norte Sul', 'Mar Azul']
ORG_SUFFIX = ['Ltda.', 'Ltda', 'S.A.', 'S/A', 'LTDA', 'ME', 'EPP', 'EIRELI', '']
PUBLIC = ['Universidade Federal de {uf_city}', 'Prefeitura de {city}', 'Secretaria de Saúde de {city}', 'Tribunal de Justiça de {state}',
          'Ministério Público de {state}', 'Câmara Municipal de {city}', 'Defensoria Pública de {state}', 'Instituto Federal de {state}']
STATES = ['São Paulo', 'Minas Gerais', 'Goiás', 'Bahia', 'Pernambuco', 'Paraná', 'Santa Catarina', 'Ceará', 'Pará', 'Amazonas', 'Mato Grosso', 'Rio Grande do Sul']
HONOR = ['Sr.', 'Sra.', 'Dr.', 'Dra.', 'Prof.', 'Profa.']
NEG_CAPS = ['Cláusula Primeira', 'Parágrafo Único', 'Contrato', 'Anexo I', 'Considerando', 'Objeto', 'Janeiro', 'Março', 'Dezembro',
            'Atenciosamente', 'Prezados', 'Termo Aditivo', 'Lei Geral de Proteção de Dados', 'Código Civil', 'Item', 'Total', 'Observação']

# {X} = slot; categorias: P pessoa, E empresa, L local (cidade), A endereço, V valor, C CPF, J CNPJ, M e-mail, T telefone, K conta, Z CEP, G agência
TRAIN_TEMPLATES = [
    'Pelo presente instrumento, {E}, inscrita no CNPJ sob o nº {J}, com sede na {A}, {L}, neste ato representada por {P}, portador do CPF {C}, doravante denominada CONTRATANTE.',
    'O valor total dos serviços é de {V}, a ser pago em três parcelas na conta {K} da agência {G}.',
    'Prezado {H} {P}, segue em anexo a proposta da {E} para o projeto em {L}.',
    'Cláusula Quarta. A execução ocorrerá em {L}, sob supervisão de {P}, com início em março.',
    'Contato: {P}, telefone {T}, e-mail {M}.',
    'Eu, {P}, inscrito no CPF {C}, residente e domiciliado na {A}, CEP {Z}, declaro para os devidos fins.',
    'A {E} compromete-se a entregar os equipamentos em {L} até o dia 15.',
    'Testemunhas: {P} e {P}.',
    'Reunião com {P} ({E}) sobre o orçamento de {V}.',
    'Considerando que {P} é sócio majoritário da {E}, fica ajustado o seguinte.',
    '{L}, 12 de março de 2025.',
    'Ata da reunião realizada em {L} com a presença de {H} {P}, {H} {P} e representantes da {E}.',
    'Favor depositar {V} até sexta-feira. Dúvidas com {P} pelo {T}.',
    'Atenciosamente,\n{P}\n{E}',
    'Nome: {P}; CPF: {C}; Endereço: {A}; Cidade: {L}; Salário: {V}.',
    'O contratado, {P}, prestará serviços à {E} na unidade de {L}.',
    'Encaminho o relatório da {E} para análise do {H} {P}.',
    'Fica eleito o foro da comarca de {L} para dirimir quaisquer dúvidas.',
    'Paciente {P}, atendido no {E} em {L}, apresentou melhora.',
    'Transferência de {V} da conta {K} para {P}, chave PIX {M}.',
    '{P}, brasileiro, casado, engenheiro, natural de {L}, filho de {P}.',
    'A {E} e a {E} firmam parceria para atuação em {L}.',
    'Cliente: {E} | Responsável: {P} | Valor: {V}',
    'Objeto: prestação de serviços de consultoria pela {E}.',
    'Conforme {P}, o prazo foi prorrogado.',
    'Hoje {P} visitou a sede da {E} em {L}.',
    'Ontem {P} e {P} assinaram o termo.',
    'Para {P}: favor revisar o anexo.',
    'Quando {P} chegou a {L}, a reunião já havia começado.',
    'De acordo com a {E}, o pedido foi enviado.',
    'Após análise, {H} {P} aprovou o orçamento de {V}.',
    'Ainda assim, {P} manteve a proposta da {E}.',
    'Bom dia, {P}! Tudo certo para amanhã em {L}?',
    'Obrigado, {P}. Abraços, {P}.',
]
TEST_TEMPLATES = [
    'Firmam o presente acordo {E}, CNPJ {J}, e {P}, CPF {C}, residente em {L}.',
    'Segundo {P}, a {E} pretende investir {V} na nova fábrica de {L}.',
    'Prezada {H} {P},\nConfirmamos o recebimento do pagamento de {V}. Equipe {E}.',
    'Locador: {P}. Locatário: {P}. Imóvel situado na {A}, {L}, CEP {Z}.',
    'Nota de reembolso: {P} gastou {V} em hospedagem em {L}; aprovado por {P}.',
    'O {E} informa que o boleto de {V} vence amanhã. Contato {T} ou {M}.',
    'Procuração: outorgante {P}, CPF {C}; outorgado {H} {P}, para representá-lo perante a {E}.',
    'Foram entrevistados {P}, {P} e {P}, todos funcionários da {E} em {L}.',
    'Dados bancários do fornecedor {E}: agência {G}, conta {K}.',
    'Relatório: a filial de {L} da {E} faturou {V} no trimestre, segundo {P}.',
]


def make_faker(seed):
    f = Faker('pt_BR')
    f.seed_instance(seed)
    return f


def person(f, rnd):
    name = f.name()
    name = re.sub(r'^(Sr\.|Sra\.|Srta\.|Dr\.|Dra\.)\s+', '', name)
    if rnd.random() < 0.2:
        parts = name.split()
        name = ' '.join(parts[:1] + [rnd.choice(['da', 'de', 'dos'])] + parts[1:])
    if rnd.random() < 0.05:
        name = name.upper()
    return name


def company(f, rnd):
    r = rnd.random()
    if r < 0.35:
        return f.company()
    if r < 0.85:
        s = rnd.choice(ORG_SUFFIX)
        base = f'{rnd.choice(ORG_TYPES)} {rnd.choice(ORG_NAMES)}'
        return f'{base} {s}'.strip()
    tpl = rnd.choice(PUBLIC)
    return tpl.format(city=rnd.choice(CITIES), state=rnd.choice(STATES), uf_city=rnd.choice(STATES))


def money(f, rnd):
    r = rnd.random()
    n = rnd.randint(100, 2_000_000)
    br = f'{n:,}'.replace(',', '.')
    if r < 0.6:
        return f'R$ {br},{rnd.randint(0, 99):02d}'
    if r < 0.75:
        return f'R$ {rnd.randint(1, 900)} mil'
    if r < 0.85:
        return f'US$ {br}'
    return rnd.choice(['dez mil reais', 'quinhentos reais', 'dois milhões de reais', 'mil e duzentos reais', 'trezentos e cinquenta reais'])


def fill(template, f, rnd):
    text, spans = '', []
    for part in re.split(r'(\{[A-Z]\})', template):
        m = re.fullmatch(r'\{([A-Z])\}', part)
        if not m:
            text += part
            continue
        k = m.group(1)
        if k == 'H':
            text += rnd.choice(HONOR)
            continue
        val, cat, label = {
            'P': lambda: (person(f, rnd), 'pessoa', '[nome pessoal]'),
            'E': lambda: (company(f, rnd), 'empresa', '[empresa]'),
            'L': lambda: (rnd.choice(CITIES) + (('/' + rnd.choice(UFS)) if rnd.random() < 0.3 else ''), 'local', '[local]'),
            'A': lambda: (f.street_name() + ', ' + str(rnd.randint(1, 3000)), 'local', '[endereço]'),
            'V': lambda: (money(f, rnd), 'valor', '[valor]'),
            'C': lambda: (f.cpf(), 'documento', '[CPF]'),
            'J': lambda: (f.cnpj(), 'documento', '[CNPJ]'),
            'M': lambda: (f.email(), 'contato', '[e-mail]'),
            'T': lambda: (rnd.choice(['(61) 9', '(11) 9', '(21) 3', '(62) 9']) + f'{rnd.randint(1000, 9999)}-{rnd.randint(1000, 9999)}', 'contato', '[telefone]'),
            'K': lambda: (f'{rnd.randint(10000, 99999)}-{rnd.randint(0, 9)}', 'bancario', '[dado bancário]'),
            'G': lambda: (f'{rnd.randint(1000, 9999)}-{rnd.randint(0, 9)}', 'bancario', '[dado bancário]'),
            'Z': lambda: (f.postcode(), 'local', '[CEP]'),
        }[k]()
        spans.append([len(text), len(text) + len(val), cat, label])
        text += val
    return {'text': text, 'spans': spans}


def noise(rnd):
    s = rnd.choice(NEG_CAPS)
    return {'text': f'{s}. ' + rnd.choice(['Este documento segue as normas vigentes.', 'Ver tabela abaixo.', 'Conforme acordado.']), 'spans': []}


def generate(templates, n, seed):
    rnd = random.Random(seed)
    f = make_faker(seed)
    out = []
    for _ in range(n):
        if rnd.random() < 0.08:
            out.append(noise(rnd))
        else:
            out.append(fill(rnd.choice(templates), f, rnd))
    return out


def gazetteers():
    f = Faker('pt_BR')
    from common import fold
    p = f.provider('faker.providers.person')
    first = sorted({fold(n) for n in list(p.first_names_male) + list(p.first_names_female)})
    last = sorted({fold(n) for n in p.last_names})
    org = sorted({fold(w) for w in ORG_TYPES} | {'universidade', 'prefeitura', 'secretaria', 'tribunal', 'ministerio', 'camara', 'defensoria', 'banco', 'empresa'})
    loc = sorted({fold(w) for c in CITIES for w in c.split() if len(w) > 3} | {fold(s) for s in STATES for _ in [0]})
    return {'first': first, 'last': last, 'org': org, 'loc': loc}


if __name__ == '__main__':
    n_train = int(sys.argv[1]) if len(sys.argv) > 1 else 6000
    OUT.mkdir(exist_ok=True)
    for name, data in (('train', generate(TRAIN_TEMPLATES, n_train, 7)), ('test', generate(TEST_TEMPLATES, 1500, 2025))):
        with open(OUT / f'{name}.jsonl', 'w', encoding='utf-8') as fh:
            for d in data:
                fh.write(json.dumps(d, ensure_ascii=False) + '\n')
    with open(OUT / 'gazetteer.json', 'w', encoding='utf-8') as fh:
        json.dump(gazetteers(), fh, ensure_ascii=False)
    print('ok', n_train)
