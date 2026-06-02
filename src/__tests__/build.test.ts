import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../../dist");

describe("build output", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(resolve(distDir, "index.js"))).toBe(true);
  });

  it("dist/index.d.ts exists", () => {
    expect(existsSync(resolve(distDir, "index.d.ts"))).toBe(true);
  });
});
