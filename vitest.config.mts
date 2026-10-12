import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.mts'],
		testTimeout: 30_000,
	},
});
