package rates

func ServiceFee(cents int) int {
	return cents / 10
}

func RefundFee(cents int) int {
	if cents > 1000 {
		return 25
	}
	return 10
}
