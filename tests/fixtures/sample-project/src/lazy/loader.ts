export async function loadHeavy(): Promise<number> {
  const module = await import('./heavy');
  return module.heavyWork();
}

export async function loadByName(name: string): Promise<unknown> {
  return import(`./${name}`);
}
