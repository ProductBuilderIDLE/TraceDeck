import { renderApp } from './app';
import { greet } from './services';

export function main(): void {
  renderApp();
  console.log(greet('world'));
}

main();
