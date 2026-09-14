const { backoffMs } = require("../retry.js");

describe("backoffMs", () => {
  it("doubles and caps", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(10)).toBe(30000);
  });
});
