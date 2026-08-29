import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error The Node test project has no JSX transform; tsconfig.web type-checks Dashboard.
import { Dashboard } from '../../../src/renderer/src/components/views/Dashboard';

const appState = vi.hoisted(() => ({
  currentProject: {
    id: 1,
    name: 'asset-only-project',
    rootPath: 'C:/projects/asset-only-project',
  },
  stats: { totalFiles: 0 },
  lastScan: {
    status: 'completed',
    summary: {
      limitations: [
        'No supported source files were found under C:/projects/asset-only-project.',
        'Discovery left 2 files outside the graph by extension: .css (1), .html (1).',
      ],
    },
  },
  scanning: false,
  startScan: async () => undefined,
  openProjectDialog: async () => null,
}));

vi.mock('../../../src/renderer/src/store/appStore', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock('../../../src/renderer/src/store/uiStore', () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({ setActiveView: vi.fn(), selectNode: vi.fn() }),
}));

describe('Dashboard zero-file scan', () => {
  it('shows the exact discovery exclusions instead of the pre-scan state', () => {
    const html = renderToStaticMarkup(createElement(Dashboard));

    expect(html).toContain('No supported source files found');
    expect(html).toContain('.css (1)');
    expect(html).toContain('.html (1)');
    expect(html).not.toContain('This project has not been scanned yet');
  });
});
