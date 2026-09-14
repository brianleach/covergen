# Fee arithmetic: one function the single test covers, one it never reaches.
def fee(cents: int, rate: int = 10) -> int:
    if cents < 0:
        raise ValueError("cents must not be negative")
    return cents * rate // 100


def refund_fee(cents: int, refunded: bool) -> int:
    if refunded:
        return 0
    if cents > 1000:
        return fee(cents) // 2
    return fee(cents)
