import { describe, expect, test } from "bun:test";
import { classifyPrismaError } from "./classify.ts";

const known = (code: string) => Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code });

describe("classifyPrismaError (Decision J4)", () => {
  test("data and constraint codes are poison", () => {
    for (const code of ["P2000", "P2002", "P2006", "P2007", "P2011", "P2020"]) {
      expect(classifyPrismaError(known(code))).toBe("poison");
    }
  });

  test("validation errors are poison", () => {
    expect(classifyPrismaError(Object.assign(new Error("x"), { name: "PrismaClientValidationError" }))).toBe("poison");
  });

  test("connection errors and unknown codes are unreachable", () => {
    expect(classifyPrismaError(known("P1001"))).toBe("unreachable");
    expect(classifyPrismaError(known("P2024"))).toBe("unreachable");
    expect(classifyPrismaError(Object.assign(new Error("x"), { name: "PrismaClientInitializationError" }))).toBe("unreachable");
    expect(classifyPrismaError(new Error("ECONNRESET"))).toBe("unreachable");
  });

  test("non-error values are unreachable", () => {
    expect(classifyPrismaError(null)).toBe("unreachable");
    expect(classifyPrismaError("P2002")).toBe("unreachable");
    expect(classifyPrismaError({ code: "P2002" })).toBe("unreachable");
  });
});
