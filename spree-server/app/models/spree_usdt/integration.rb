module SpreeUsdt
  # Per-store USDT (Tether) payment provider credentials.
  #
  # Shows up in the admin "Integrations" page under the payments group so it
  # sits alongside the other payment service providers. The wallet address,
  # network and cashier notes are stored per store; the checkout-side
  # PaymentMethod::Usdt gateway reads them from the connected integration,
  # and SpreeUsdt::CheckDepositsJob polls that address for incoming USDT.
  class Integration < Spree::Integration
    NETWORKS = %w[TRC20 ERC20 BEP20 OMNI].freeze

    TRC20_ADDRESS = /\AT[1-9A-HJ-NP-Za-km-z]{33}\z/
    EVM_ADDRESS = /\A0x[0-9a-fA-F]{40}\z/
    OMNI_ADDRESS = /\A[13][1-9A-HJ-NP-Za-km-z]{25,33}\z/

    # Declared credentials first: they are what an operator must supply,
    # and the form renders in this order.
    preference :wallet_address, :string
    preference :network, :string, default: 'TRC20', choices: NETWORKS
    # Free-text instructions shown to shoppers at checkout (e.g. minimum
    # amount, memo/tag requirement, confirmation-count policy).
    preference :notes, :string

    validates :preferred_network, inclusion: { in: NETWORKS }, allow_blank: true

    def self.integration_group
      'payments'
    end

    def self.integration_name
      'USDT (Tether)'
    end

    def self.description
      'Accept USDT transfers. On TRC20, confirmed deposits are matched to orders automatically and completed without staff action.'
    end

    def self.docs_url
      'https://tether.to/'
    end

    # Automatic settlement reads the TRON chain. Other networks can still be
    # configured for manual reconciliation, but no auto-check runs for them.
    def supports_auto_check?
      preferred_network.to_s.upcase == 'TRC20' && preferred_wallet_address.present?
    end

    # Connecting only requires a well-formed address — there is no remote API
    # to verify against, so validate locally and surface a clean error
    # instead of letting a placeholder like "asdfghjkl" save silently.
    def can_connect?
      address = preferred_wallet_address.to_s.strip

      if address.blank?
        self.connection_error_message = 'Wallet address is required'
        return false
      end

      unless valid_address?(address)
        self.connection_error_message = "Wallet address is not a valid #{preferred_network.to_s.upcase.presence || 'USDT'} address"
        return false
      end

      true
    end

    # The payment method caches these credentials so the checkout can show
    # them. Keep that cache (and the shopper-facing description) in step
    # whenever this integration is created or edited.
    after_commit :sync_usdt_payment_methods, on: %i[create update]

    private

    def valid_address?(address)
      case preferred_network.to_s.upcase
      when 'TRC20' then address.match?(TRC20_ADDRESS)
      when 'ERC20', 'BEP20' then address.match?(EVM_ADDRESS)
      when 'OMNI' then address.match?(OMNI_ADDRESS)
      else false
      end
    end

    def sync_usdt_payment_methods
      Spree::PaymentMethod::Usdt
        .where(store_id: store_id, active: true)
        .find_each do |payment_method|
          begin
            payment_method.sync_from_integration!
          rescue StandardError => e
            Rails.logger.warn("[SpreeUsdt] could not sync payment method #{payment_method.id}: #{e.message}")
          end
        end
    end
  end
end
