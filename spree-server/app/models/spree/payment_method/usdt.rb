module Spree
  # USDT (Tether) on-chain payment method.
  #
  # Checkout only authorizes: the payment stays `pending` and the order can
  # be placed, but it is not treated as paid until a confirmed TRC20-USDT
  # transfer to the store wallet is observed by SpreeUsdt::CheckDepositsJob.
  # That job records the matching txid on the payment and runs Spree's
  # capture workflow; #capture below refuses to settle anything that has not
  # been verified on-chain, so an accidental manual "capture" in the admin
  # cannot mark unpaid orders as paid.
  #
  # The connected SpreeUsdt::Integration is the single source of truth for
  # the wallet. The preference columns are a synced cache; the shopper-facing
  # copy lives in `description` because the Store API does not serialise
  # preferences for payment methods.
  class PaymentMethod::Usdt < ::Spree::PaymentMethod
    self.accepts_money_amounts = true

    preference :wallet_address, :string
    preference :network, :string, default: 'TRC20'
    preference :notes, :string

    # Backed by the store's own USDT integration credentials, so it is
    # listed under payment providers rather than manual payment methods.
    def self.third_party?
      true
    end

    def self.display_name
      'USDT (Tether)'
    end

    def self.human_description
      'USDT crypto transfer. Funds are verified on-chain and the payment is completed automatically.'
    end

    def actions
      %w{capture void}
    end

    # Never charge at checkout. Spree's process workflow then calls
    # #authorize, and a successful authorization leaves the payment
    # `pending`, which Spree already accepts as covering the order at
    # completion (Carts::Complete#payment_covered?).
    def capture_at_checkout?
      false
    end

    def authorize(*)
      Spree::PaymentResponse.new(true, 'Waiting for an on-chain USDT transfer', {}, {})
    end

    # A forced purchase (e.g. an admin "capture payments" action) must not
    # bypass on-chain verification. It has no verified txid to check, so it
    # fails loudly and points the operator at the automatic sweep.
    def purchase(*)
      Spree::PaymentResponse.new(false, 'USDT payments are completed automatically after an on-chain deposit is confirmed')
    end

    def can_capture?(payment)
      ['checkout', 'pending'].include?(payment.status)
    end

    def can_void?(payment)
      payment.status != 'void'
    end

    # @param response_code [String] the txid recorded by CheckDepositsJob
    def capture(_amount, response_code, _gateway_options = {})
      return unverified_response if response_code.blank?

      payment = Spree::Payment.find_by(response_code: response_code)
      record = payment&.metadata&.dig('usdt')

      verified = record &&
                 record['txid'] == response_code &&
                 record['verified_at'].present? &&
                 record['wallet_address'] == effective_wallet_address &&
                 record['network'].to_s.upcase == effective_network.to_s.upcase

      return unverified_response unless verified

      Spree::PaymentResponse.new(
        true,
        "USDT deposit confirmed on-chain (#{response_code})",
        {},
        { authorization: response_code }
      )
    end

    def cancel(*, **)
      simulated_successful_billing_response
    end

    def void(*)
      simulated_successful_billing_response
    end

    def source_required?
      false
    end

    def credit(*)
      simulated_successful_billing_response
    end

    # --- Wallet address wiring -------------------------------------------

    def integration
      SpreeUsdt::Integration.active.find_by(store_id: store_id)
    end

    def effective_wallet_address
      integration&.preferred_wallet_address.presence || preferred_wallet_address
    end

    def effective_network
      integration&.preferred_network.presence || preferred_network
    end

    def effective_notes
      integration&.preferred_notes.presence || preferred_notes
    end

    # Store API only serialises name/description/type for a payment method,
    # and the checkout renders `description` for direct methods. Keep this
    # payload language-neutral: the storefront renders every shopper-facing
    # string from its own locale bundle and only parses the network and the
    # wallet address out of this text. Admin-authored notes pass through
    # unchanged so operators can keep writing their own instructions.
    def payment_instructions
      return if effective_wallet_address.blank?

      lines = ["USDT (#{effective_network.presence || 'TRC20'}) #{effective_wallet_address}"]
      lines << effective_notes.to_s.strip if effective_notes.present?
      lines.join("\n")
    end

    # Refresh the cached preferences and the shopper-facing description from
    # the integration. Called when the integration changes and by operators
    # wiring up an existing payment method.
    def sync_from_integration!
      set_preference(:wallet_address, effective_wallet_address)
      set_preference(:network, effective_network)
      set_preference(:notes, effective_notes)
      self.description = payment_instructions
      save!
    end

    private

    def unverified_response
      Spree::PaymentResponse.new(false, 'USDT deposit is not confirmed on-chain yet; the automatic sweep will complete the payment once it is detected')
    end

    def simulated_successful_billing_response
      Spree::PaymentResponse.new(true, '', {}, {})
    end
  end
end
