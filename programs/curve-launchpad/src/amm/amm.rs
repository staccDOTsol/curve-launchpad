use std::fmt;

#[derive(Debug)]
pub struct BuyResult {
    pub token_amount: u64,
    pub quote_amount: u64,
}

#[derive(Debug)]
pub struct SellResult {
    pub token_amount: u64,
    pub quote_amount: u64,
}

#[derive(Debug)]
pub struct AMM {
    pub virtual_quote_reserves: u128,
    pub virtual_token_reserves: u128,
    pub real_quote_reserves: u128,
    pub real_token_reserves: u128,
    pub initial_virtual_token_reserves: u128,
}

impl AMM {
    pub fn new(
        virtual_quote_reserves: u128,
        virtual_token_reserves: u128,
        real_quote_reserves: u128,
        real_token_reserves: u128,
        initial_virtual_token_reserves: u128,
    ) -> Self {
        AMM {
            virtual_quote_reserves,
            virtual_token_reserves,
            real_quote_reserves,
            real_token_reserves,
            initial_virtual_token_reserves,
        }
    }

    pub fn get_buy_price(&self, tokens: u128) -> Option<u128> {
        if tokens == 0 || tokens > self.virtual_token_reserves {
            return None;
        }

        let product_of_reserves = self.virtual_quote_reserves.checked_mul(self.virtual_token_reserves)?;
        let new_virtual_token_reserves = self.virtual_token_reserves.checked_sub(tokens)?;
        let new_virtual_quote_reserves = product_of_reserves.checked_div(new_virtual_token_reserves)?.checked_add(1)?;
        let amount_needed = new_virtual_quote_reserves.checked_sub(self.virtual_quote_reserves)?;

        Some(amount_needed)
    }

    pub fn apply_buy(&mut self, token_amount: u128) -> Option<BuyResult> {
        let final_token_amount = if token_amount > self.real_token_reserves {
            self.real_token_reserves
        } else {
            token_amount
        };

        let quote_amount = self.get_buy_price(final_token_amount)?;

        self.virtual_token_reserves = self.virtual_token_reserves.checked_sub(final_token_amount)?;
        self.real_token_reserves = self.real_token_reserves.checked_sub(final_token_amount)?;

        self.virtual_quote_reserves = self.virtual_quote_reserves.checked_add(quote_amount)?;
        self.real_quote_reserves = self.real_quote_reserves.checked_add(quote_amount)?;

        Some(BuyResult {
            token_amount: final_token_amount as u64,
            quote_amount: quote_amount as u64,
        })
    }

    pub fn apply_sell(&mut self, token_amount: u128) -> Option<SellResult> {
        self.virtual_token_reserves = self.virtual_token_reserves.checked_add(token_amount)?;
        self.real_token_reserves = self.real_token_reserves.checked_add(token_amount)?;

        let quote_amount = self.get_sell_price(token_amount)?;

        self.virtual_quote_reserves = self.virtual_quote_reserves.checked_sub(quote_amount)?;
        self.real_quote_reserves = self.real_quote_reserves.checked_sub(quote_amount)?;

        Some(SellResult {
            token_amount: token_amount as u64,
            quote_amount: quote_amount as u64,
        })
    }

    pub fn get_sell_price(&self, tokens: u128) -> Option<u128> {
        if tokens <= 0 || tokens > self.virtual_token_reserves {
            return None;
        }

        let scaling_factor = self.initial_virtual_token_reserves;

        let scaled_tokens = tokens.checked_mul(scaling_factor)?;
        let token_sell_proportion = scaled_tokens.checked_div(self.virtual_token_reserves)?;
        let quote_received = (self.virtual_quote_reserves.checked_mul(token_sell_proportion)?).checked_div(scaling_factor)?;

        Some(quote_received.min(self.real_quote_reserves))
    }
}


impl fmt::Display for AMM {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "AMM {{ virtual_quote_reserves: {}, virtual_token_reserves: {}, real_quote_reserves: {}, real_token_reserves: {}, initial_virtual_token_reserves: {} }}",
            self.virtual_quote_reserves, self.virtual_token_reserves, self.real_quote_reserves, self.real_token_reserves, self.initial_virtual_token_reserves
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::amm::AMM;

    #[test]
    fn test_buy_and_sell_too_much() {

        let virtual_quote_reserves = 600;
        let virtual_token_reserves = 600;
        let real_quote_reserves = 0;
        let real_token_reserves = 500;
        let initial_virtual_token_reserves = 1000;

        let mut amm = AMM::new(virtual_quote_reserves, virtual_token_reserves, real_quote_reserves, real_token_reserves, initial_virtual_token_reserves);

        // Attempt to buy more tokens than available in reserves
        let buy_result = amm.apply_buy(2000).unwrap();
        println!("{:?} \n", buy_result);
        assert_eq!(buy_result.token_amount, 500); // Should buy up to available real_token_reserves
        assert_eq!(buy_result.quote_amount, 3001);
        assert_eq!(amm.real_token_reserves, real_token_reserves - buy_result.token_amount as u128);
        assert_eq!(amm.virtual_token_reserves, virtual_token_reserves - buy_result.token_amount as u128);
        assert_eq!(amm.real_quote_reserves, real_quote_reserves + buy_result.quote_amount as u128);
        assert_eq!(amm.virtual_quote_reserves, virtual_quote_reserves + buy_result.quote_amount as u128);
        println!("{} \n", amm);
        println!("{:?} \n", buy_result);

        // Attempt to sell more tokens than available in reserves
        let sell_result = amm.apply_sell(2000).unwrap();
        assert_eq!(sell_result.token_amount, 2000); // Should sell requested amount
        assert_eq!(sell_result.quote_amount, 3001);
        assert_eq!(amm.real_quote_reserves, 0);
        assert_eq!(amm.virtual_quote_reserves, 600);
        assert_eq!(amm.real_token_reserves, 2000);
        assert_eq!(amm.virtual_token_reserves, 2100);
        println!("{} \n", amm);
        println!("{:?} \n", sell_result);
    }

    #[test]
    fn test_apply_sell() {
        let mut amm = AMM::new(1000, 1000, 500, 500, 1000);
        let result = amm.apply_sell(100).unwrap();

        assert_eq!(result.token_amount, 100);
        assert_eq!(result.quote_amount, 90);
        assert_eq!(amm.virtual_token_reserves, 1100);
        assert_eq!(amm.real_token_reserves, 600);
        assert_eq!(amm.virtual_quote_reserves, 910);
        assert_eq!(amm.real_quote_reserves, 410);
    }

    #[test]
    fn test_get_sell_price() {
        let amm = AMM::new(1000, 1000, 500, 500, 1000);

        // Edge case: zero tokens
        assert_eq!(amm.get_sell_price(0), None);

        // Normal case
        assert_eq!(amm.get_sell_price(100), Some(100));

        // Should not exceed real quote reserves
        assert_eq!(amm.get_sell_price(5000), None);
    }

    #[test]
    fn test_apply_buy() {
        let virtual_quote_reserves = 600;
        let virtual_token_reserves = 600;
        let real_quote_reserves = 500;
        let real_token_reserves = 500;
        let initial_virtual_token_reserves = 1000;

        let mut amm = AMM::new(
            virtual_quote_reserves,
            virtual_token_reserves,
            real_quote_reserves,
            real_token_reserves,
            initial_virtual_token_reserves
        );

        let purchase_amount = 100;

        let result = amm.apply_buy(100).unwrap();

        assert_eq!(result.token_amount, purchase_amount as u64);
        assert_eq!(result.quote_amount, 121);
        assert_eq!(amm.virtual_token_reserves, virtual_token_reserves - purchase_amount);
        assert_eq!(amm.real_token_reserves, real_token_reserves - purchase_amount);
        assert_eq!(amm.virtual_quote_reserves, 721);
        assert_eq!(amm.real_quote_reserves, 621);
    }

    #[test]
    fn test_get_buy_price() {
        let amm = AMM::new(1000, 1000, 500, 500, 1000);

        assert_eq!(amm.get_buy_price(0), None);

        // Normal case
        assert_eq!(amm.get_buy_price(100), Some(112));

        // Edge case: very large token amount
        assert_eq!(amm.get_buy_price(2000), None);
    }
}
