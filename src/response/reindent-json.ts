const indentUnit = '  ';

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

function nextSignificant(text: string, from: number): number {
  let index = from;
  while (index < text.length && isWhitespace(text.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
    } else if (character === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return index;
}

export function reindentJson(text: string): string {
  const parts: string[] = [];
  const indents: string[] = [];
  const indent = (level: number): string => (indents[level] ??= indentUnit.repeat(level));
  let level = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? '';
    if (isWhitespace(text.charCodeAt(index))) {
      index += 1;
    } else if (character === '"') {
      const end = stringEnd(text, index);
      parts.push(text.slice(index, end));
      index = end;
    } else if (character === '{' || character === '[') {
      const next = nextSignificant(text, index + 1);
      const closing = character === '{' ? '}' : ']';
      if (text[next] === closing) {
        parts.push(character + closing);
        index = next + 1;
      } else {
        level += 1;
        parts.push(character, '\n', indent(level));
        index += 1;
      }
    } else if (character === '}' || character === ']') {
      level -= 1;
      parts.push('\n', indent(level), character);
      index += 1;
    } else if (character === ',') {
      parts.push(',\n', indent(level));
      index += 1;
    } else if (character === ':') {
      parts.push(': ');
      index += 1;
    } else {
      let end = index + 1;
      while (end < text.length && !'{}[],:" \n\r\t'.includes(text[end] ?? '')) {
        end += 1;
      }
      parts.push(text.slice(index, end));
      index = end;
    }
  }
  return parts.join('');
}
