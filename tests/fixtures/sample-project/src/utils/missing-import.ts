import { nothing } from './does-not-exist';
import express from 'express';

export function useMissing(): unknown {
  return [nothing, express];
}
