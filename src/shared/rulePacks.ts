import type { ArchitecturePack } from './types';

/** Built-in architecture templates the user can apply in one action. */
export const ARCHITECTURE_PACKS: readonly ArchitecturePack[] = [
  {
    id: 'layered',
    name: 'Layered (UI / domain / data)',
    description: 'UI must not import data stores; domain must not import UI.',
    rules: [
      {
        name: 'UI must not reach the data layer',
        sourcePattern: 'src/{ui,components,views,pages}/**',
        targetPattern: 'src/{db,data,infra}/**',
        severity: 'high',
      },
      {
        name: 'Domain must not depend on UI',
        sourcePattern: 'src/{domain,core}/**',
        targetPattern: 'src/{ui,components,views,pages}/**',
        severity: 'high',
      },
    ],
  },
  {
    id: 'client-server',
    name: 'Client must not import server',
    description: 'Renderer/client code cannot import main/server modules.',
    rules: [
      {
        name: 'Client must not import server code',
        sourcePattern: 'src/{client,renderer}/**',
        targetPattern: 'src/{server,main}/**',
        severity: 'high',
      },
    ],
  },
  {
    id: 'no-tests-from-src',
    name: 'Production code must not import tests',
    description: 'Source files outside tests must not import test files.',
    rules: [
      {
        name: 'src must not import tests',
        sourcePattern: 'src/**',
        targetPattern: '**/*.{test,spec}.*',
        severity: 'medium',
      },
    ],
  },
];
