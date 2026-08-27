TraceDeck is a private, offline-first desktop app for exploring how a JavaScript or
TypeScript codebase fits together. It parses your repository with the TypeScript
Compiler API, builds a dependency graph, and lets you trace the blast radius of a
change: what imports this file, what breaks if it moves, and the exact import chain
that explains why. It finds circular dependencies, conservative unused-export
candidates, and violations of architecture boundaries you define. Everything runs
locally in SQLite — no accounts, no telemetry, no network requests.

Open a project. See what depends on what. Understand what might break when you
change code — without uploading source code.

TraceDeck is a desktop dependency explorer for JS/TS repos that runs entirely on
your machine. It resolves relative imports, tsconfig path aliases, barrel files,
and workspace packages to build a real dependency graph you can explore visually.

- Blast radius: pick a file, see every dependent and the shortest import chain to each
- Circular dependencies via Tarjan's algorithm, with a readable a → b → c → a path
- Unused export candidates, reported conservatively and never as "dead code"
- Architecture rules: "src/components/** must not import src/db/**"
- A change-impact score that shows its full arithmetic instead of hiding it
- Local Markdown, JSON, and self-contained HTML reports

No AI, no cloud, no accounts, no telemetry. Outbound network requests are blocked at
the Electron session layer, so your code physically cannot leave the machine.
