package rates

import "testing"

func TestServiceFee(t *testing.T) {
	if got := ServiceFee(500); got != 50 {
		t.Fatalf("ServiceFee(500) = %d, want 50", got)
	}
}
