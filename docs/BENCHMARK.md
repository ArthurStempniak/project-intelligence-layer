# Benchmark

## Por que ele vem antes das otimizações

O critério de sucesso da spec §33 é "reduzir >80% sem perder o necessário". A
primeira metade é trivial de fingir: enviar nada reduz 100%. A segunda metade é
que exige medição — e sem ela qualquer ajuste no Relevance Engine vira palpite.

Por isso o harness de benchmark é entregável de **Fase 1**, não de Fase 2.

## Gabarito a partir de commits reais

A ideia central: um commit já é um par (tarefa, resposta) rotulado por um humano.

```
commit real
   ├── mensagem  →  a tarefa em linguagem natural
   └── arquivos alterados  →  o conjunto que era necessário
```

Procedimento por commit:

1. Fazer checkout do estado **anterior** ao commit (`commit~1`).
2. Indexar (`pil scan`).
3. Pedir contexto usando a mensagem do commit como tarefa.
4. Comparar o conjunto selecionado com os arquivos que o commit alterou.

O passo 1 não é detalhe: indexar o estado *posterior* deixaria o código da
solução visível no índice, e a medição passaria a avaliar um cenário que nunca
ocorre na prática.

### Corpus

O corpus usado nas medições deste documento é um SaaS de gestão privado
(Next.js + API Node, TypeScript, interface em português), com histórico de
commits suficiente. Bate com as linguagens prioritárias da spec §30.

Como o repositório é privado, os commits aparecem aqui descritos pelo *tipo* de
tarefa, não pela mensagem original. Para reproduzir num projeto seu:
`npm run bench -- --repo <caminho> --limit 22`.

### Filtros de commit

Nem todo commit serve como caso de teste. Excluir:

- **merges** — o diff não corresponde a uma tarefa;
- **commits com >20 arquivos** — em geral renomeação em massa ou formatação, cuja
  mensagem não descreve uma tarefa de engenharia;
- **mensagens genéricas** (`wip`, `fix`, `ajustes`) — não há tarefa a interpretar,
  e medir contra elas mede ruído;
- **commits só de config/lockfile**.

Esses filtros precisam ser explícitos e versionados: escolher a dedo quais
commits entram no benchmark é a maneira mais fácil de produzir um número bonito e
sem significado.

## Métricas

| Métrica | Definição | Meta MVP |
|---|---|---|
| **Recall@budget** | fração dos arquivos do commit presentes no contexto | ≥ 0.80 |
| **Redução de tokens** | `1 − selecionados / projeto_inteiro` | ≥ 0.80 |
| **Precisão** | fração do contexto que estava no commit | reportada |
| **Time to context** | ms da tarefa ao pacote pronto | < 2s |
| **Tempo de rescan incremental** | 1 arquivo alterado em projeto já indexado | < 1s |

Recall e redução são reportados **sempre juntos**. Um sem o outro é propaganda.

Precisão fica como métrica observada, sem meta: o contexto legitimamente inclui
arquivos que o commit não alterou mas que o agente precisava ler para escrever a
alteração correta. Penalizar isso otimizaria contra o objetivo do produto.

## Formato de saída

```
PIL BENCHMARK — meu-projeto
Commits avaliados: 50   (de 312 após filtros)

Recall@20k    0.84   ████████████████░░░░
Redução       0.91   ██████████████████░░
Precisão      0.31
Time to ctx   740ms  (p95: 1.2s)

Piores casos (recall baixo):
  a3f9c21  "corrige upload de anexo na ocorrência"   0.33  (1/3 arquivos)
  7d10b8e  "ajusta filtro de filial no BI"           0.50  (2/4 arquivos)
```

A lista de piores casos é a parte útil do relatório. A média diz se houve
regressão; os piores casos dizem *onde* consertar — e é neles que se descobre
qual sinal está faltando.

## Benchmark sintético

Além do corpus real, um projeto artificial com dependências conhecidas por
construção, para testar propriedades que commits reais não isolam:

- cadeia profunda de chamadas (o contexto acompanha até onde?);
- dependência circular (a travessia termina?);
- homônimos em módulos diferentes (a confiança cai como deveria?);
- arquivo gigante com uma função relevante (a compressão evita puxar tudo?).

O corpus real mede utilidade; o sintético mede corretude. Um não substitui o
outro: o sintético nunca surpreende, e é exatamente por isso que ele detecta
regressão de forma confiável.

---

## Medições

Corpus: SaaS de gestão privado, 14 casos após filtros, orçamento 20.000 tokens.

| Versão | Recall | Redução | Precisão | O que mudou |
|---|---|---|---|---|
| linha de base | 38% | 93% | 3% | primeira implementação |
| + literais indexados | 38% | 86% | 2% | conteúdo de string/JSX no índice |
| + seleção por score | 44% | 86% | 5% | ordenação por score em vez de densidade |
| + cognatos PT/EN | 56% | 86% | 6% | busca por prefixo em termos longos |
| + filtros de literal e verbo | 56% | 89% | 32% | className fora, verbo de intenção fora |
| **+ piso calibrado** | **57%** | **86%** | **22%** | piso relativo de score 0,45 → 0,25 |
| (rejeitado) léxico amplo | 55% | 84% | 7% | expansão por sinônimo diluiu demais |

Medido em 14 casos, não em 8: com 8 casos cada acerto valia 12,5 pontos e a
métrica oscilava sem que nada de real tivesse mudado.

```
recall     ███████████░░░░░░░░░  57%     meta ≥80%   ✗
redução    █████████████████░░░  86%     meta ≥80%   ✓
precisão   ████░░░░░░░░░░░░░░░░  22%     observada
time to context  160ms (p95 373ms)       meta <2s    ✓
```

**O critério de saída da Fase 1 continua não atingido.** A redução supera a meta;
o recall está a três quartos do caminho.

### O que cada passo ensinou

**Ordenar por densidade era um erro de objetivo, não de matemática.** Densidade
(score/tokens) é o ótimo do knapsack fracionário para maximizar *score total* —
mas o objetivo do PIL é incluir as poucas entidades que a tarefa toca. Maximizar
a soma premiava encher o pacote de fragmentos baratos: 22 arquivos selecionados
onde 1 importava.

**Cognatos latinos são uma ponte de idioma grátis.** `integration` e `integracao`
compartilham prefixo, como validation/validação e notification/notificação. Uma
busca por prefixo em termos longos resolveu um caso de recall 0 sem dicionário
nenhum, porque é propriedade da língua e não lista de exceções.

**Verbo de intenção é o pior termo de busca possível.** Numa tarefa que começava
com "Update", o primeiro colocado era um `updatePerfil` de outro módulo:
casamento perfeito com a palavra menos informativa da frase. Verbos já são
capturados por `classifyTask` para o sinal `taskType`; como termo de busca só
afogam o tópico.

**`className` envenenava o índice de conteúdo.** Num componente React os
literais de string são dominados por Tailwind, e o orçamento de literais se
esgotava em `flex items center justify between` antes de alcançar uma palavra
visível. Indexar o texto JSX primeiro e pular atributos de estilo foi o que
levou a precisão de 2% para 32%.

**Expansão ampla por sinônimo piora o contexto.** Um léxico PT↔EN de 40 grupos
aplicado por padrão derrubou a precisão de 22% para 7% e o recall de 57% para
55%: expandir cada termo para 3–5 sinônimos multiplica candidatos, e o ranking
não sabe qual era o pretendido. O mecanismo ficou, vazio por padrão e
configurável — um dicionário curado pelo dono do projeto é preciso onde a lista
genérica é ruído.

### Por que o recall para em 57%

Os 5 casos que ainda falham são todos do mesmo tipo:

| Commit | Tarefa | Alvo |
|---|---|---|
| (commit privado) | tarefa de conteúdo/copy | `(public)/page.tsx` |
| (commit privado) | tarefa de conteúdo/copy | `(public)/page.tsx` |
| (commit privado) | tarefa de conteúdo/copy | página de dashboard |
| (commit privado) | tarefa de conteúdo/copy | página de perfil |
| (commit privado) | tarefa de conteúdo/copy | componente de BI |

São edições de *conteúdo e apresentação* em páginas grandes, descritas em
vocabulário que não aparece em identificador nem casa por cognato
(`billing`/`cobrança`, `subscription`/`assinatura`). Nenhum sinal estrutural
aponta para lá: não há símbolo citado, não há chamada, não há import.

O sinal que resolve isso é **similaridade semântica de texto** — embeddings, a
Fase 2. Continuar empilhando heurística contra 14 casos seria ajustar ao gabarito
em vez de melhorar o motor.

### Ressalvas

- O corpus é dominado por commits de *copy* de landing page: 22 dos 44 commits
  varridos foram descartados por mensagem curta, 6 por serem só config/asset.
  Um repositório com mais trabalho de backend provavelmente pontuaria melhor,
  e nada disso foi ajustado para melhorar o número.
- Os filtros de corpus estão versionados em `corpus.ts` justamente para impedir
  a tentação de refazer a amostra até o resultado agradar.
- Reproduzir: `npm run bench -- --repo <caminho> --limit 22 --budget 20000`.
