import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // テストは @parking/core を「ビルド済み dist」ではなく core のソースに直接
      // 解決する。これにより core を毎回ビルドしなくてもテストが回り、開発が速い
      // （本番ビルド時は backend が node_modules 経由で core の dist を参照する）。
      '@parking/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
