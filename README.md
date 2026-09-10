**English** | [Português](README.pt-BR.md)

# PIL: Project Intelligence Layer

### Give AI agents the code they actually need.

Codebases keep growing. Context windows keep growing too, but sending an entire
repository to an LLM is still wasteful, expensive, and makes answers *worse*:
the model drowns in irrelevant code.

PIL maps your codebase with real static analysis, understands how files and
symbols relate to each other, and builds the smallest useful context package for
each coding task.

```
┌──────────────────────────────────────────┐
│  1,884,846 tokens  (421 files)           │
│              ↓                           │
│       PIL Context Engine                 │
│              ↓                           │
│      7,591 tokens  (12 files)            │
│                                          │
│           99.6% reduction                │
└──────────────────────────────────────────┘
```

That is a real measurement on a real 421-file project, not an illustration.

![MIT license](https://img.shields.io/badge/license-MIT-blue)
![Node 22+](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen)
![151 tests](https://img.shields.io/badge/tests-151-brightgreen)
![no native build](https://img.shields.io/badge/build-no%20node--gyp-brightgreen)

## Not another RAG wrapper

PIL is a **context engineering** layer, not a search box:

```
        CODEBASE
           ↓
   PROJECT INTELLIGENCE     AST, symbols, dependency graph
           ↓
   CONTEXT ENGINEERING      relevance, token budget, compression
           ↓
       AI AGENT
```

| | What it does | What it misses |
|---|---|---|
| `grep` / ripgrep | finds text fast | does not know who calls what |
| vector search | finds similar text | ignores code structure entirely |
| "paste the repo" | complete | expensive, and dilutes the signal |
| **PIL** | graph of entities and relations, then budgeted selection | no embeddings yet (see [roadmap](docs/ROADMAP.md)) |

Every dependency edge carries a **declared confidence**. `EXACT` means there is
an import binding proving the target. `SCOPED` and `AMBIGUOUS` mean it was a
name match, and the CLI shows which, because an impact analysis that sounds
certain about a guess is worse than one that admits doubt.

## Try it in 60 seconds

```bash
git clone https://github.com/ArthurStempniak/project-intelligence-layer
cd project-intelligence-layer
npm install && npm run build && npm link

cd /path/to/your/project
pil init && pil scan
pil context "fix the commission calculation" --budget 20000 --explain
```

Pipe it straight into an agent:

```bash
pil context "add progressive discount" --raw | claude -p
```

Requires **Node.js ≥ 22.13** and nothing else. No database to install, no C++
compiler, no service to sign up for. Everything runs locally: your code never
leaves the machine.

## What works today

| Command | What it does |
|---|---|
| `pil scan` | incremental index. 421 files re-scan in ~1s when nothing changed |
| `pil context "task"` | context package under a token budget, three detail levels |
| `pil impact "MyFunction"` | what breaks if this changes, with per-path confidence |
| `pil status` | index coverage, graph health, and whether it is stale |
| `npm run bench` | measures PIL's own benefit against real commits in your repo |

### Language support

The extraction contract lives in [`src/parser/extraction.ts`](src/parser/extraction.ts).
Adding a language touches **only** `src/parser/extractors/`: nothing in the
graph, the context engine, or the CLI needs to change.

| Language | Detected | AST | Relations | Context | Status |
|---|---|---|---|---|---|
| JavaScript (ESM + CJS) | ✓ | ✓ | ✓ | ✓ | stable |
| TypeScript | ✓ | ✓ | ✓ | ✓ | stable |
| TSX | ✓ | ✓ | ✓ | ✓ | stable |
| Python | ✓ | ✓ | ✓ | ✓ | stable |
| HTML / CSS / SQL | ✓ | — | — | — | indexed, not parsed |
| Go | — | — | — | — | **help wanted** |
| Rust | — | — | — | — | **help wanted** |
| Java | — | — | — | — | **help wanted** |
| C# | — | — | — | — | **help wanted** |
| PHP | — | — | — | — | **help wanted** |
| Ruby | — | — | — | — | **help wanted** |

## The open problem: recall is 57%

This is the part most projects would hide. We measure two numbers that only mean
something **together**:

```
token reduction   █████████████████░░░  86%     target ≥80%   ✓
recall            ███████████░░░░░░░░░  57%     target ≥80%   ✗
precision         ████░░░░░░░░░░░░░░░░  22%     observed
time to context   140ms (p95 407ms)              target <2s    ✓
```

Reduction alone is trivial to fake: send nothing and you get 100%. **Recall**,
the fraction of the files a task actually needed that made it into the package,
is what keeps reduction honest. It is measured against real commits: the commit
message is the task, the changed files are the ground truth, and the index is
built from the state *before* the commit.

Recall went from 38% to 57% across six measured changes. Every one of them is
documented in [`docs/BENCHMARK.md`](docs/BENCHMARK.md), including one change that
looked obviously good, was measured, made things worse, and got reverted.

**We know why it is stuck.** The remaining failures are content and presentation
edits described in vocabulary that appears nowhere in the code. No structural
signal points at them: no symbol cited, no call, no import. That needs semantic
text similarity, which means embeddings.

Getting to 80% is [issue #1](../../issues/1). It is a measurable, open technical
problem, and the benchmark harness is in the repo so anyone can verify a claim.

## Built for tasks in one language, code in another

If you write tasks in Portuguese, Spanish, or French over code with English
identifiers, naive lexical search breaks. PIL handles this explicitly:

- **Diacritics** are normalised before tokenising. Writing `indicação`
  correctly used to produce *worse* results than misspelling it, because `\w` in
  JavaScript stops at `ç`.
- **Latin cognates** match by prefix: `integration` finds `integracao`, the same
  way `validation` finds `validação`.
- **A domain dictionary** in `.pil/config.json` handles what cognates cannot
  (`billing` / `cobrança`). Keep it short: a broad synonym list was measured and
  it *hurt* precision, dropping it from 22% to 7%.

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | decisions, trade-offs, risks, and the bugs real usage exposed |
| [`docs/RELEVANCE.md`](docs/RELEVANCE.md) | how context is scored and selected |
| [`docs/BENCHMARK.md`](docs/BENCHMARK.md) | how the benefit is measured, and every measurement so far |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | phases, what is missing, and why |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | architecture tour, adding a parser, the benchmark rule |
| [`SECURITY.md`](SECURITY.md) | what never enters the index, and how to report a vulnerability |

## Contributing

The most valuable contribution is **running PIL on your codebase and reporting
what went wrong**. Every serious bug in this project was found that way, not by
synthetic tests: CommonJS `require()` silently producing zero import edges,
accents breaking search, filenames drowned by BM25 length normalisation.

Good places to start:

- [Add a language parser](../../labels/parser): the contract is isolated
- [Improve recall](../../labels/context-engine): must come with benchmark numbers
- [Benchmark PIL on a real repository](../../issues) and tell us what happened

The one hard rule: **any change to retrieval must be benchmarked**, before and
after, on the same corpus. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
