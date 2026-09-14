# pytest idioms

How tests are written for a Python package on pytest. Follow this exactly.

## Shape

- Module-level functions named `test_<what_it_does>`, one behavior each. No
  `unittest.TestCase`, no class wrapper unless the file already uses one.
- Import the module under test by its real import path, never a private name. A new
  file starts with its imports and nothing else: no `sys.path` edits, no `conftest.py`.

## Fixtures, not setup functions

- Shared state is a `@pytest.fixture`, not a module-level global and not
  `setup_function`. Keep it in the test file unless `conftest.py` already has it.
- Prefer the builtins: `tmp_path` for anything on disk (never the repo, never the
  working directory), `monkeypatch` for env vars and attributes (`setenv`,
  `setattr`, and it undoes itself when the test fails), `capsys`, `caplog`.
- A table of inputs is one `@pytest.mark.parametrize("cents,expected", [(0, 0),
  (1000, 100)])`, not a loop: a loop reports one failure for the whole table.

## No real world

- No network: stub the client (`monkeypatch.setattr`, `unittest.mock.patch`, or
  `responses` if the repo already uses it). No real clock: freeze or inject it,
  never assert on `datetime.now()`. No `time.sleep`, no unseeded randomness.

## Assert on behavior

- `assert fee(1000) == 100`, with the expected value written out. Never
  `assert result is not None`, `assert result`, or a lone `isinstance` check: all
  three pass when the function is wrong.
- Expected errors are `with pytest.raises(ValueError, match="must not be negative"):`,
  with the match, so a different error of the same class does not pass.
- Assert on what the caller sees: the return value, the raised error, the file
  written, never a private attribute. Never `assert True`, never compare a value to
  itself, never `skip` or `xfail` a test you just wrote.
