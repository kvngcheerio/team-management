import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      BETTER_AUTH_SECRET: string;
      SETUP_TOKEN: string;
    }
  }
}
export {};
