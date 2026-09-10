# PIL — Project Intelligence Layer

**Camada de inteligência contextual entre o código-fonte e agentes de IA.**
Reduz os tokens enviados ao LLM selecionando só o contexto que a tarefa precisa.

![licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)
![Node 22+](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen)
![151 testes](https://img.shields.io/badge/testes-151-brightgreen)
![sem dependência nativa](https://img.shields.io/badge/build-sem%20node--gyp-brightgreen)

Projetos grandes não cabem numa janela de contexto. A resposta usual é mandar o
máximo possível de código e torcer. O PIL faz **análise estática** com
[Tree-sitter](https://tree-sitter.github.io/), constrói um **grafo de
dependências** do projeto e usa isso para responder a uma pergunta específica:

> Qual é o menor conjunto de informação suficiente para executar **esta** tarefa?

```bash
pil context "corrigir o cálculo de comissão" --budget 20000
```

```
  projeto inteiro  1.884.846 tokens
  selecionado          7.591 tokens
  ████████████████████  99.6% de redução
  arquivos  12 de 421
```

O pacote resultante vai direto para o Claude, ChatGPT ou qualquer agente:
`pil context "minha tarefa" --raw | claude -p`.

## Por que existe

Mandar o repositório inteiro para um LLM custa caro, estoura a janela de
contexto e **piora** a resposta o modelo se perde em código irrelevante. As
alternativas usuais têm limites conhecidos: busca por embeddings ignora a
estrutura do código, e `grep` não sabe quem chama quem.

O PIL trata o projeto como **grafo, não como texto**: entidades (funções,
classes, componentes, endpoints), relações (importa, chama, herda, testa) e
confiança declarada em cada aresta. A seleção de contexto navega esse grafo.

Feito para quem escreve tarefas em **português** sobre código com
identificadores em inglês um desencontro que quebra busca lexical ingênua e
que teve tratamento específico aqui (cognatos, acentuação, dicionário de
domínio).

## Funciona hoje

- **`pil scan`** — indexa TypeScript, JavaScript, TSX e Python (ESM **e**
  CommonJS). Incremental: 421 arquivos reindexam em ~1s quando nada muda.
- **`pil context "tarefa"`** — monta o pacote sob um orçamento de tokens, com
  três níveis de detalhe (código completo, só a assinatura, só a referência).
- **`pil impact "MinhaFuncao"`** — o que quebra se isso mudar, com a confiança
  de cada caminho declarada em vez de escondida.
- **`pil status`** — cobertura do índice, saúde do grafo e se está desatualizado.
- **`npm run bench`** — mede o próprio benefício contra commits reais do seu
  repositório.

Roda **100% local**: nada sai da máquina, sem banco para instalar, sem
compilador C++.

## Estado atual

Fase 1 (MVP) — usável, com uma meta ainda não atingida.

| Componente | Estado |
|---|---|
| Modelo semântico (entidades, relações, confiança) | **pronto** |
| Storage + schema + grafo + FTS | **pronto** |
| Indexação incremental (diff, purge, re-resolução) | **pronto** |
| Scanner (walk, ignore, secrets, hash) | **pronto** |
| Estimativa de tokens | **pronto** |
| Parser TS/JS/TSX + Python (ESM e CommonJS) | **pronto** |
| Resolução com tiers de confiança | **pronto** |
| CLI (`init`, `scan`, `status`, `context`, `impact`) | **pronto** |
| Context Engine + Compiler | **pronto** |
| Benchmark (corpus de commits reais) | **pronto** |
| Embeddings, AI Gateway, dashboard, migração | Fases 2–4 |

O MVP roda ponta a ponta e está instalável. Medido em 14 commits reais de um
SaaS de gestão privado (Next.js + API Node, interface em português):

```
redução    █████████████████░░░  86%     meta ≥80%   ✓
recall     ███████████░░░░░░░░░  57%     meta ≥80%   ✗
precisão   ████░░░░░░░░░░░░░░░░  22%
time to context  160ms (p95 373ms)       meta <2s    ✓
```

**O critério de saída da Fase 1 não foi atingido**: o recall está a três quartos
do caminho. Os 5 casos que ainda falham são edições de conteúdo/apresentação
descritas em vocabulário que não aparece em identificador o sinal que resolve
isso é similaridade semântica de texto, ou seja, embeddings (Fase 2). O histórico
completo das medições, com o que cada mudança ensinou, está em
`docs/BENCHMARK.md`.

## Requisitos

- **Node.js ≥ 22.13** — o projeto usa o `node:sqlite` embutido.
- Nada além disso: sem banco para instalar, sem compilador C++, sem serviço
  externo.

As quatro dependências de execução são as gramáticas tree-sitter e o runtime
WASM, todas com `.wasm` pré-compilado nenhuma exige node-gyp/MSVC, que é onde
a instalação costuma falhar no Windows.

## Como rodar

```bash
npm install
npm run build
npm link           # deixa o comando `pil` disponível no sistema
```

## Uso

```bash
cd /caminho/do/seu/projeto
pil init                      # cria .pil/ (auto-ignorado no git)
pil scan                      # indexa; incremental nas próximas vezes
pil status                    # cobertura e saúde do índice

pil context "corrigir o cálculo de comissão" --budget 20000 --explain
pil impact "calculateCommission" --min-confidence 0.6
```

`--explain` mostra por que cada entidade entrou. `--min-confidence` filtra
arestas resolvidas por palpite — vale usar em `impact` antes de confiar no
resultado.

### Verificação

```bash
npm test           # 151 testes
npm run typecheck
npm run demo       # demonstra a fundação sem tocar em disco
```

Para canalizar o contexto direto a um agente:

```bash
pil context "adicionar desconto progressivo" --raw | claude -p
```

`--raw` imprime só o pacote, sem relatório qualquer texto de relatório na saída
viraria contexto espúrio para o modelo.

### Benchmark

```bash
npm run bench -- --repo ../outro-projeto --limit 20 --budget 20000
```

Usa commits reais como gabarito (mensagem = tarefa, arquivos alterados = resposta)
e mede recall junto com redução. Ver `docs/BENCHMARK.md`.

### Retomar um trabalho em andamento

`pil context --raw` já é um prompt completo, pronto para colar num chat:

```powershell
pil context "terminar a validacao de CNPJ" --raw | Set-Clipboard
```

Mas ele descreve o código como está *indexado*. Quando você parou no meio de
uma alteração, o que mais importa é o que você já mudou e isso o PIL não sabe,
o git sabe. `examples/pil-continuar.ps1` junta os dois:

```powershell
.\pil-continuar.ps1 "terminar a validacao de CNPJ no cadastro" -Clipboard
```

Ele atualiza o índice, descobre pelo git os arquivos que você tocou, força esses
arquivos no contexto via `--include`, inclui o diff, e monta um prompt com três
seções: o que você quer fazer, o que já alterou, e o contexto relevante do resto.

Para listas longas de arquivos use `--include-from <arquivo>` (um caminho por
linha, `#` para comentário). A linha de comando do Windows tem teto de ~32 KB, e
`--include` repetido estoura antes do que parece — 246 arquivos foram suficientes.

O passo do git só funciona se **o projeto for um repositório git próprio**. Num
projeto não rastreado o git reporta todos os arquivos como novos e não há sinal
sobre onde você parou; o script detecta isso, avisa e segue apenas com o
contexto do PIL.

### Ajustar ao seu domínio

Quando a tarefa usa uma palavra que o código não tem, declare o grupo em
`.pil/config.json`:

```json
{
  "context": {
    "dictionary": [["ocorrencia", "ticket", "chamado"]]
  }
}
```

Mantenha a lista curta e específica do projeto: um dicionário amplo foi medido e
**piorou** o contexto (`docs/BENCHMARK.md`). Há grupos de partida em
`src/core/lexicon.ts` para copiar e recortar.

Exemplo real: num projeto onde a conexão vive num `db.js`, a tarefa
"corrigir a conexão com o banco de dados" não encontrava o arquivo `db` e
"banco de dados" não são cognatos. Com o grupo
`["db", "banco", "dados", "conexao", "pool"]` declarado, os arquivos de conexão
passaram a ocupar as primeiras posições.

### Desempenho

Num projeto de 421 arquivos (1,9 milhão de tokens): scan completo ~39s, scan
incremental sem alterações ~1,1s. O atalho de `mtime` evita reler arquivos
intactos; `--rebuild` força a releitura quando necessário.

### Comandos ainda não implementados

`ask`, `graph`, `analyze`, `migrate`, `export` falham indicando a fase do
roadmap em que entram, em vez de "comando desconhecido".

## Estrutura

```
src/
├── core/
│   ├── types/      modelo semântico: entidade, relação, arquivo, contexto
│   ├── config/     .pil/config.json e políticas de segurança
│   ├── ids.ts      identidade estável de entidades
│   ├── text.ts     quebra de identificadores, cognatos, literais
│   ├── lexicon.ts  dicionário de domínio (opt-in)
│   ├── git.ts      recência de alteração
│   └── tokens.ts   estimativa de custo em tokens
├── storage/        interface + adapter SQLite
├── scanner/        walk, ignore no estilo gitignore, barreira de segredos
├── parser/         tree-sitter WASM, extratores TS/JS/TSX e Python, resolver
├── indexer/        orquestração scan → parse → índice → resolução
├── context/        task, relevance, compiler, engine, impact
├── bench/          corpus de commits e harness de medição
└── cli/            bin + comandos

docs/
├── ARCHITECTURE.md   decisões, trade-offs, riscos
├── RELEVANCE.md      algoritmo de pontuação
├── BENCHMARK.md      como o benefício é medido
└── ROADMAP.md        fases
```

## Decisões que fogem da especificação original

Três, todas documentadas com justificativa em `docs/ARCHITECTURE.md`:

- **SQLite em vez de PostgreSQL** no MVP, atrás de uma interface `Storage`
  assíncrona — o adapter Postgres da Fase 5 é aditivo, não retrabalho.
- **Fastify adiado** para a Fase 3: o MVP é CLI e o core já é biblioteca.
- **Filtro de segredos antes da indexação**, não antes do envio — o próprio
  índice é um artefato que pode vazar.

## Segurança

O modo padrão é `local`: nada sai da máquina. Arquivos de credencial (`.env`,
chaves privadas, `.aws/`, `.ssh/`) são barrados antes de entrar no índice, e o
motivo do descarte fica registrado um arquivo ausente do índice sem registro é
indistinguível de um bug.

## Limite conhecido

A busca lexical resolve a barreira de **forma** (`"fix commission calculation"`
encontra `calculateCommission`), mas não a de **idioma**: uma tarefa escrita em
português não alcança identificadores em inglês, porque `comissão` e
`commission` são palavras distintas para o índice.

Isso é exatamente o cenário de uso previsto aqui, então está tratado como item de
roadmap e não como detalhe: `docs/ARCHITECTURE.md` seção 10 descreve as três
saídas em ordem de custo. Dois testes em `tests/unit/text.test.ts` documentam o
limite e vão falhar de propósito quando ele for resolvido.

## Contribuindo

Contribuições são bem-vindas. O que ajuda mais, em ordem:

1. **Rodar o PIL no seu projeto e relatar o que deu errado.** Foi assim que
   todos os defeitos sérios apareceram CommonJS não reconhecido, acentuação
   quebrando a busca, nome de arquivo afogado no índice. Nenhum deles apareceu
   em teste sintético. Abra uma issue com a tarefa que você pediu e o que
   esperava receber.
2. **Um extrator para outra linguagem.** O contrato está em
   `src/parser/extraction.ts`; os de TS/JS e Python servem de referência. Nada
   fora de `src/parser/extractors/` precisa mudar.
3. **Melhorar o recall.** A meta da Fase 1 é 80% e estamos em 57%. Toda mudança
   nessa direção precisa vir com o número do benchmark antes e depois.

Antes de abrir um PR: `npm test && npm run typecheck && npm run build`.

Duas convenções do projeto:

- **Comentário explica *por que*, não *o quê*.** Vários comentários no código
  registram a medição que motivou a decisão é o que impede alguém (inclusive o
  autor) de "simplificar" de volta para a versão errada.
- **Número medido vence argumento.** Ordenar por densidade parecia certo na
  teoria e estava errado no objetivo; o benchmark mostrou. Um dicionário amplo de
  sinônimos parecia obviamente útil e piorou a precisão de 22% para 7%; foi
  revertido. Ambos estão documentados em `docs/BENCHMARK.md`.

## Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | decisões, trade-offs, riscos e os bugs que o uso real revelou |
| [`docs/RELEVANCE.md`](docs/RELEVANCE.md) | como o contexto é pontuado e selecionado |
| [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | como o benefício é medido, e o histórico das medições |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | fases, o que falta e por quê |

## Licença

MIT — ver [LICENSE](LICENSE).
