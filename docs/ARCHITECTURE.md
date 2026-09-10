# Arquitetura do MVP

Documento de decisões. Registra o que foi escolhido, o que foi recusado e por quê.
Referências a "spec §N" apontam para a especificação mestre do PIL.

## 1. Princípio de corte

O PIL responde a uma pergunta: *qual o menor conjunto de informação suficiente
para um agente executar esta tarefa corretamente?*

Isso implica duas métricas acopladas, e a segunda é a que dá honestidade à primeira:

| Métrica | O que mede | Como se falsifica sozinha |
|---|---|---|
| Redução de tokens | Economia | Enviar nada reduz 100% |
| **Recall do conjunto necessário** | Não perder o essencial | Enviar tudo garante 100% |

Otimizar uma sem a outra é trivial e inútil. O critério de sucesso (spec §33) só
tem sentido como par: **>80% de redução mantendo recall alto**. Todo o desenho
abaixo existe para tornar esse par mensurável — ver `BENCHMARK.md`.

## 2. Camadas

```
CLI (util.parseArgs)
  │
  ├── Scanner ──── walk + ignore + secrets + hash
  │                   ↓  ChangeSet (added/modified/deleted)
  ├── Parser ───── web-tree-sitter (WASM) → extractors por linguagem
  │                   ↓  CodeEntity[] + CodeRelation[]
  ├── Storage ──── interface  →  SqliteStorage (MVP)  |  PostgresStorage (Fase 5)
  │                   ↓  índice + grafo + FTS
  ├── Context Engine ── seeds → expansão no grafo → scoring → knapsack
  │                   ↓  ScoredEntity[]
  ├── Context Compiler ── REFERENCE | SIGNATURE | FULL sob orçamento
  │                   ↓  ContextPackage
  └── AI Gateway ── adapters por provedor (Fase 2)
```

O core é **biblioteca**. A CLI é um consumidor fino. O dashboard da Fase 3 será
outro. Nenhuma regra de negócio vive na camada de apresentação.

## 3. Decisões e trade-offs

### 3.1 SQLite em vez de PostgreSQL no MVP

A spec §5 pede PostgreSQL. Isso conflita com a spec §30/§32 ("rápido, local,
simples") e com o Local Mode da spec §19: exigir um servidor antes do primeiro
`pil scan` é fricção alta num produto cujo diferencial é rodar sobre código
privado, na máquina do desenvolvedor.

| | SQLite | PostgreSQL |
|---|---|---|
| Setup | nenhum | servidor + credenciais |
| CTE recursiva (grafo) | sim | sim — **mesmo SQL** |
| Full-text | FTS5 embutido | tsvector |
| Vetores | sqlite-vec (Fase 2) | pgvector |
| Multiusuário / cloud | não | sim |

O grafo não precisa de banco de grafos (a própria spec §5 alerta contra isso), e
também não precisa de Postgres: uma CTE recursiva sobre uma tabela de arestas
resolve travessia com filtro de tipo, profundidade e confiança — implementado e
testado em `sqlite-storage.ts`.

**Mitigação do risco:** toda persistência passa pela interface `Storage`, que é
**assíncrona mesmo com driver síncrono**. Um adapter Postgres é obrigatoriamente
assíncrono; espremer isso depois obrigaria a reescrever todos os chamadores. O
custo hoje é um `await` supersticioso — o custo de não fazer é o retrabalho que a
escolha do SQLite existia para evitar.

### 3.2 `node:sqlite` em vez de `better-sqlite3`

Elimina a única dependência nativa do projeto (sem node-gyp/MSVC), que é onde a
instalação costuma falhar no Windows — a plataforma deste projeto. API
praticamente idêntica; a troca ficaria contida em `sqlite/driver.ts`.

**Custo aceito:** o módulo é experimental no Node 22 e emite warning. Consequência
concreta já encontrada: ele não consta em `module.builtinModules`, então Vite e
bundlers não o reconhecem como builtin, removem o prefixo `node:` e tentam
resolver um pacote npm inexistente. Resolvido isolando o carregamento em
`sqlite/driver.ts` via `createRequire`.

### 3.3 Tree-sitter via WASM

`web-tree-sitter` com gramáticas `.wasm` pré-compiladas, em vez dos bindings
nativos. Mesma razão: nenhum compilador na instalação. Parsing não é o gargalo do
MVP — a indexação incremental é que decide o desempenho percebido.

### 3.4 Fastify adiado

A spec §5 lista Fastify, mas o MVP da spec §30 é só CLI e o dashboard é Fase 3.
Um servidor HTTP hoje traria auth, ciclo de vida e porta configurável para zero
consumidores. O requisito real ("preparado para web") se atende mantendo o core
como biblioteca — o que já está feito.

### 3.5 Sem dependências de conveniência

`util.parseArgs` (nativo) em vez de commander; `node:crypto` para hash;
`node:sqlite` para banco.

As únicas dependências de execução são as quatro do tree-sitter (runtime WASM +
três gramáticas). A propriedade que importa não é a contagem, e sim que
**nenhuma delas exige compilação**: `npm install` não invoca node-gyp, que é
onde a instalação falha no Windows. Consequência direta da spec §32.

## 4. Confiança das relações

O ponto onde análise estática mente com mais facilidade. Sem inferência de tipos
não se resolve `obj.metodo()` com `obj` de tipo desconhecido, reflexão, injeção
de dependência ou binding por string.

Se o grafo tratar um palpite por nome com a mesma confiança de um import
explícito, o `pil impact` produz resultado errado com aparência de certeza — pior
do que não responder.

| Tier | Confiança | Critério |
|---|---|---|
| `EXACT` | 1.0 | ligado por import/declaração explícita na cadeia de escopo |
| `SCOPED` | 0.75 | símbolo único com esse nome, sem prova de binding |
| `AMBIGUOUS` | `min(0.5, 1/N)` | N candidatos homônimos |
| `UNRESOLVED` | 0.0 | nenhum candidato; guardado como pista |

A confiança **acumula multiplicativamente** ao longo do caminho: dois saltos a
0.75 valem 0.56. A análise de impacto precisa distinguir "quem prova que chama"
de "quem talvez chame". A saída da CLI exibe o tier, nunca só o número.

### Chamada em membro: o receptor decide

`obj.metodo()` é o caso difícil, e rebaixar todos eles não serve — em TS e Python
quase toda chamada é em membro, e o grafo inteiro viraria AMBIGUOUS. O que
importa é se o receptor é **conhecido sintaticamente**:

| Forma | Tier | Por quê |
|---|---|---|
| `this.x()` / `self.x()` | EXACT | a classe é a que contém a chamada |
| `new Classe().x()` | EXACT | o tipo está escrito na expressão |
| `importado.x()` | SCOPED | módulo conhecido, membro não provado |
| `qualquerCoisa.x()` | AMBIGUOUS | sem inferência de tipo, o receptor é opaco |

Isto veio de um falso positivo encontrado rodando `pil impact` sobre o próprio
PIL: `this.#db.prepare(...).run(...)` casava por nome com `Indexer.run` — único
`run` do índice — e recebia SCOPED/0.75. O relatório passava a listar métodos do
`SqliteStorage` como chamadores do indexador, com confiança alta sobre uma
coincidência de nome.

## 5. Indexação incremental

A unidade de invalidação é o **arquivo**; a de seleção é a **entidade**.

```
disco → (mtime + tamanho iguais?) → sim: nem lê o arquivo
                                  → não: lê, hasheia
                                          → hash igual?  sim: reaproveita
                                                         não: reparse
```

`mtime` só é usado como prova de **não**-mudança, nunca de mudança: `git checkout`
reescreve mtimes sem alterar conteúdo, e confiar nele transformaria todo checkout
numa reindexação completa. O hash decide.

### O invariante delicado: rebaixar em vez de apagar

Ao reindexar um arquivo, arestas vindas de **outros** arquivos que apontavam para
entidades dele voltam a `UNRESOLVED` **preservando `targetHint`** — não são
apagadas. Uma aresta apagada perde a pista e nunca mais volta a resolver: o índice
perderia conectividade a cada edição, silenciosamente. A promoção acontece pelo
lado do alvo, porque o arquivo de origem pode nunca mais ser reindexado. Ambos os
lados têm teste dedicado.

## 6. Riscos técnicos

| Risco | Impacto | Mitigação |
|---|---|---|
| `node:sqlite` experimental muda de API | Médio | isolado em `driver.ts`; troca por `better-sqlite3` é local |
| Resolução por nome gera falso positivo de impacto | **Alto** | tiers de confiança + exibição do tier + corte por `minConfidence` |
| Recall baixo do Context Engine | **Alto** | benchmark de recall sobre commits reais desde a Fase 1 |
| Grafo grande estoura memória | Médio | travessia no banco (CTE), fatiamento de parâmetros, nunca carregar o grafo inteiro |
| Estimativa de token diverge do provedor | Médio | tokenizer real + margem de segurança configurável |
| Projeto poliglota com extrator faltando | Baixo | `UNSUPPORTED_LANGUAGE` registrado, cobertura reportada no `pil status` |

## 7. Decisões deliberadamente adiadas

- **Embeddings / busca semântica** — Fase 2. Ver a ressalva do §10: o FTS
  resolve a barreira de *forma* (identificador colado vs. palavras separadas),
  mas não a de *idioma*.
- **Postgres + pgvector** — Fase 5, quando houver multiusuário de verdade.
- **Dashboard** — Fase 3. O core já é consumível por HTTP quando existir.
- **Migration Engine** — Fase 4, e re-escopado: ver §8.
- **Workers / paralelismo** — só depois que o benchmark apontar o gargalo.
  Paralelizar antes de medir é adivinhação.

## 8. Ressalva sobre o Migration Engine (spec §20/21)

"Modelo semântico → Go idiomático" é problema de pesquisa, não de extração de
símbolos. Um modelo realmente independente de linguagem e rico o bastante para
tradução idiomática (concorrência, memória, tratamento de erro) é
consideravelmente mais do que AST + símbolos entrega.

O escopo honesto: o PIL contribui com **contexto, plano de migração e ordenação de
módulos**; a transformação é feita por LLM e validada por testes. Isso é útil e
entregável. "Compilador semântico universal" não é, e prometê-lo comprometeria as
fases que sustentam o resto.

## 9. Onde a spec foi contrariada

| Spec | Decisão | Motivo |
|---|---|---|
| §5 PostgreSQL no MVP | SQLite atrás de `Storage` | §3.1 — confirmado com o autor |
| §5 Fastify no MVP | adiado para a Fase 3 | §3.4 |
| §8 "identificar arquivos mortos" | reportado como *"sem referência estática — verificar"* | código morto é indecidível em linguagem dinâmica; afirmar é dar munição para apagar código vivo |
| §12 fórmula de relevância | soma → média ponderada de sinais normalizados | ver `RELEVANCE.md` |
| §19 filtro de segredos antes do envio | antes da **indexação** | o índice também é artefato que vaza |

## 10. Limite conhecido: tarefa em português, código em inglês

Descoberto ao rodar `npm run demo`, e registrado aqui porque muda quando os
embeddings deixam de ser opcionais.

A quebra de identificadores resolve a barreira de **forma**:

```
"create client"  →  createClient        casa
```

Não resolve a barreira de **idioma**:

```
"cálculo de comissão"  →  calculateCommission     NÃO casa
```

`comissão` e `commission` são palavras distintas para o FTS. Nenhum stemmer ou
remoção de acento aproxima as duas — é tradução, não normalização.

Isso importa porque descreve exatamente a situação real do usuário deste projeto:
tarefas escritas em português sobre bases de código com identificadores em inglês.
No corpus do benchmark — um SaaS de gestão em português — esse é o caso comum,
não a exceção.

**Consequência para o roadmap:** o sinal `lexical` sozinho não sustenta o recall
da Fase 1 nesse cenário. Três saídas, em ordem de custo:

1. **Sementes por outros sinais** — símbolos citados literalmente na tarefa
   (o usuário costuma escrever `calculateCommission` quando sabe o nome),
   caminhos em `--include`, e arquivos recém-alterados no git. Não depende de
   idioma. É o mais barato e entra na Fase 1.
2. **Dicionário de domínio** — mapa configurável em `.pil/config.json`
   (`comissão→commission`, `vendedor→seller`) expandindo a consulta. Barato,
   explícito, e o usuário controla. Cobre o vocabulário recorrente do projeto.
3. **Embeddings multilíngues** — resolve o caso geral, mas custa indexação e
   dependência de modelo. Fase 2.

A ordem não é arbitrária: (1) e (2) são verificáveis pelo benchmark antes de
existir qualquer embedding, e o resultado deles é o que diz se (3) compra recall
ou só compra complexidade.

## 11. O que um projeto CommonJS real revelou

Rodar o PIL num projeto de 421 arquivos (246 JavaScript, CommonJS, sem build)
expôs quatro defeitos que nenhum teste sintético pegaria. Ficam registrados
porque a lição é a mesma nos quatro: **o extrator estava modelando o ecossistema
que eu conhecia, não o que existe.**

### 11.1 `require()` não era import

Resultado do primeiro scan: **0 resoluções EXACT em 29.258 relações.**

O extrator só reconhecia `import ... from`. Em CommonJS, `require('./repo')` é
uma `call_expression` como qualquer outra, então o índice tinha 730 arestas
`CALLS → require` e **nenhuma** aresta `IMPORTS`. Sem grafo de módulos não há
prova de binding, e sem prova de binding nada pode ser EXACT — tudo desabava
para casamento por nome.

Depois de tratar `require` como import, com os nomes ligados extraídos do
declarador: **599 EXACT**.

### 11.2 Alias de módulo competia por orçamento

`const axios = require('axios')` criava uma entidade `VARIABLE:axios`. Com 246
arquivos CommonJS, o topo do ranking de contexto era `VARIABLE:axios`,
`VARIABLE:ixcPools`, `VARIABLE:json` — 598 entidades que são apelido de módulo,
não código que alguém edita. A relação IMPORTS já registra o vínculo.

### 11.3 A otimização de `mtime` estava documentada mas não implementada

A §5 deste documento afirmava que `mtime` + tamanho iguais evitam **ler** o
arquivo. O Scanner nunca recebia o índice anterior, então lia e hasheava os 421
arquivos em todo scan. Era a promessa de escala do projeto existindo só no papel.

### 11.4 A resolução rodava mesmo sem nada mudar

Um `pil scan` sem alteração alguma refazia a passada de resolução sobre 16,5 mil
pendências para chegar ao mesmo resultado. Uma aresta pendente só passa a
resolver se apareceu entidade nova, e entidade nova exige arquivo alterado.

### Efeito somado no tempo de scan

| | Scan completo | Scan sem alteração |
|---|---|---|
| antes | 137,9s | 8,7s |
| caches no resolver | 38,8s | — |
| pular resolução inútil | — | 3,6s |
| atalho de `mtime` | — | **1,1s** |

O caminho incremental é o que se usa dezenas de vezes por dia, e era onde a
lentidão mais doía: 8,7s para descobrir que nada mudou tornava o hábito de rodar
`pil scan` antes de cada tarefa insuportável.

## 12. O bug mais grave: acentuação

Uma consulta real num projeto brasileiro expôs isto:

```
"tela de indicacao"  →  "indicacao" OR "indica"*     casa com o arquivo da tela
"tela de indicação"  →  "indica"                     não casa
```

`\w` em JavaScript é `[A-Za-z0-9_]` — `ç` e `ã` não entram. A quebra por
não-palavra cortava toda palavra acentuada no primeiro acento: `conexão` virava
`conex`, `validação` virava `valida`, `função` virava `fun`. E como o termo
truncado ficava com menos de 8 caracteres, ele também perdia a busca por
prefixo, que é justamente o que faria o singular casar com o plural.

**O efeito perverso: escrever a tarefa com a acentuação correta dava resultado
pior do que escrever errado.** Num produto cujo caso de uso declarado é tarefa
em português sobre código em inglês, esse era o pior lugar possível para um bug.

O índice FTS já era construído com `remove_diacritics`; só o lado da consulta
estava fora de sintonia. `stripDiacritics` normaliza antes de quebrar.

## 13. Nome de arquivo precisa de consulta própria

Ainda na mesma tarefa, os dois arquivos óbvios — o arquivo da tela e o seu controller — apareciam nas **posições 76 e 77** do FTS, com
limite de 40 sementes. Nunca entravam.

A causa é estrutural, não um ajuste de peso: o bm25 normaliza por tamanho do
documento. A entidade FILE carrega o caminho, todas as assinaturas e todos os
literais do arquivo, então cada termo individual fica diluído. Uma
uma variável com três termos no total, sempre vence.

O nome do arquivo costuma ser o indicador de assunto mais forte de um código, e
afogá-lo num índice ponderado por tamanho é perder o sinal mais barato que
existe. `findFilesByPathTerms` é uma fonte de sementes separada, por `LIKE` no
caminho — com o mesmo truncamento de prefixo do FTS, porque `LIKE '%singular%'`
não casa com o plural.

## 14. Intenção não é assunto — nem como símbolo

Duas manifestações do mesmo erro, encontradas na mesma consulta:

1. `"Validar"`, no início da frase, casava com a regra de PascalCase de uma
   palavra e era tratado como **identificador citado**. Isso deu casamento de
   símbolo perfeito com um uma função homônima de um arquivo sem relação nenhuma
   com a tarefa — primeiro lugar no ranking, score 67.
2. A tabela de afinidade de `UNKNOWN` era **vazia**, então toda tarefa não
   classificada caía num neutro único de 0,5 e variável de módulo competia de
   igual para igual com função. uma variável local de um controlador,
   outra variável sem relação e uma variável de script de teste no topo.

Corrigidos com um filtro de intenção compartilhado entre busca e extração de
símbolo, e com uma tabela de afinidade **base** aplicada quando a tarefa não tem
entrada própria.

## 15. Espalhar é pior que concentrar

O pacote cobria **40 arquivos** com 89 entidades — ~85 tokens cada. Isso não é
contexto abrangente, é confete: nenhum arquivo recebe o suficiente para ser
compreendido.

Um teto de 12 arquivos distintos, com o orçamento concentrado neles, tem duas
vantagens sobre espalhar. Cada arquivo incluído fica legível. E um pacote focado
*errado* é visivelmente errado — o usuário percebe e usa `--include`; um pacote
difuso parece plausível e desperdiça a rodada.

### Antes e depois, mesma consulta

*"Validar se todos os valores da tela de indicação estão, corretos e validados"*

| | Antes | Depois |
|---|---|---|
| tipo inferido | UNKNOWN | BUG_FIX |
| arquivos | 40 | 12 |
| entidades | 89 | 32 |
| o arquivo da tela | ausente | 7 entidades |
| o controller | ausente | 8 entidades |
| topo do ranking | uma variável local de um controlador | `_getIndicacaoPerfilIds` |
