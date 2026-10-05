// Bundles the shared card detector (src/components/overlayCards/detectSpecialContent.ts)
// into backend/cards/detect.generated.js so the backend can build cards for the
// Apple Watch. Run: npm run build:detect
import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  build: {
    outDir: path.join(root, 'backend/cards'),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: path.join(root, 'src/components/overlayCards/detectSpecialContent.ts'),
      formats: ['es'],
      fileName: () => 'detect.generated.js',
    },
  },
});
console.log('backend/cards/detect.generated.js written');
