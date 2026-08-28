export type TodoTag = 'TODO' | 'FIXME' | 'HACK';

export interface TodoHit {
  line: number;
  tag: TodoTag;
  text: string;
}

const TODO_LINE = /(?:^|\/\/|#|--|\/\*)\s*(TODO|FIXME|HACK)\b[:\s-]*(.*)$/i;

/** Finds TODO / FIXME / HACK markers in source text. */
export function findTodoComments(text: string): TodoHit[] {
  const hits: TodoHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = TODO_LINE.exec(line);
    if (!match) continue;
    const tag = (match[1] ?? 'TODO').toUpperCase() as TodoTag;
    if (tag !== 'TODO' && tag !== 'FIXME' && tag !== 'HACK') continue;
    hits.push({
      line: index + 1,
      tag,
      text: (match[2] ?? '').trim().slice(0, 200),
    });
  }
  return hits;
}
