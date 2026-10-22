import { afterEach, expect, it } from "vitest";
import { dataMode } from "../lib/data";

const original = process.env.ORRY_FIXTURES;
afterEach(() => {
  if (original === undefined) delete process.env.ORRY_FIXTURES;
  else process.env.ORRY_FIXTURES = original;
});

it("uses real Core data unless fixtures are explicitly enabled", () => {
  delete process.env.ORRY_FIXTURES;
  expect(dataMode()).toBe("bridge");
  process.env.ORRY_FIXTURES = "0";
  expect(dataMode()).toBe("bridge");
  process.env.ORRY_FIXTURES = "1";
  expect(dataMode()).toBe("fixtures");
});
