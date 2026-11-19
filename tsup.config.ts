import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // shared/ ফোল্ডার (tsconfig paths: @chamberai/shared) বান্ডেলের ভেতরে ঢোকে; npm প্যাকেজগুলো বাইরে থাকে
  noExternal: ["@chamberai/shared"],
});
