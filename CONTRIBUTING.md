# Contributing to PIL

Thanks for looking. This project has one unusual rule and it is the important
one, so it goes first.

## The rule: retrieval changes must be benchmarked

Anything that touches how context is **found, scored, or selected** needs a
before/after measurement on the same corpus, in the pull request body:

```
before:  recall 57%   reduction 86%   precision 22%   p95 407ms
after:   recall 64%   reduction 84%   precision 27%   p95 421ms
```

```bash
npm run bench -- --repo ../some-project --limit 22 --budget 20000
```

Files under this rule: `src/context/`, `src/parser/resolver.ts`,
`src/core/text.ts`, `src/core/lexicon.ts`, `src/scanner/`.

A change that **lowers** recall can still be merged, if the number is there and
the trade is argued. A change with no number cannot, no matter how obviously
correct it looks. This is not bureaucracy, it is the lesson the project already
learned twice:

- Ordering candidates by density (`score / tokens`) is the textbook answer for a
  fractional knapsack. It was wrong here, because the goal is not maximising
  total score, it is including the few entities the task actually touches. The
  measurement showed 22 files selected where 1 mattered.
- A 40-group Portuguese↔English synonym dictionary looked obviously useful.
  Measured, it dropped precision from 22% to 7%, because expanding each term to
  five synonyms multiplies candidates and the ranker cannot tell which one was
  meant. It was reverted and is now opt-in.

Both are written up in [`docs/BENCHMARK.md`](docs/BENCHMARK.md).

## Development setup

```bash
git clone https://github.com/ArthurStempniak/project-intelligence-layer
cd project-intelligence-layer
npm install
npm run build
npm test          # 151 tests
npm link          # makes `pil` available for manual testing
```

Requires Node.js ≥ 22.13, for the built-in `node:sqlite`. There is no native
dependency: `npm install` never invokes node-gyp.

Before opening a PR:

```bash
npm test && npm run typecheck && npm run build
```

## Architecture in five minutes

```
CLI  →  Scanner  →  Parser  →  Storage  →  Context Engine  →  Compiler
        (walk,      (AST via   (SQLite,   (seeds, graph      (3 detail
        hash,       tree-      graph,     expansion,         levels under
        secrets)    sitter)    FTS)       scoring)           token budget)
```

Four ideas carry most of the design. If you only read four things, read these:

**The unit of invalidation is the file; the unit of selection is the entity.**
A file whose hash did not change is never re-parsed. But context is budgeted per
function, class or component, because including an 800-line file for one relevant
function wastes the budget.

**Entity IDs are logical, not content hashes.**
`src/services/client.ts#FUNCTION:createClient` survives an edit to the function
body. A content hash would destroy every edge pointing at it on every keystroke,
turning incremental indexing into full re-indexing in disguise.

**Confidence is derived, never asserted.**
Static analysis cannot resolve `obj.method()` without type inference. So edges
carry a tier: `EXACT` (import binding proves it), `SCOPED` (unique name, no
proof), `AMBIGUOUS` (`1/N` homonyms), `UNRESOLVED` (hint kept for later).
Confidence multiplies along a path. `pil impact` shows the tier, because a
confident wrong answer is worse than an uncertain one.

**Demote, never delete.**
When a file is re-indexed, edges from *other* files pointing at its entities go
back to `UNRESOLVED` keeping `targetHint`, instead of being deleted. A deleted
edge loses the hint and never resolves again: the index would silently lose
connectivity on every edit.

Full reasoning, including the bugs that real usage exposed, is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Adding a language parser

This is the most isolated way to contribute. It touches **only**
`src/parser/extractors/` plus one grammar registration.

1. Add the grammar to `GRAMMAR_LOCATIONS` in
   [`src/parser/grammars.ts`](src/parser/grammars.ts) and the extension to
   `LANGUAGE_BY_EXTENSION` in
   [`src/scanner/languages.ts`](src/scanner/languages.ts).
2. Implement `Extractor` from
   [`src/parser/extraction.ts`](src/parser/extraction.ts). Use
   `ExtractionBuilder`: it already handles homonym disambiguation, fingerprints,
   token estimation, signature slicing and literal extraction.
3. Register it in `EXTRACTORS` in
   [`src/parser/parser.ts`](src/parser/parser.ts).
4. Add tests following `tests/unit/parser.test.ts`.

Read [`extractors/typescript.ts`](src/parser/extractors/typescript.ts) and
[`extractors/python.ts`](src/parser/extractors/python.ts) first. Between them
they show the two shapes: a language with explicit `export` and one where
visibility is a naming convention.

Two things worth knowing before you start, both learned the hard way:

- **Emit calls from the enclosing function, not the enclosing container.** A
  local variable holding a call result must not become the source of that edge,
  or impact analysis stops finding the real caller.
- **Verify the node types instead of assuming them.** Every extractor in this
  repo was written by dumping the actual AST of a sample file first. Grammars
  differ from the documentation more often than you would like.

## Improving context retrieval

The open problem is [issue #2](../../issues/2): recall is 57%, the target is 80%.

Where the signal comes from today, in `src/context/`:

| File | Responsibility |
|---|---|
| `task.ts` | classify intent, extract cited symbols and paths |
| `relevance.ts` | find seeds, expand the graph, score candidates |
| `compiler.ts` | pick detail level and fit the token budget |
| `impact.ts` | reverse traversal for `pil impact` |

Signals are each normalised to `[0,1]` and combined as a weighted mean,
renormalised by the active weights. The weights in `DEFAULT_WEIGHTS` are a
starting point to be calibrated against the corpus, not revealed truth. See
[`docs/RELEVANCE.md`](docs/RELEVANCE.md).

The `semantic` signal exists, is declared, and is weighted **zero**: it is the
slot embeddings will fill. Wiring it up is the highest-value contribution
available.

## Performance guidelines

The target is 100k+ files, so a few things are non-negotiable:

- **Never load the whole graph into memory.** Traversal happens in SQL via
  recursive CTE, which is also what keeps the PostgreSQL adapter viable later.
- **Chunk parameter lists.** SQLite caps parameters per statement; see
  `PARAM_CHUNK` in `sqlite-storage.ts`.
- **Do not query per item in a loop.** A resolver that called
  `findEntitiesByName` once per pending relation made a 421-file scan take 138s.
  Memoising it brought that to 39s.
- **Cheap checks before expensive ones.** The scanner decides by path before
  `stat`, and by `mtime`+size before reading the file.

If you make something slower, say so and why in the PR.

## Writing tests

Tests are in `tests/unit/`, run with **vitest**:

```ts
import { describe, expect, it } from 'vitest';
```

Two mistakes CI now blocks, both from a real pull request:

**Do not use `node:test`.** Vitest collects the file, finds no suite it
recognises, and reports `No test suite found`. Typecheck stays clean, so 62
lines of assertions can sit in the repo and never execute.

**Do not import from `src/cli/bin.ts`.** It calls `main()` at module top level,
because that is what a CLI entrypoint does, so importing it runs the whole
command. A utility that needs testing belongs in its own module under
`src/cli/`, imported by `bin.ts`.

Two conventions:

**A comment on a test says why the case exists**, ideally the failure that
motivated it. Several tests in this repo document a specific real-world bug, and
that comment is what stops someone from "simplifying" the fix away.

**Tests that document a limitation are labelled as such.** There are tests
asserting that Portuguese does not currently reach English identifiers. They are
not desired behaviour: they will fail when embeddings land, and should then be
rewritten deliberately rather than deleted.

## Submitting a pull request

- One concern per PR. A parser and a retrieval change do not belong together.
- Say **why** in the body, ideally with the case that failed before.
- Benchmark numbers if the rule above applies.
- Match the surrounding comment style: comments here explain *why*, not *what*.

## Security

PIL reads source code that may be private and proprietary. Anything that touches
what enters the index, or what could leave the machine, is a security-relevant
change. See [`SECURITY.md`](SECURITY.md) before touching `src/scanner/secrets.ts`
or the AI provider layer.

## Reporting a bad context result

The single most useful issue you can open. Use the
[bad context template](.github/ISSUE_TEMPLATE/contexto-ruim.md) and include the
command you ran, what you expected, and the `SELECIONADO` section of the output.
`--explain` shows why each entity was included.
