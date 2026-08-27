Offline-first dependency explorer and change-impact analyzer for JavaScript and TypeScript. Map what depends on what — without uploading your code.

TraceDeck is a private, offline-first desktop app for exploring how a JavaScript or
TypeScript codebase fits together. It parses your repository with the TypeScript
Compiler API, builds a dependency graph, and lets you trace the blast radius of a
change: what imports this file, what breaks if it moves, and the exact import chain
that explains why. It finds circular dependencies, conservative unused-export
candidates, and violations of architecture boundaries you define. Everything runs
locally in SQLite — no accounts, no telemetry, no network requests.
