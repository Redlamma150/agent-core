import { defineConfig } from "vitest/config";

// Only our own tests: data/worktrees holds checkouts of the owner's projects, whose test files are not ours.
export default defineConfig({ test: { include: ["tests/**/*.test.ts", "app/src/**/*.test.ts"], exclude: ["node_modules", "data", "app/dist"] } });
