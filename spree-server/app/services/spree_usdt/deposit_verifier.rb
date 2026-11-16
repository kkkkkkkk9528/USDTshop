# frozen_string_literal: true

require Rails.root.join('lib/usdt_exchange_rate').to_s unless defined?(UsdtExchangeRate)

module SpreeUsdt
  # Matches on-chain USDT deposits to waiting Spree payments.
  #
  # TRC20 transfers carry no memo that TronGrid exposes, so a deposit is
  # identified by (expected USDT amount + time window + unused txid). The
  # oldest waiting payment with the same amount wins; a transaction hash can
  # only ever settle one payment.
  #
  # The expected amount is NOT the raw order total: orders are priced in the
  # store's local currency, so it is converted with UsdtExchangeRate —
  # the same service that produces the amount shown on the checkout card.
  # A rate snapshot is frozen into payment.metadata by CheckDepositsJob, so a
  # rate change after checkout can never make a correctly paid order unmatchable.
  class DepositVerifier
    # A transfer only counts when it was confirmed inside the shopper's
    # payment window. Pre-order transfers are no longer auto-matched: the
    # storefront shows the address AFTER the order exists, so there is no
    # legitimate reason for a deposit to precede the payment itself.
    LOOKBEHIND = 0.seconds
    PAYMENT_WINDOW = SpreeUsdt::PaymentWindow::LENGTH
    CHAIN_GRACE = SpreeUsdt::PaymentWindow::CHAIN_GRACE
    MAX_PAYMENT_AGE = 7.days    # chain lookback + late-deposit review window
    CONFIRMATION_DELAY = 20.seconds # a few TRON blocks, guards against reorgs
    AMOUNT_TOLERANCE = BigDecimal('0.000001')
    WAITING_STATUSES = %w[pending checkout].freeze

    attr_reader :payment_method, :chain_client

    def initialize(payment_method, chain_client: nil, since: nil)
      @payment_method = payment_method
      @chain_client = chain_client || ChainClient.new(payment_method.effective_wallet_address)
      @since = since
    end

    # @return [ChainClient::Transaction, nil]
    def find_for(payment)
      return nil unless matchable?(payment)

      transactions.find do |tx|
        matches_amount?(payment, tx) &&
          matches_window?(payment, tx) &&
          !claimed_by_another_payment?(tx.txid, payment)
      end
    end

    # One API walk serves every waiting payment on the same wallet.
    def transactions
      @transactions ||= chain_client.incoming_transactions(since: fetch_since)
    end

    # Public wrapper used by the late-deposit audit on expired payments.
    def expected_amount_for(payment)
      expected_usdt_amount(payment)
    end

    def auto_check_available?
      payment_method.effective_network.to_s.upcase == 'TRC20' &&
        payment_method.effective_wallet_address.present?
    end

    private

    def fetch_since
      @since || (Time.current - MAX_PAYMENT_AGE - LOOKBEHIND)
    end

    def matchable?(payment)
      return false unless auto_check_available?
      return false unless WAITING_STATUSES.include?(payment.status)
      return false unless payment.amount.to_d.positive?
      return false if payment.created_at.blank?
      return false if payment.created_at.utc < MAX_PAYMENT_AGE.ago
      # Even if the expiry sweep has not run yet, never confirm a deposit
      # that arrived after the payment window closed.
      return false if SpreeUsdt::PaymentWindow.expired?(payment)

      true
    end

    def matches_amount?(payment, tx)
      expected = expected_usdt_amount(payment)
      if expected.nil?
        Rails.logger.warn("[SpreeUsdt] no FX quote for payment #{payment.id}; leaving it pending")
        return false
      end

      (tx.amount - expected).abs <= AMOUNT_TOLERANCE
    end

    # Prefer the rate locked when the payment first appeared. Without a
    # snapshot (e.g. the shopper paid before the first sweep) the live rate is
    # used, which is the same ECB value the checkout displayed.
    def expected_usdt_amount(payment)
      locked = payment.metadata&.dig('usdt_quote', 'amount_usdt')
      return BigDecimal(locked.to_s) if locked.present?

      UsdtExchangeRate.convert(payment.amount.to_d, currency_for(payment))
    rescue ArgumentError
      nil
    end

    def currency_for(payment)
      payment.owner&.currency.presence || 'USD'
    end

    def matches_window?(payment, tx)
      earliest = payment.created_at.utc - LOOKBEHIND
      latest = [SpreeUsdt::PaymentWindow.closed_at(payment),
                Time.current - CONFIRMATION_DELAY].min

      tx.timestamp >= earliest && tx.timestamp <= latest
    end

    def claimed_by_another_payment?(txid, payment)
      Spree::Payment.where(response_code: txid).where.not(id: payment.id).exists?
    end
  end
end
