package rates

func ApplyRate(cents int, percent int) int {
	if percent > 100 {
		return cents * 2
	}
	return cents + (cents*percent)/100
}
