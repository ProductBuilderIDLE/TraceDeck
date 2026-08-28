/**
 * Maps a project-relative path to a Monaco language id.
 *
 * These ids match languages shipped with monaco-editor. Unknown extensions fall back to
 * plaintext so the editor still opens rather than guessing a highlighter that is not there.
 */
export function sourceLanguage(relativePath: string): string {
  const name = relativePath.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === '.gitignore' || name === '.gitattributes' || name === '.dockerignore') {
    return 'plaintext';
  }

  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';

  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascript';
    case '.json':
    case '.jsonc':
    case '.json5':
      return 'json';
    case '.html':
    case '.htm':
    case '.vue':
    case '.svelte':
    case '.astro':
      return 'html';
    case '.css':
      return 'css';
    case '.scss':
      return 'scss';
    case '.less':
      return 'less';
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.xml':
      return 'xml';
    case '.svg':
      return 'xml';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell';
    case '.ps1':
      return 'powershell';
    case '.sql':
      return 'sql';
    case '.toml':
      return 'ini';
    case '.ini':
    case '.env':
      return 'ini';
    case '.graphql':
    case '.gql':
      return 'graphql';
    case '.dockerfile':
      return 'dockerfile';
    default:
      return 'plaintext';
  }
}
