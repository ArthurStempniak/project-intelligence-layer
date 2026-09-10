# Relevance Engine: algoritmo inicial

## O problema com a fórmula da spec §12

A spec propõe:

```
Relevance Score = semantic_similarity + graph_proximity + symbol_match
                + call_relationship + file_importance + task_type
                + recent_changes + test_relationship
```

Três problemas concretos:

1. **As parcelas têm faixas incompatíveis.** BM25 é ilimitado e negativo,
   distância de grafo é inteira e *menor é melhor*, "é exportado" é booleano.
   Somar isso não produz 0–100: produz um número cuja escala varia com o
   projeto, o que impede comparar execuções e, portanto, impede medir regressão.
2. **A unidade está trocada.** O exemplo pontua arquivos, mas a spec §15 comprime
   símbolos. Orçar por arquivo desperdiça: um `service.ts` de 800 linhas entra
   inteiro por causa de uma função relevante.
3. **Somar trata os sinais como independentes.** Não são: `symbol_match` alto
   quase sempre implica `lexical` alto, e somar os dois conta a mesma evidência
   duas vezes.

## Desenho adotado

Unidade de pontuação: a **entidade**. Arquivos recebem score derivado do máximo
de suas entidades, para exibição.

Cada sinal é normalizado para `[0,1]` **na origem** e combinado por média
ponderada, renormalizada pela soma dos pesos ativos:

```
score = 100 × Σ(peso_i × sinal_i) / Σ(peso_i)
```

A renormalização importa: `semantic` vale 0 no MVP (sem embeddings), e sem
dividir pela soma efetiva todos os scores ficariam artificialmente deprimidos:
o que faria um corte por limiar absoluto se comportar de forma diferente na
Fase 1 e na Fase 2, sem que a qualidade do ranking tivesse mudado.

### Normalização de cada sinal

| Sinal | Normalização | Peso inicial |
|---|---|---|
| `semantic` | cosseno de embeddings, já em [0,1] | 0.00 (Fase 2) |
| `lexical` | BM25 dividido pelo topo do resultado | 0.25 |
| `symbolMatch` | 1.0 se o identificador aparece na tarefa; 0.5 se parcial | 0.20 |
| `graphProximity` | `1 / (1 + hops)` | 0.20 |
| `callRelationship` | 1.0 se aresta CALLS direta com semente | 0.10 |
| `fileImportance` | grau de entrada / grau máximo do projeto | 0.05 |
| `taskType` | afinidade tipo-da-entidade × tipo-da-tarefa | 0.08 |
| `recentChanges` | decaimento exponencial sobre a idade no git | 0.05 |
| `testRelationship` | 1.0 se ligado por aresta TESTS a uma semente | 0.07 |

**Os pesos não são verdade revelada.** São ponto de partida a ser calibrado
contra o corpus de commits reais (ver `BENCHMARK.md`). O valor deste desenho não
está nos números: está no fato de que os números viraram *falsificáveis*.

## Pipeline

Duas fases, com objetivos opostos de propósito:

```
1. RECUPERAÇÃO (recall alto, precisão baixa, barato)
   ├── FTS sobre a tarefa, identificadores quebrados
   ├── casamento exato de símbolos citados na tarefa
   └── caminhos passados em --include
        → sementes

2. EXPANSÃO (grafo)
   └── vizinhança até maxHops, filtrada por confiança mínima
        → candidatos

3. PONTUAÇÃO
   └── sinais normalizados → média ponderada → [0,100]

4. SELEÇÃO SOB ORÇAMENTO
   └── knapsack guloso por densidade (score / tokens)
```

Separar recuperação de pontuação é o que permite errar barato: a recuperação pode
ser generosa porque a pontuação corta depois; se a recuperação fosse restritiva,
nenhuma pontuação recuperaria o que ela deixou de fora.

### Por que knapsack por densidade, e não "os N melhores"

O orçamento é em tokens, não em número de itens. Pegar os melhores por score
gasta o orçamento em entidades grandes e caras; ordenar por `score / tokens`
maximiza relevância por token gasto, que é literalmente a função-objetivo do
produto.

O guloso por densidade não é ótimo (o problema é NP-difícil), mas fica dentro de
um fator conhecido do ótimo e roda em `O(n log n)`. Um solver exato aqui seria
overengineering: o ruído da própria estimativa de relevância é maior que a folga
que o solver recuperaria.

### Nível de detalhe como variável de orçamento

Uma entidade não é só "entra ou não entra". Ela entra em um de três níveis
(spec §15):

| Nível | Conteúdo | Quando |
|---|---|---|
| `FULL` | código integral | a tarefa vai modificar esta entidade |
| `SIGNATURE` | assinatura, entradas/saídas, chamadas, erros | precisa saber o contrato, não a implementação |
| `REFERENCE` | nome e tipo | só situar o agente no entorno |

Isso transforma o corte binário em degradação gradual: com orçamento apertado, um
vizinho cai de `FULL` para `SIGNATURE` em vez de sumir. Preservar a *existência*
de uma dependência custa ~15 tokens e evita que o agente reescreva algo que já
existe: o modo de falha mais caro de um contexto reduzido.

## Diagnóstico obrigatório

`ContextPackage.omitted` guarda o que foi considerado e cortado, com score e
custo. Sem isso não há como distinguir "o motor não achou" de "o motor achou e o
orçamento cortou", que exigem correções opostas: a primeira é problema de
recuperação, a segunda de orçamento.
