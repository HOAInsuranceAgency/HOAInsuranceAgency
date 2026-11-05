import { build } from 'vite';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const previews = readdirSync(scripts, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.endsWith('-preview'))
  .map(entry => entry.name).sort();
if (!previews.length) throw new Error('No local preview configurations were found.');
for (const name of previews) {
  // Compile real scenarios and aliases without servers, credentials, uploads or output files.
  try {
    await build({
      configFile: join(scripts, name, 'vite.config.ts'),
      logLevel: 'error',
      build: { write: false, watch: null, copyPublicDir: false },
    });
  } catch (error) {
    console.error('Preview check failed (' + name + '): ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    break;
  }
  console.log('Verified fictional preview: ' + name);
}
