import { Button } from './components';
import { add } from './services/math';

export function renderApp(): string {
  return `${Button.name}:${add(1, 2)}`;
}

export const APP_VERSION = '1.0.0';
