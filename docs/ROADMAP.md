# Roadmap técnico

Cada fase termina em algo verificável. Uma fase não começa antes de a anterior
ter teste passando — o objetivo é evitar o modo de falha clássico deste tipo de
projeto: várias camadas meio-prontas e nenhuma demonstrável.

## Fase 1 — MVP local

**Objetivo:** `pil scan` + `pil context` funcionando sobre um projeto real, com
redução medida.

| # | Entrega | Estado |
|---|---|---|
| 1.1 | Modelo semântico e tipos | **feito** |
| 1.2 | Storage, schema, grafo, FTS | **feito** |
| 1.3 | Indexação incremental (diff, purge, re-resolução) | **feito** |
| 1.4 | Scanner: walk, `.gitignore`, deny de segredos, hash | **feito** |
| 1.5 | Estimativa de tokens | **feito** |
| 1.6 | Parser TS/JS via tree-sitter WASM: entidades | **feito** |
| 1.7 | Extração de relações: imports, calls, extends | **feito** |
| 1.8 | Resolução de imports com tiers de confiança | **feito** |
| 1.9 | Parser Python | **feito** |
| 1.10 | CLI: `init`, `scan`, `status` | **feito** |
| 1.11 | Context Engine: sementes, expansão, pontuação | **feito** |
| 1.12 | Context Compiler: 3 níveis de detalhe, knapsack | **feito** |
| 1.13 | CLI: `context`, `impact` | **feito** |
| 1.14 | Harness de benchmark + corpus de commits | **feito** |

**Critério de saída:** recall@20k ≥ 0.80 com redução ≥ 0.80 no corpus real.

**Estado em 2026-09-10: não atingido.** Redução 86% ✓, recall 57% ✗, precisão
22% (`docs/BENCHMARK.md`). Todos os itens estão implementados e a ferramenta é
usável; a fase não fecha até o recall subir.

O recall saiu de 38% para 57% com seis mudanças, cada uma diagnosticada e medida.
A sétima — expansão ampla por dicionário — foi medida, piorou, e foi revertida.

O que resta, e por que não é mais heurística:

1. **Embeddings (Fase 2) são o próximo passo real.** Os 5 casos que ainda falham
   são edições de conteúdo descritas em vocabulário ausente do código. Não há
   sinal estrutural apontando para lá: nem símbolo citado, nem chamada, nem
   import. O sinal que falta é similaridade semântica de texto.
2. Continuar empilhando heurística contra 14 casos seria ajuste ao gabarito.
3. Vale ampliar o corpus antes: 22 dos 44 commits foram descartados por mensagem
   curta, e um repositório com mais backend daria uma leitura mais representativa.

## Fase 2 — Semântica e IA

- Embeddings + busca vetorial (sqlite-vec no modo local)
- AI Gateway com adapters (Anthropic, OpenAI, Google, local)
- `pil ask` — pipeline completo da spec §18
- Compressão de código (spec §15) refinada com base no benchmark
- Calibração dos pesos de relevância contra o corpus

Ordem proposital: embeddings entram **depois** do benchmark existir. Sem
medição, não há como saber se o custo de embeddar o projeto inteiro compra
recall ou só compra complexidade.

## Fase 3 — Visualização

- HTTP (aí sim Fastify) expondo o core
- Dashboard React/Vite: grafo, mapa de arquitetura, inspetor de contexto
- Qualidade de código: arquivos e funções grandes, complexidade, duplicação,
  dependências circulares, acoplamento
- Architecture Health Score

Sobre "código morto" (spec §26): reportado como *"sem referência estática
encontrada"*, nunca como *"morto"*. Reflexão, DI e roteamento por string tornam a
detecção indecidível em linguagem dinâmica, e um falso positivo aqui leva o
usuário a apagar código vivo.

## Fase 4 — Migração

Re-escopado em relação à spec §20/21: o PIL fornece contexto, plano e ordenação
de módulos; a transformação é feita por LLM e validada por testes. Ver
`ARCHITECTURE.md` §8.

- Plano de migração por módulo com estimativa de complexidade
- Ordenação topológica das dependências
- Validação por suíte de testes do módulo migrado

## Fase 5 — Equipe e nuvem

- Adapter PostgreSQL + pgvector
- Índice compartilhado, RBAC, audit log
- Deploy privado

O adapter Postgres é a hora em que a interface `Storage` prova ter valido a pena.
Se a troca exigir tocar em código fora de `src/storage/`, a abstração falhou e
isso deve ser registrado.
