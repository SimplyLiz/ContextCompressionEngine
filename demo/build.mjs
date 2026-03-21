import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'CCE',
  outfile: 'demo/bundle.js',
  target: 'es2020',
  platform: 'browser',
});

console.log('Built demo/bundle.js');
