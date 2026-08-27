import { fromA } from './a';

export function fromB(): string {
  return 'b';
}

export function callsA(): string {
  return fromA();
}
