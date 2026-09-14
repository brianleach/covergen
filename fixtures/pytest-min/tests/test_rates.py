from shop.rates import fee


def test_fee_takes_the_rate_out_of_the_amount():
    assert fee(1000) == 100
