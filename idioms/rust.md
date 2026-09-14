# Rust idioms

How tests are written for a Rust crate. Follow this exactly.

## Shape

- Unit tests live in the file they test, inside `#[cfg(test)] mod tests { ... }` at
  the bottom, with `use super::*;` as the first line of the module. That module sees
  private items, which is the point.
- When the file already has a `#[cfg(test)] mod tests`, add your `#[test]` functions
  inside it rather than opening a second module with the same name: two `mod tests`
  in one file do not compile.
- One behavior per `#[test] fn`, named for the behavior and not the function under
  test: `fn refunds_nothing_under_the_threshold()`.
- Integration tests go in `tests/<name>.rs` and reach only the public API. Write one
  only when the file being extended already works that way.

## Assert on behavior

- `assert_eq!(got, want)` for values, with the call inline:
  `assert_eq!(refund_fee(2000), 25);`. `assert!(cond)` only for a real boolean.
- Never assert that something merely exists: `assert!(result.is_some())` alone proves
  nothing. Unwrap it and compare the value.
- `Result` gets both variants. The happy path is
  `assert_eq!(parse("7").unwrap(), 7);` and the failure path matches the variant:

```rust
#[test]
fn rejects_a_non_number() {
    let err = parse("seven").unwrap_err();
    assert!(matches!(err, ParseError::NotANumber));
}
```

- Prefer `matches!` or a `match` over comparing `format!("{err}")` to a string: the
  message is wording, the variant is behavior.
- `unwrap()` and `expect("...")` are fine in a test. A panic is a test failure with a
  line number, which is what you want.

## Panics

- `#[should_panic(expected = "...")]` only for a function whose documented contract
  is to panic, and always with `expected` so it cannot pass on an unrelated panic.
  A function that returns `Result` is asserted on the `Err`, never on a panic.

## No real world

- No network, ever. No reading the real clock, no unseeded randomness, no
  `thread::sleep` to order anything.
- Files go in a `tempfile::TempDir` when the crate already depends on `tempfile`,
  never in the repo and never in `/tmp` by hand. If it does not, test the pure
  function instead of the file path.
- Do not add a dependency to `Cargo.toml`. Use what the crate already has.

## Form

- No `#[ignore]`, no commented-out assertions, no test that only constructs a value.
- Keep the module free of helper scaffolding unless the file already has some.
- The file must be what `rustfmt` writes: four spaces, trailing commas in multi-line
  literals.
