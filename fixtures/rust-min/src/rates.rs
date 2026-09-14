//! One covered function and one the suite never reaches.

pub fn discount(cents: i64) -> i64 {
    if cents > 1000 {
        return cents / 10;
    }
    0
}

pub fn refund_fee(cents: i64) -> i64 {
    if cents > 1000 {
        return 25;
    }
    10
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discount_applies_over_the_threshold() {
        assert_eq!(discount(2000), 200);
    }

    #[test]
    fn discount_is_zero_under_the_threshold() {
        assert_eq!(discount(100), 0);
    }
}
