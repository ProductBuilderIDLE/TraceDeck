import { addNumbers } from './good';
import { brokenAssignment } from './broken';

export function main(): number {
  return addNumbers(1, 2) + brokenAssignment;
}
