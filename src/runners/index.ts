/**
 * Runner registry. getRunner(name) returns the singleton adapter for rspec,
 * vitest, bun, jest, pytest, go or cargo.
 */

import type { Runner, RunnerName } from "../types.js";
import { bunRunner } from "./bun.js";
import { cargoRunner } from "./cargo.js";
import { goRunner } from "./go.js";
import { jestRunner } from "./jest.js";
import { pytestRunner } from "./pytest.js";
import { rspecRunner } from "./rspec.js";
import { vitestRunner } from "./vitest.js";

const runners: Record<RunnerName, Runner> = {
  rspec: rspecRunner,
  vitest: vitestRunner,
  bun: bunRunner,
  jest: jestRunner,
  pytest: pytestRunner,
  go: goRunner,
  cargo: cargoRunner,
};

export function getRunner(name: RunnerName): Runner {
  const runner = runners[name];
  if (!runner) throw new Error(`Unknown runner "${name}". Known: ${Object.keys(runners).join(", ")}`);
  return runner;
}

export { runCommand, withPrefix, coverageOutDir, resolveLcov, OUTPUT_CAP_BYTES } from "./exec.js";
export type { ExecFn, ExecOptions, ExecResult } from "./exec.js";
export { createRspecRunner, RSPEC_SIMPLECOV_SNIPPET } from "./rspec.js";
export { createVitestRunner } from "./vitest.js";
export { createBunRunner } from "./bun.js";
export { createJestRunner } from "./jest.js";
export { createPytestRunner, covTargets, pytestSettings } from "./pytest.js";
export { createGoRunner, goSettings, packagesForFiles, parseGoVersion, parsePackageList, profileToLcov, resolveProfilePath } from "./go.js";
export { cargoSettings, cfgTestRanges, createCargoRunner, packageForFile, parsePackageDirs, stripCfgTests } from "./cargo.js";
