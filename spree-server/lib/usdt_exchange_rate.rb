# frozen_string_literal: true

require 'net/http'
require 'json'
require 'uri'

# Single source of truth for converting a store's local currency into USDT.
#
# USDT is a USD stablecoin, so the conversion uses the ECB daily reference
# rates published by Frankfurter (USD base) and an optional USDT-per-USD
# factor (USDT_PER_USD, defaults to 1). The very same #convert result feeds
# both the storefront quote endpoint and SpreeUsdt::DepositVerifier, so the
# amount the shopper is told to send is exactly the amount the automatic sweep
# waits for. Amounts are rounded to 2 decimals because that is what a customer
# can actually type into a wallet.
#
# ECB publishes once per business day, so a short in-process cache keeps
# outbound requests rare. If the provider is unreachable we fall back to the
# last successful snapshot, then to a bundled copy of the rates, and mark the
# quote as stale. We never invent a rate for an unknown currency: the checkout
# then hides the amount instead of risking an under/over payment.
class UsdtExchangeRate
  SOURCE_URL = 'https://api.frankfurter.dev/v1/latest?base=USD'
  CACHE_KEY = 'usdt_exchange_rate/snapshot'
  BACKUP_KEY = 'usdt_exchange_rate/last_good'
  CACHE_TTL = 1.hour
  OPEN_TIMEOUT = 3
  READ_TIMEOUT = 6
  CURRENCY_PATTERN = /\A[A-Z]{3}\z/.freeze

  # Bundled ECB snapshot (2026-11-13), used only when the provider is down
  # and no earlier successful fetch is available in this process.
  FALLBACK_DATE = '2026-11-13'
  FALLBACK_RATES = {
    'AUD' => '1.4738', 'BRL' => '5.6637', 'CAD' => '1.4258', 'CHF' => '0.8384',
    'CNY' => '6.6719', 'CZK' => '22.099', 'DKK' => '6.764', 'EUR' => '0.90481',
    'GBP' => '0.75605', 'HKD' => '7.846', 'HUF' => '330.8', 'IDR' => '18245',
    'ILS' => '3.2107', 'INR' => '94.25', 'ISK' => '123.6', 'JPY' => '160.0',
    'KRW' => '1337.13', 'MXN' => '18.593', 'MYR' => '4.0875', 'NOK' => '9.5634',
    'NZD' => '1.8076', 'PHP' => '63.813', 'PLN' => '3.9914', 'RON' => '4.8402',
    'SEK' => '10.0502', 'SGD' => '1.2881', 'THB' => '33.915', 'TRY' => '50.368',
    'USD' => '1.0', 'ZAR' => '16.9635'
  }.freeze

  class << self
    # @return [Hash, nil] a JSON-ready quote, or nil when the currency has no rate
    def quote(amount:, currency:)
      code = normalize(currency)
      decimal = decimal(amount)
      rate = rate_for(code)
      return nil if rate.nil? || decimal.nil?

      snap = snapshot
      {
        'currency' => code,
        'amount' => decimal.to_s('F'),
        'amount_usdt' => convert(decimal, code).to_s('F'),
        'rate' => rate.round(8).to_s('F'),
        'usdt_per_usd' => usdt_per_usd.to_s('F'),
        'rate_date' => snap[:date].to_s,
        'source' => snap[:source].to_s,
        'stale' => !!snap[:stale],
        'quoted_at' => Time.current.iso8601
      }
    end

    # @return [BigDecimal, nil] fiat amount converted to a payable USDT amount
    def convert(amount, currency)
      rate = rate_for(currency)
      decimal = decimal(amount)
      return nil if rate.nil? || decimal.nil?

      (decimal * rate).round(2, BigDecimal::ROUND_HALF_UP)
    end

    # @return [BigDecimal, nil] how many USDT one unit of `currency` buys
    def rate_for(currency)
      code = normalize(currency)
      return usdt_per_usd if code == 'USD'

      per_usd = rates[code]
      return nil if per_usd.nil? || per_usd <= 0

      usdt_per_usd / per_usd
    end

    def rates
      snapshot[:rates] || {}
    end

    def snapshot
      cached = Rails.cache.read(CACHE_KEY)
      return cached if valid_snapshot?(cached)

      fetched = fetch_remote
      Rails.cache.write(CACHE_KEY, fetched, expires_in: CACHE_TTL)
      Rails.cache.write(BACKUP_KEY, fetched)
      fetched
    rescue StandardError => e
      Rails.logger.warn("[SpreeUsdt] FX provider unavailable (#{e.class}: #{e.message}); using fallback rates")
      backup = Rails.cache.read(BACKUP_KEY)
      return backup.merge(stale: true) if valid_snapshot?(backup)

      {
        rates: FALLBACK_RATES.transform_values { |value| BigDecimal(value) },
        date: FALLBACK_DATE,
        stale: true,
        source: 'bundled ECB snapshot'
      }
    end

    private

    def fetch_remote
      uri = URI(SOURCE_URL)
      response = Net::HTTP.start(
        uri.host, uri.port, use_ssl: true,
        open_timeout: OPEN_TIMEOUT, read_timeout: READ_TIMEOUT
      ) { |http| http.get(uri.request_uri) }

      raise "FX provider returned HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)

      payload = JSON.parse(response.body)
      rows = payload['rates']
      raise 'FX payload has no rates' if rows.blank?

      parsed = {}
      rows.each do |code, value|
        next unless code.to_s.match?(CURRENCY_PATTERN)

        begin
          amount = BigDecimal(value.to_s)
          parsed[code.to_s.upcase] = amount if amount.positive?
        rescue ArgumentError, TypeError
          next
        end
      end
      raise 'FX payload has no usable rates' if parsed.empty?

      { rates: parsed, date: payload['date'].to_s, stale: false, source: 'Frankfurter (ECB)' }
    end

    def usdt_per_usd
      value = BigDecimal(ENV.fetch('USDT_PER_USD', '1'))
      value.positive? ? value : BigDecimal('1')
    rescue ArgumentError, TypeError
      BigDecimal('1')
    end

    def decimal(value)
      BigDecimal(value.to_s)
    rescue ArgumentError, TypeError
      nil
    end

    def normalize(currency)
      code = currency.to_s.strip.upcase
      CURRENCY_PATTERN.match?(code) ? code : ''
    end

    def valid_snapshot?(value)
      value.is_a?(Hash) && value[:rates].is_a?(Hash) && value[:rates].present?
    end
  end
end
