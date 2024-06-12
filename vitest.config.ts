import { defineConfig } from 'vitest/config';
import commonjs from '@rollup/plugin-commonjs';

export default defineConfig({
	test: {
		include: ['./src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
		setupFiles: ['./vitest.setup.ts'],
	},
	plugins: [commonjs()],
});
