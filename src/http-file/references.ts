import type { ParseDiagnostic, Range, VariableReference } from './model';

export interface ReferenceScan {
  references: VariableReference[];
  diagnostics: ParseDiagnostic[];
}

function span(line: number, start: number, end: number): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

export function scanReferences(text: string, line: number): ReferenceScan {
  const scan: ReferenceScan = { references: [], diagnostics: [] };
  let from = 0;
  for (let open = text.indexOf('{{', from); open !== -1; open = text.indexOf('{{', from)) {
    const close = text.indexOf('}}', open + 2);
    if (close === -1) {
      scan.diagnostics.push({
        code: 'unclosed-variable',
        message: '"{{" has no closing "}}"; the text is sent as written.',
        severity: 'error',
        range: span(line, open, text.trimEnd().length),
      });
      break;
    }
    const range = span(line, open, close + 2);
    const expression = text.slice(open + 2, close).trim();
    if (expression === '') {
      scan.diagnostics.push({
        code: 'empty-variable',
        message: 'Empty variable reference.',
        severity: 'error',
        range,
      });
    } else {
      scan.references.push({ expression, range });
    }
    from = close + 2;
  }
  return scan;
}
