// Fake runner for the exec tests: spawns a grandchild that inherits stdout and outlives it,
// then exits cleanly. That is the shape of a test worker reparented to init while still holding
// the runner's stdout pipe open, which is what used to hang a run past its timeout.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const grandchild = spawn("sleep", ["60"], { stdio: ["ignore", "inherit", "inherit"] });
grandchild.unref();
writeSync(1, `GRANDCHILD_PID=${grandchild.pid}\n`);
process.exit(0);
