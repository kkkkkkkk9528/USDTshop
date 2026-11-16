# frozen_string_literal: true

require Rails.root.join('lib/usdt_exchange_rate').to_s unless defined?(UsdtExchangeRate)

module SpreeUsdt
  # Sweeps waiting USDT payments against the chain. Safe to run by hand
  # (`usdt:check_deposits`) and safe to run concurrently — settlement is a
  # compare-and-swap on the payment row plus Spree's own idempotent capture
  # workflow.
  #
  # Scheduling: config/recurring.yml registers this job every minute, which
  # takes effect the next time Puma (and its Solid Queue supervisor) restarts.
  # Until then a self-rescheduling job chain, persisted in solid_queue_jobs,
  # keeps the check running without touching the live Puma process. When the
  # recurring task appears in the database the chain quietly retires.
  class CheckDepositsJob < ApplicationJob
    INTERVAL = 1.minute

    queue_as :usdt_deposits

    class << self
      # Idempotently start/resume the self-scheduling chain.
      # @return [Symbol] :started, :already_running, or :recurring
      def start!
        return :recurring if handed_over_to_recurring?
        return :already_running if running?

        set(wait: INTERVAL).perform_later(true)
        :started
      end

      def running?
        return false unless defined?(SolidQueue::Job)

        SolidQueue::Job.where(class_name: name, finished_at: nil).exists?
      end

      def handed_over_to_recurring?
        return false unless defined?(SolidQueue::RecurringTask)

        SolidQueue::RecurringTask.static.exists?(key: 'check_usdt_deposits')
      rescue StandardError
        false
      end
    end

    # @param reschedule [Boolean] true only for the self-scheduling chain;
    #   recurring/manual invocations leave it false so they cannot spawn a
    #   second chain.
    def perform(reschedule = false)
      sweep
    ensure
      if reschedule && !self.class.handed_over_to_recurring?
        begin
          self.class.set(wait: INTERVAL).perform_later(true)
        rescue StandardError => e
          Rails.logger.error("[SpreeUsdt] could not reschedule deposit check: #{e.message}")
        end
      end
    end

    private

    def sweep
      # Close the window first: an unpaid order is canceled and its stock is
      # released before it can ever be auto-confirmed by a late transfer.
      expired = expire_overdue_payments

      payments = waiting_payments
      payments.each do |payment|
        SpreeUsdt::PaymentWindow.mark_order!(payment, SpreeUsdt::PaymentWindow::AWAITING)
      end

      confirmed = 0
      failed = 0

      payments.group_by(&:payment_method_id).each do |method_id, group|
        payment_method = Spree::PaymentMethod::Usdt.find(method_id)
        verifier = DepositVerifier.new(
          payment_method,
          since: group.first.created_at - DepositVerifier::LOOKBEHIND
        )
        next unless verifier.auto_check_available?

        group.each do |payment|
          # Freeze the checkout quote before matching. A rate change on a later
          # business day must not invalidate an already displayed amount.
          next unless ensure_quote!(payment)

          tx = verifier.find_for(payment)
          next unless tx

          if settle(payment, tx, payment_method)
            confirmed += 1
          else
            failed += 1
          end
        end
      rescue ChainError => e
        Rails.logger.warn("[SpreeUsdt] deposit check skipped for method #{method_id}: #{e.message}")
      end

      late = record_late_deposits

      Rails.logger.info("[SpreeUsdt] deposit check: #{payments.size} waiting, #{confirmed} confirmed, #{failed} failed, #{expired} expired, #{late} late deposits")
      { checked: payments.size, confirmed: confirmed, failed: failed, expired: expired, late_deposits: late }
    rescue StandardError => e
      Rails.logger.error("[SpreeUsdt] deposit check crashed: #{e.class}: #{e.message}")
      raise
    end

    def waiting_payments
      method_ids = Spree::PaymentMethod::Usdt.pluck(:id)
      return [] if method_ids.empty?

      Spree::Payment
        .where(payment_method_id: method_ids, status: DepositVerifier::WAITING_STATUSES)
        .where('created_at >= ?', DepositVerifier::MAX_PAYMENT_AGE.ago)
        .order(:created_at)
        .to_a
    end

    # Lock the fiat -> USDT quote on the payment the first time the sweep sees
    # it. The storefront shows the same UsdtExchangeRate#convert result, so both
    # sides agree on the exact 2-decimal amount to expect on-chain. If no rate
    # is available the payment stays pending instead of being matched against
    # a guessed amount.
    # @return [Boolean] whether matching may proceed
    def ensure_quote!(payment)
      return true if payment.metadata&.dig('usdt_quote', 'amount_usdt').present?

      currency = payment.owner&.currency.presence || 'USD'
      quote = UsdtExchangeRate.quote(amount: payment.amount.to_d, currency: currency)
      unless quote
        Rails.logger.warn("[SpreeUsdt] no FX quote for #{currency}; payment #{payment.id} stays pending")
        return false
      end

      payment.with_lock do
        payment.reload
        next if payment.metadata&.dig('usdt_quote', 'amount_usdt').present?

        payment.update!(
          metadata: (payment.metadata || {}).deep_dup.merge(
            'usdt_quote' => quote.merge('locked_at' => Time.current.iso8601)
          )
        )
      end
      true
    end

    # Returns true when the payment reached `completed`.
    def settle(payment, tx, payment_method)
      already_recorded = false
      claimed = false

      # Short lock: only claim the row and record the audit trail. Never call
      # the capture workflow inside it — that workflow locks the order/cart
      # itself, and nesting the two locks invites deadlocks.
      payment.with_lock do
        payment.reload
        if !DepositVerifier::WAITING_STATUSES.include?(payment.status)
          # nothing to do
        elsif payment.response_code == tx.txid && payment.metadata&.dig('usdt', 'verified_at').present?
          already_recorded = true
        elsif payment.response_code.present? ||
              Spree::Payment.where(response_code: tx.txid).where.not(id: payment.id).exists?
          Rails.logger.warn("[SpreeUsdt] tx #{tx.txid} already claimed; skipping payment #{payment.id}")
        else
          payment.update!(response_code: tx.txid, metadata: audit_metadata(payment, tx, payment_method))
          already_recorded = true
          claimed = true
        end
      end

      return false unless already_recorded

      Rails.logger.info("[SpreeUsdt] #{claimed ? 'matched' : 'retrying'} payment #{payment.id} with tx #{tx.txid}")
      result = Spree.payment_capture_workflow.call(payment: payment.reload)

      if result.failure?
        Rails.logger.error("[SpreeUsdt] capture failed for payment #{payment.id}: #{result.error.value}")
        false
      else
        SpreeUsdt::PaymentWindow.mark_order!(payment, SpreeUsdt::PaymentWindow::CONFIRMED)
        true
      end
    end

    def audit_metadata(payment, tx, payment_method)
      (payment.metadata || {}).deep_dup.merge(
        'usdt' => {
          'txid' => tx.txid,
          'network' => payment_method.effective_network,
          'wallet_address' => payment_method.effective_wallet_address,
          'amount' => tx.amount.to_s('F'),
          'from' => tx.from,
          'block_timestamp' => tx.timestamp.iso8601,
          'order_amount' => payment.amount.to_s('F'),
          'verified_at' => Time.current.iso8601,
          'source' => 'trongrid'
        }
      )
    end

    # Orders whose 15-minute window has closed are canceled through Spree's
    # own workflow (which restocks the fulfillments and voids the unpaid
    # authorization). The payment keeps an audit trail so the storefront can
    # explain what happened instead of showing a QR code forever.
    def expire_overdue_payments
      method_ids = Spree::PaymentMethod::Usdt.pluck(:id)
      return 0 if method_ids.empty?

      cutoff = SpreeUsdt::PaymentWindow::LENGTH.ago - SpreeUsdt::PaymentWindow::CHAIN_GRACE
      expired = 0

      Spree::Payment
        .where(payment_method_id: method_ids, status: DepositVerifier::WAITING_STATUSES)
        .where('created_at < ?', cutoff)
        .find_each do |payment|
          next unless SpreeUsdt::PaymentWindow.expired?(payment)

          order = SpreeUsdt::PaymentWindow.order_for(payment)

          if order && order.status != 'canceled' && order.allow_cancel?
            result = Spree.order_cancel_workflow.call(
              order: order,
              note: 'USDT payment window expired: no on-chain deposit within 15 minutes',
              notify_customer: false
            )
            unless result.success?
              Rails.logger.error("[SpreeUsdt] could not cancel order #{order.number} after timeout: #{result.error}")
            end
          end

          expires_at = SpreeUsdt::PaymentWindow.expires_at(payment)
          payment.with_lock do
            payment.reload
            metadata = (payment.metadata || {}).deep_dup
            metadata['usdt_expiry'] = {
              'expires_at' => expires_at.iso8601,
              'expired_at' => Time.current.iso8601,
              'window_minutes' => (SpreeUsdt::PaymentWindow::LENGTH / 60).to_i,
              'order_number' => order&.number
            }
            metadata['usdt'] = (metadata['usdt'] || {}).merge('payment_state' => SpreeUsdt::PaymentWindow::EXPIRED)
            changes = { metadata: metadata }
            changes[:status] = 'failed' if DepositVerifier::WAITING_STATUSES.include?(payment.status)
            payment.update!(changes)
          end

          SpreeUsdt::PaymentWindow.mark_order!(payment, SpreeUsdt::PaymentWindow::EXPIRED)
          SpreeUsdt::PaymentWindow.restore_cart!(payment)
          expired += 1
          Rails.logger.info("[SpreeUsdt] payment #{payment.id} (order #{order&.number}) expired after 15 minutes")
        end

      expired
    end

    # Money that arrived after the window closed must never be silently
    # matched to the canceled order. Record it on the payment so staff can
    # review and refund manually, and leave a loud warning in the logs.
    def record_late_deposits
      method_ids = Spree::PaymentMethod::Usdt.pluck(:id)
      return 0 if method_ids.empty?

      candidates = Spree::Payment
                     .where(payment_method_id: method_ids)
                     .where('created_at >= ?', SpreeUsdt::PaymentWindow::LATE_DEPOSIT_SCAN.ago)
                     .to_a
                     .select do |payment|
                       SpreeUsdt::PaymentWindow.marked_expired?(payment) &&
                         payment.metadata&.dig('usdt', 'late_deposit').blank?
                     end
      return 0 if candidates.empty?

      recorded = 0
      candidates.group_by(&:payment_method_id).each do |method_id, group|
        payment_method = Spree::PaymentMethod::Usdt.find(method_id)
        verifier = DepositVerifier.new(payment_method, since: SpreeUsdt::PaymentWindow::LATE_DEPOSIT_SCAN.ago)
        next unless verifier.auto_check_available?

        transactions = verifier.transactions
        group.each do |payment|
          expected = verifier.expected_amount_for(payment)
          next unless expected

          cutoff = SpreeUsdt::PaymentWindow.expires_at(payment)
          tx = transactions.find do |candidate|
            candidate.timestamp > cutoff &&
              (candidate.amount - expected).abs <= DepositVerifier::AMOUNT_TOLERANCE &&
              !Spree::Payment.where(response_code: candidate.txid).exists?
          end
          next unless tx

          payment.with_lock do
            payment.reload
            next if payment.metadata&.dig('usdt', 'late_deposit').present?

            metadata = (payment.metadata || {}).deep_dup
            metadata['usdt'] = (metadata['usdt'] || {}).merge(
              'late_deposit' => {
                'txid' => tx.txid,
                'amount' => tx.amount.to_s('F'),
                'from' => tx.from,
                'block_timestamp' => tx.timestamp.iso8601,
                'detected_at' => Time.current.iso8601,
                'requires_manual_refund' => true
              }
            )
            payment.update!(metadata: metadata)
          end
          recorded += 1
          Rails.logger.warn("[SpreeUsdt] LATE DEPOSIT #{tx.txid} for expired payment #{payment.id}; manual review/refund required")
        end
      rescue ChainError => e
        Rails.logger.warn("[SpreeUsdt] late-deposit scan skipped for method #{method_id}: #{e.message}")
      end

      recorded
    end
  end
end
