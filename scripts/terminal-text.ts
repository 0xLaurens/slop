export const cleanText = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => [...segmenter.segment(cleanText(text))].map(({ segment }) => segment);
// Approximate layout as one column per grapheme; wide glyphs may overflow.
const textWidth = (text: string): number => graphemes(text).length;

export function removeLastGrapheme(text: string): string {
  return graphemes(text).slice(0, -1).join('');
}

export function tail(text: string, width: number): string {
  let result = '';
  for (const segment of graphemes(text).reverse()) {
    if (textWidth(segment + result) > width) break;
    result = segment + result;
  }
  return result;
}

export function fit(text: string, width: number): string {
  const clean = cleanText(text);
  if (textWidth(clean) <= width) return clean;
  let result = '';
  for (const segment of graphemes(clean)) {
    if (textWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return width > 0 ? `${result}…` : '';
}

export function wrap(text: string, width: number): string[] {
  const capacity = Math.max(1, width);
  return cleanText(text).split(/\r?\n/).flatMap((line) => {
    const result: string[] = [];
    let rest = graphemes(line);
    while (rest.length) {
      let used = 0;
      let end = 0;
      let space = 0;
      while (end < rest.length) {
        const segment = rest[end] ?? '';
        const cells = 1;
        if (used + cells > capacity) break;
        used += cells;
        end++;
        if (segment === ' ' && used > capacity / 2) space = end - 1;
      }
      if (end === rest.length) { result.push(rest.join('')); break; }
      const length = space || end;
      result.push(rest.slice(0, length).join(''));
      rest = rest.slice(length);
      if (rest[0] === ' ') rest.shift();
    }
    return result.length ? result : [''];
  });
}

export function visibleStart({ position, capacity, previous }: { position: number; capacity: number; previous: number }): number {
  return Math.max(0, Math.min(position, Math.max(previous, position - capacity + 1)));
}
