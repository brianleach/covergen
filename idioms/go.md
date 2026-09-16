# Go idioms

How tests are written for a Go package. Follow this exactly.

## Shape

- `func TestXxx(t *testing.T)`, one behavior each, in `<name>_test.go` beside the
  source file and in the **same package** as the code under test. An internal test
  reaches unexported identifiers, which is the point; do not write `package foo_test`
  unless the file you are extending already does.
- A new file starts with the package clause and its imports and nothing else. No
  `init`, no package-level state, no test helper file of your own.

## Table-driven, with subtests

- A set of inputs is one table and one `t.Run`, not a copied test:

```go
func TestRefundFee(t *testing.T) {
	tests := []struct {
		name  string
		cents int
		want  int
	}{
		{name: "under the threshold", cents: 500, want: 10},
		{name: "over the threshold", cents: 2000, want: 25},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RefundFee(tt.cents); got != tt.want {
				t.Errorf("RefundFee(%d) = %d, want %d", tt.cents, got, tt.want)
			}
		})
	}
}
```

- `t.Errorf` reports and keeps going, `t.Fatalf` stops the subtest. Use `t.Fatalf`
  only when continuing would panic (a nil result, a failed setup).
- Every failure message names the call, the value, and the expectation:
  `t.Errorf("Fn(%v) = %v, want %v", in, got, want)`.

## No real world

- Files go in `t.TempDir()`, never the repo and never `/tmp` by hand: it is removed
  for you. Environment variables go through `t.Setenv`, which restores the old value.
- HTTP is `httptest.NewServer` for a client and `httptest.NewRecorder` with
  `httptest.NewRequest` for a handler. Never dial a real host, never hit a real
  database.
- No `time.Sleep` to order anything: use a channel, `sync.WaitGroup`, or call the
  code directly. No unseeded randomness, no reading the real clock in an assertion.

## Portable, and race free

- The suite runs on a Linux runner and on a macOS runner. The test has to pass on
  both, so nothing may assume one of them: no `/proc` or `/sys` path, no
  `syscall` constant, no Keychain or `security` call, no hardcoded `PATH_MAX`.
- Paths come from `t.TempDir()` and `filepath.Join`, never from a string with a
  leading `/` written by hand, and never from a separator typed as `/` or `\`.
- Genuine platform behavior is guarded by a check that skips, before the setup it
  protects:

```go
if runtime.GOOS != "linux" {
	t.Skip("cgroup limits are read from /sys, which only Linux has")
}
```

  A `runtime.GOOS` branch that changes the expectation instead of skipping is not
  a guard: it still runs on the other machine.

- The gate runs `go test -race`, so every goroutine the test starts must be
  synchronized: `sync.WaitGroup` or a channel to join it, a mutex or a channel for
  anything it writes. A value shared with a goroutine and read after it, without
  either, is a data race, and the detector fails the test whether or not the
  arithmetic came out right.

## Assert on behavior

- Compare the returned value to the value written out in the test. Never assert only
  that something is non-nil, and never compare a value to itself.
- Errors are asserted with `errors.Is(err, ErrThing)` (or `errors.As` for a typed
  error), not by comparing `err.Error()` to a string. A function that returns an
  error gets both cases: the error path and the happy path.
- Check the error before the value: `if err != nil { t.Fatalf("Fn() error = %v", err) }`,
  then assert on the result.
- Use `reflect.DeepEqual` for slices and maps, and say so in the failure message.

## Formatting

- The file must be exactly what `gofmt` writes: tabs for indentation, one statement
  per line, grouped imports. Unformatted code is rejected before it is run.
