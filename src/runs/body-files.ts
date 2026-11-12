import { realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const nativeRealpath = promisify(realpath.native);

export interface BodyFileContext {
  documentDir: string | undefined;
  containmentRoot: string | undefined;
  restricted: boolean;
}

type Located = { ok: true; path: string; size: number } | { ok: false; message: string };

async function realPath(candidate: string): Promise<string | undefined> {
  try {
    return await nativeRealpath(candidate);
  } catch {
    return undefined;
  }
}

function isInside(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export async function locateBodyFile(
  file: string,
  context: Pick<BodyFileContext, 'documentDir' | 'containmentRoot'>,
): Promise<Located> {
  const { containmentRoot, documentDir } = context;
  if (containmentRoot === undefined) {
    return { ok: false, message: 'Save the .http file first: body files are read relative to it.' };
  }
  const root = (await realPath(containmentRoot)) ?? containmentRoot;
  const candidates = path.isAbsolute(file)
    ? [file]
    : [containmentRoot, documentDir].flatMap((base) =>
        base === undefined ? [] : [path.resolve(base, file)],
      );
  for (const candidate of new Set(candidates)) {
    const real = await realPath(candidate);
    if (real === undefined) {
      continue;
    }
    if (!isInside(real, root)) {
      return { ok: false, message: `Body file \`${file}\` resolves outside the workspace folder.` };
    }
    const details = await stat(real);
    if (details.isFile()) {
      return { ok: true, path: real, size: details.size };
    }
  }
  return { ok: false, message: `Body file \`${file}\` was not found.` };
}
