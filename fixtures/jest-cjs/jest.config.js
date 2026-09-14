/** CommonJS project: no babel config, no transform, plain Node. */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/src/__tests__/**/*.test.js"],
  collectCoverageFrom: ["src/**/*.js", "!src/__tests__/**"],
};
