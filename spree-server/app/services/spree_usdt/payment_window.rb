# frozen_string_literal: true

module SpreeUsdt
  # The single source of truth for the USDT payment window.
  #
  # A shopper has LENGTH after placing an order to send the exact USDT
  # amount. DepositVerifier refuses to auto-match anything stamped after the
  # window, CheckDepositsJob cancels unpaid orders once it closes, and the
  # storefront settlement card counts down using #expires_at.
  module PaymentWindow
    LENGTH = 15.minutes
    # TRON block timestamps can lag the moment the transfer was broadcast by
    # a few seconds. This slack applies to on-chain matching only — the
    # countdown shown to the shopper always ends at #expires_at.
    CHAIN_GRACE = 60.seconds
    LATE_DEPOSIT_SCAN = 24.hours

    AWAITING = 'awaiting_chain_payment'
    CONFIRMED = 'confirmed'
    EXPIRED = 'expired'
    CANCELED = 'canceled'

    module_function

    def expires_at(payment)
      payment.created_at.utc + LENGTH
    end

    def closed_at(payment)
      expires_at(payment) + CHAIN_GRACE
    end

    def remaining_seconds(payment, now: Time.current)
      [(expires_at(payment) - now.utc).ceil, 0].max
    end

    def expired?(payment, now: Time.current)
      closed_at(payment) <= now.utc
    end

    def marked_expired?(payment)
      payment.metadata&.dig('usdt_expiry', 'expired_at').present?
    end

    def state_for(payment)
      return CONFIRMED if payment.status == 'completed'
      return CANCELED if canceled?(payment)
      return EXPIRED if marked_expired?(payment) || expired?(payment)

      AWAITING
    end

    def canceled?(payment)
      payment.metadata&.dig('usdt', 'canceled_at').present?
    end

    # In Spree 6 the payment belongs to the ORDER (payment.order_id); the
    # cart_id column is usually NULL. Matching on a NULL cart_id would find
    # the oldest cart-less order and cancel the wrong one, so order_id wins.
    def order_for(payment)
      return nil if payment.nil?
      return Spree::Order.find_by(id: payment.order_id) if payment.order_id.present?
      return nil if payment.cart_id.blank?

      Spree::Order.where(cart_id: payment.cart_id).order(:id).last
    end

    def cart_for(payment)
      return Spree::Cart.unscoped.find_by(id: payment.cart_id) if payment.cart_id.present?

      order = order_for(payment)
      return nil if order&.cart_id.blank?

      Spree::Cart.unscoped.find_by(id: order.cart_id)
    end

    # Spree 6 keeps the line items attached to the cart after completion, so
    # clearing the completion stamps is enough to put the basket back in the
    # shopper's hands (no re-adding items, no new cart id to lose).
    def restore_cart!(payment)
      cart = cart_for(payment)
      return nil unless cart

      if cart.completed_at.present? || cart.completing_at.present?
        # Completed carts come back as readonly AR objects; update_all works
        # on the relation and bypasses the instance flag without skipping SQL.
        Spree::Cart.unscoped
                   .where(id: cart.id)
                   .update_all(completed_at: nil, completing_at: nil)
      end
      cart
    end

    # The admin dashboard reads this flag to tell "placed but unpaid" orders
    # apart from orders the chain has actually settled. No-op when unchanged,
    # so the once-a-minute sweep does not rewrite the row every time.
    def mark_order!(payment, state)
      order = order_for(payment)
      return unless order

      metadata = (order.metadata || {}).deep_dup
      return if metadata['usdt_payment_state'] == state

      metadata['usdt_payment_state'] = state
      metadata['usdt_payment_state_at'] = Time.current.iso8601
      order.update_columns(metadata: metadata)
    end
  end
end
