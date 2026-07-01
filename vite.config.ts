import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      // Buffer et process sont requis par @solana/web3.js dans le navigateur
      include: ['buffer', 'process'],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  optimizeDeps: {
    include: ['@solana/web3.js', 'bs58'],
  },
});
