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
];

/** Extension candidates appended to an extensionless import specifier, in resolution order. */
export const RESOLUTION_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
];

export const INDEX_BASENAMES: readonly string[] = ['index'];

/**
 * Extensions a bundler lets you import that are not JavaScript or TypeScript source. They are
 * legitimate imports, so they must not be reported as missing files, but they are outside the
 * graph TraceDeck builds.
 */
export const NON_SOURCE_IMPORT_EXTENSIONS: readonly string[] = [
  '.css', '.scss', '.sass', '.less', '.styl',
  '.json', '.json5', '.yaml', '.yml', '.toml',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.md', '.mdx', '.txt', '.csv', '.xml', '.html',
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
