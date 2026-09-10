# Security Policy

PIL reads source code that may be private and proprietary. This document states
what it does with that code, what never enters the index, and how to report a
problem.

## Threat model

PIL is a local CLI. The assets it handles:

| Asset | Where it lives | Risk if leaked |
|---|---|---|
| Your source code | already on your disk | none added by PIL |
| The index (`.pil/index/pil.db`) | your project directory | contains symbol names, signatures, docstrings and string literals |
| The context package | stdout, or a file you create | contains real source code of the selected entities |

The index is the asset people underestimate. It is derived from your code and
holds real fragments of it. Treat `.pil/` as you would treat the code itself.

## What PIL does by default

**Nothing leaves your machine.** The default `security.mode` is `local`. There
is no telemetry, no analytics, no update check, no network call of any kind in
the indexing or context path. The AI provider layer is Phase 2 and not yet
implemented; when it lands, sending context will be explicit and opt-in.

**`.pil/` ignores itself.** `pil init` writes a `.pil/.gitignore` containing
`*`, so the index never reaches your git history and never shows up in
`git status`. Your project's own `.gitignore` is not modified.

**Secrets are blocked before indexing, not before sending.** This ordering is
deliberate: the index is itself an artifact that can be copied or committed by
accident, so a secret that reaches the index has already leaked from the point
of view of whoever classified it as a secret.

Two independent filters run, and both record *why* a file was skipped so
`pil status` can report honest coverage:

1. **Path deny list**, evaluated before the file is even `stat`ed:
   `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`,
   `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`,
   `credentials.json`, `service-account*.json`, `.npmrc`, `.pypirc`,
   `.aws/**`, `.ssh/**`
2. **Content patterns**, on the first 16 KB: PEM and OpenSSH private keys (header
   *plus* a base64 body), AWS access keys, GitHub tokens, Anthropic and OpenAI
   API keys, Slack tokens, Google service accounts, and connection strings with
   embedded credentials.

Both lists are in [`src/scanner/secrets.ts`](src/scanner/secrets.ts) and the
deny paths are extensible via `security.denyPaths` in `.pil/config.json`.

## Known limitations

Stated plainly, because a security document that only lists strengths is not
useful:

- **Detection is pattern-based, not exhaustive.** A credential in an unusual
  format, or a secret hardcoded as a plain string with no recognisable shape,
  will be indexed. PIL is not a secret scanner, and should not be your only one.
- **Deliberately narrow patterns.** Generic rules like `password\s*=\s*"..."`
  were tried and rejected: in real code they match field names, tests and form
  handlers, and the resulting false positives lead people to disable the check
  entirely, which is the worst outcome. Precision was chosen over coverage.
- **The PEM rule requires a body.** A file that merely mentions
  `-----BEGIN PRIVATE KEY-----` in a comment or a regex is not blocked. This was
  a real bug in the other direction: PIL initially hid its own secret-detection
  module from the index.
- **String literals are indexed as search terms.** If your code contains
  sensitive text in a string, that text becomes searchable in the index. Use
  `security.denyPaths` to exclude such files.
- **`pil context --raw` prints real source code.** Piping it to a service sends
  that code there. That is the intended use, but it is your decision, not a
  default.

## Reporting a vulnerability

Please **do not** open a public issue for anything that could expose someone's
code or credentials.

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. If that is unavailable to you, open a public issue containing only
the words "security report, need a private channel" and nothing else, and you
will get a contact.

What helps:

- what an attacker (or an accident) achieves
- the smallest reproduction you have
- the PIL version (`git rev-parse --short HEAD`) and your Node version

What to expect: acknowledgement within a few days, and a fix or a documented
mitigation before any public disclosure. This is a young project maintained by
one person, so please size your expectations accordingly, and say if you have a
disclosure deadline.

## Scope

In scope:

- a secret reaching `.pil/index/pil.db` despite the filters
- path traversal or writes outside the project directory
- code execution triggered by scanning a malicious file
- anything sending data off the machine in `local` mode

Out of scope:

- the content of a context package you chose to pipe somewhere
- vulnerabilities in Node.js, tree-sitter or SQLite themselves (report upstream)
- a secret you committed to your own repository that PIL correctly refused to
  index
