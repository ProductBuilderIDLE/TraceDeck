/** Directories never walked during discovery, regardless of .gitignore contents. */
export const ALWAYS_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'out',
  'vendor',
  '.turbo',
  '.cache',
  '.svelte-kit',
  '.nuxt',
  '.tracedeck',
];

export const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  // Parsed by tree-sitter rather than the TypeScript compiler.
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.py',
  '.go',
  '.rs',
];

/**
 * Extension candidates appended to an extensionless import specifier, in resolution order.
 *
 * `.d.ts` is deliberately tried after the implementation extensions, which differs from the
 * TypeScript compiler's own order. The compiler prefers a declaration because it is
 * authoritative for types; this tool builds a dependency graph, where the implementation is
 * what carries the runtime imports. Preferring the declaration made "./foo" resolve to a
 * foo.d.ts sitting beside foo.js, silently dropping every edge foo.js contributed and leaving
 * its own dependencies looking orphaned. A declaration now wins only when no implementation
 * sits beside it.
 */
export const RESOLUTION_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.d.ts',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.py',
  '.go',
  '.rs',
];

export const INDEX_BASENAMES: readonly string[] = ['index'];

/**
 * Extensions a bundler lets you import that are not graph sources. They are
 * legitimate imports, so they must not be reported as missing files, but they are outside the
 * graph TraceDeck builds.
 */
export const NON_SOURCE_IMPORT_EXTENSIONS: readonly string[] = [
  '.styl',
  '.json', '.json5', '.yaml', '.yml', '.toml',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.md', '.mdx', '.txt', '.csv', '.xml',
  '.wasm', '.glsl', '.frag', '.vert', '.graphql', '.gql',
];

/** Files matching these are treated as tests and excluded from "unused export" pressure. */
export const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|[\\/])__tests__[\\/]/i,
  /(^|[\\/])tests?[\\/]/i,
];

/** Framework conventions whose exports are consumed by a framework, not by an import edge. */
export const FRAMEWORK_CONVENTION_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])pages[\\/]/i,
  /(^|[\\/])app[\\/].*[\\/]?(page|layout|route|loading|error|template|not-found)\.[cm]?[jt]sx?$/i,
  /(^|[\\/])middleware\.[cm]?[jt]s$/i,
  /(^|[\\/])next\.config\.[cm]?[jt]s$/i,
  /(^|[\\/])vite\.config\.[cm]?[jt]s$/i,
  /(^|[\\/])tailwind\.config\.[cm]?[jt]s$/i,
];

/** Rendering more than this many nodes at once degrades interaction badly. */
export const GRAPH_NODE_SOFT_LIMIT = 1500;
export const GRAPH_NODE_HARD_LIMIT = 5000;

export const DEFAULT_MAX_TRAVERSAL_DEPTH = 5;
export const MAX_TRAVERSAL_DEPTH = 25;

/** Storing every diagnostic from a badly broken project would bloat the database. */
export const MAX_TYPE_DIAGNOSTICS = 2000;

/** Caps for the in-app source viewer; a file beyond these is shown as a notice instead. */
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_SOURCE_LINES = 8000;

export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export const PRIVACY_NOTICE = 'Analysis stays on this device.';

export const REVIEW_RESULT_SCHEMA_VERSION = 1;
export const MAX_REVIEW_DETAIL_ITEMS = 2000;
export const DEFAULT_REVIEW_PAGE_SIZE = 100;
export const MAX_REVIEW_PAGE_SIZE = 500;
export const MAX_REVIEW_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_DIFF_LINES = 20000;
export const MAX_REVIEW_BASELINE_ENTRIES = 100000;
export const MAX_REVIEW_BASELINE_BYTES = 2 * 1024 * 1024 * 1024;
export const REVIEW_TEMP_PREFIX = 'tracedeck-review-';
export const REVIEW_TEMP_MARKER = '.tracedeck-review-marker';
export const REVIEW_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
