package rates

import "testing"

// Runs the code and checks nothing, which is the case the audit reports.
func TestApplyRate(t *testing.T) {
	ApplyRate(100, 10)
}
