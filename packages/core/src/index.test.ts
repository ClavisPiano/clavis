import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@clavis/core", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@clavis/core");
  });
});
