import { rmSync } from 'node:fs';

export function removeTemporaryFolder(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== 'win32') {
      throw error;
    }
  }
}
