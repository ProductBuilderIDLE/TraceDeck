// Every line below is a deliberate type error used by the diagnostics tests.

// TS2322: string is not assignable to number
export const brokenAssignment: number = 'not a number';

// TS2554: wrong number of arguments
import { addNumbers } from './good';
export const wrongArity = addNumbers(1);

// TS2339: property does not exist
export function missingProperty(): string {
  const value = { name: 'x' };
  return value.somethingElse;
}
