# Security policy

## Reporting a vulnerability

Report privately through GitHub security advisories, on the repository's Security
tab, under "Report a vulnerability". Do not open a public issue for a security
problem and do not describe one in a pull request.

A useful report says what an attacker can do, which version or commit it was found
on, and the smallest steps that reproduce it. Expect an acknowledgement within a
few days. A fix ships on the default branch with the advisory published alongside
it.

## Never put secrets in an issue

Issues, pull requests, discussions and advisories are for descriptions, not
credentials. Never paste an API key, a token, a coverage report from a private
repository, or a log that contains any of them. Name the environment variable
instead of its value. A key that has been pasted anywhere should be treated as
leaked and rotated.

## What covergen touches

covergen runs another repository's own test runner and writes lcov and scratch
state under that repository's `.covergen/` directory. It shells out with `execFile`
and an argv array, never a shell string. The Anthropic API key is read from `.env`
and handed to the client directly; it is deliberately kept out of `process.env` so
that a test runner spawned by covergen does not inherit it. A change that widens
any of that deserves a note in the pull request.
