# frozen_string_literal: true

require Rails.root.join('lib/usdt_exchange_rate').to_s unless defined?(UsdtExchangeRate)

# Public, read-only fiat -> USDT quote for the storefront checkout card.
#
# It is intentionally unauthenticated and stateless: it returns a public
# exchange rate for an amount the caller already knows, and never reads carts,
# orders or customers. The storefront calls it server-side through its own
# /api/usdt/quote route handler, so browsers never talk to Rails directly.
class UsdtQuotesController < ActionController::API
  AMOUNT_PATTERN = /\A\d{1,12}(?:\.\d{1,4})?\z/.freeze

  def show
    currency = params[:currency].to_s.strip.upcase
    raw_amount = params[:amount].to_s.strip

    unless AMOUNT_PATTERN.match?(raw_amount) && currency.match?(/\A[A-Z]{3}\z/)
      return render json: { error: 'amount and currency are required' }, status: :bad_request
    end

    quote = UsdtExchangeRate.quote(amount: BigDecimal(raw_amount), currency: currency)

    if quote.nil?
      return render json: { error: 'unsupported currency', currency: currency },
                    status: :unprocessable_entity
    end

    render json: quote
  end

  # Settlement details for the post-checkout ("order placed") USDT card.
  #
  # The checkout page only offers the payment method now; the wallet address,
  # QR code and the exact USDT amount are shown after the order exists, next to
  # its order number. Crucially the amount is the SAME rate snapshot that
  # SpreeUsdt::CheckDepositsJob freezes on the payment and DepositVerifier uses
  # to match an on-chain transfer. Freezing it here (on first view) means a
  # later ECB rate change can never leave a correctly paid order pending.
  #
  # Only payment-related data is returned: no customer, email or address.
  # `cart_id` is an unguessable prefixed id, the same one already in the
  # thank-you page URL. When the storefront still has the cart token it is
  # sent and checked.
  def order_payment
    cart_id = params[:cart_id].to_s.strip
    if cart_id.blank?
      return render json: { error: 'cart_id is required' }, status: :bad_request
    end

    cart = Spree::Cart.unscoped.find_by_prefix_id(cart_id)
    unless cart
      return render json: { error: 'order not found' }, status: :not_found
    end

    supplied_token = request.headers['x-spree-token'].to_s.strip
    if supplied_token.present? && supplied_token != cart.token.to_s
      return render json: { error: 'invalid cart token' }, status: :forbidden
    end

    order = Spree::Order.find_by(cart_id: cart.id)
    method_ids = Spree::PaymentMethod::Usdt.pluck(:id)
    payment = Spree::Payment
                .where(payment_method_id: method_ids)
                .where('cart_id = :cid OR order_id = :oid', cid: cart.id, oid: order&.id)
                .order(:created_at)
                .last

    unless payment
      return render json: { error: 'no USDT payment for this order' }, status: :not_found
    end

    quote = locked_quote_for(payment)
    unless quote
      return render json: { error: 'exchange rate unavailable', currency: currency_for(payment) },
                    status: :service_unavailable
    end

    payment_method = payment.payment_method
    window = SpreeUsdt::PaymentWindow

    # Only a live, still-awaiting payment may (re)label its order. A read of
    # an expired/canceled order must not flip the admin badge back to
    # "awaiting" after the timeout sweep already settled it.
    if window.state_for(payment) == SpreeUsdt::PaymentWindow::AWAITING
      SpreeUsdt::PaymentWindow.mark_order!(payment, SpreeUsdt::PaymentWindow::AWAITING)
    end

    render json: {
      order_number: order&.number.presence || cart.number,
      currency: currency_for(payment),
      amount: format('%.2f', payment.amount.to_d),
      amount_usdt: quote['amount_usdt'],
      rate: quote['rate'],
      rate_date: quote['rate_date'],
      source: quote['source'],
      stale: quote['stale'],
      wallet_address: payment_method.effective_wallet_address,
      network: payment_method.effective_network.to_s.upcase.presence || 'TRC20',
      notes: payment_method.effective_notes,
      payment_status: payment.status,
      confirmed: payment.status == 'completed',
      txid: payment.response_code,
      # Absolute deadline, so refreshing the page can never extend the window.
      expires_at: window.expires_at(payment).iso8601,
      remaining_seconds: window.remaining_seconds(payment),
      payment_window_minutes: (SpreeUsdt::PaymentWindow::LENGTH / 60).to_i,
      expired: [SpreeUsdt::PaymentWindow::EXPIRED,
                SpreeUsdt::PaymentWindow::CANCELED].include?(window.state_for(payment)),
      payment_state: window.state_for(payment),
      order_canceled: order&.status == 'canceled',
      late_deposit: payment.metadata&.dig('usdt', 'late_deposit')
    }
  end

  # "I have paid" — enqueue an immediate sweep instead of making the shopper
  # wait for the next scheduled minute. The job is idempotent and the card
  # polls faster while this check is in flight.
  def check_payment
    payment = find_usdt_payment
    return unless payment

    if payment.status == 'completed'
      return render json: { queued: false, confirmed: true }
    end

    SpreeUsdt::CheckDepositsJob.perform_later
    render json: { queued: true, confirmed: false }
  end

  # "Cancel payment" / expired order returning to the basket. Cancels the
  # unpaid order through Spree's workflow, restores the completed cart and
  # hands back its credentials so the storefront can re-point its cookies.
  def cancel_payment
    payment = find_usdt_payment
    return unless payment

    if payment.status == 'completed'
      return render json: { error: 'payment already confirmed' }, status: :conflict
    end

    order = SpreeUsdt::PaymentWindow.order_for(payment)
    if order && order.status != 'canceled' && order.allow_cancel?
      result = Spree.order_cancel_workflow.call(
        order: order,
        note: 'USDT payment canceled before an on-chain deposit was confirmed',
        notify_customer: false
      )
      unless result.success?
        Rails.logger.warn("[SpreeUsdt] cancel_payment could not cancel #{order.number}: #{result.error}")
      end
    end

    payment.with_lock do
      payment.reload
      metadata = (payment.metadata || {}).deep_dup
      metadata['usdt'] = (metadata['usdt'] || {}).merge(
        'payment_state' => SpreeUsdt::PaymentWindow::CANCELED,
        'canceled_at' => Time.current.iso8601,
        'canceled_by' => 'shopper'
      )
      changes = { metadata: metadata }
      changes[:status] = 'void' if SpreeUsdt::DepositVerifier::WAITING_STATUSES.include?(payment.status)
      payment.update!(changes)
    end

    SpreeUsdt::PaymentWindow.mark_order!(payment, SpreeUsdt::PaymentWindow::CANCELED)
    cart = SpreeUsdt::PaymentWindow.restore_cart!(payment)

    render json: {
      canceled: true,
      order_number: order&.number,
      payment_state: SpreeUsdt::PaymentWindow::CANCELED,
      cart_id: cart&.prefixed_id,
      cart_token: cart&.token,
      restored_items: cart ? Spree::LineItem.where(cart_id: cart.id).count : 0
    }
  end

  private

  # Shared lookup for the two POST actions. cart_id is the unguessable
  # prefixed id already present in the settlement page URL.
  def find_usdt_payment
    cart_id = params[:cart_id].to_s.strip
    if cart_id.blank?
      render json: { error: 'cart_id is required' }, status: :bad_request
      return nil
    end

    cart = Spree::Cart.unscoped.find_by_prefix_id(cart_id)
    unless cart
      render json: { error: 'order not found' }, status: :not_found
      return nil
    end

    supplied_token = request.headers['x-spree-token'].to_s.strip
    if supplied_token.present? && supplied_token != cart.token.to_s
      render json: { error: 'invalid cart token' }, status: :forbidden
      return nil
    end

    order = Spree::Order.find_by(cart_id: cart.id)
    method_ids = Spree::PaymentMethod::Usdt.pluck(:id)
    payment = Spree::Payment
                .where(payment_method_id: method_ids)
                .where('cart_id = :cid OR order_id = :oid', cid: cart.id, oid: order&.id)
                .order(:created_at)
                .last

    unless payment
      render json: { error: 'no USDT payment for this order' }, status: :not_found
      return nil
    end

    payment
  end

  def currency_for(payment)
    payment.owner&.currency.presence || 'USD'
  end

  # Mirrors SpreeUsdt::CheckDepositsJob#ensure_quote!: read the frozen quote
  # if the sweep already stored one, otherwise compute and store it now. The
  # sweep then reuses this exact snapshot instead of recalculating.
  def locked_quote_for(payment)
    existing = payment.metadata&.dig('usdt_quote')
    return existing if existing && existing['amount_usdt'].present?

    quote = UsdtExchangeRate.quote(amount: payment.amount.to_d, currency: currency_for(payment))
    return nil unless quote

    payment.with_lock do
      payment.reload
      locked = payment.metadata&.dig('usdt_quote')
      next locked if locked && locked['amount_usdt'].present?

      payment.update!(
        metadata: (payment.metadata || {}).deep_dup.merge(
          'usdt_quote' => quote.merge('locked_at' => Time.current.iso8601)
        )
      )
    end

    payment.metadata&.dig('usdt_quote')
  end
end
