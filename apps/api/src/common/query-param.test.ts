import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { singleQuery } from "./query-param";

describe("singleQuery", () => {
  it("laisse passer une valeur unique ou absente", () => {
    expect(singleQuery("a", "q")).toBe("a");
    expect(singleQuery(undefined, "q")).toBe(undefined);
  });

  it("refuse un paramètre répété par un 400", () => {
    expect(() => singleQuery(["a", "b"], "q")).toThrow(BadRequestException);
  });
});
