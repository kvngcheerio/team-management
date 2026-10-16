import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        main: "./src/worker/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENV: "test",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
            BETTER_AUTH_URL: "http://localhost",
            SETUP_TOKEN: "test-setup-token",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    include: ["test/**/*.test.ts"],
  },
});
