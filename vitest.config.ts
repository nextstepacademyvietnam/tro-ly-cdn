import { defineConfig } from "vitest/config";

export default defineConfig({
  // 15 giây: test băm mật khẩu và Postgres-trong-Node (PGlite) chậm khi chạy song song trên máy yếu.
  test: { include: ["src/**/*.test.ts"], env: { LOG_LEVEL: "silent" }, testTimeout: 15_000 },
});
