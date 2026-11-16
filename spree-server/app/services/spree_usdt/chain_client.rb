# frozen_string_literal: true

require 'net/http'
require 'json'

module SpreeUsdt
  class ChainError < StandardError; end

  # Read-only view of confirmed, incoming TRC20-USDT transfers for a TRON
  # wallet, using TronGrid's public account endpoint. No private key is ever
  # held or needed: verifying deposits is a read operation.
  #
  # Set TRONGRID_API_KEY in the environment to raise the public rate limit.
  class ChainClient
    BASE_URL = 'https://api.trongrid.io'
    USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' # USDT on TRON mainnet
    PAGE_SIZE = 200
    MAX_PAGES = 5 # hard ceiling: never walk an entire exchange hot wallet
    OPEN_TIMEOUT = 5
    READ_TIMEOUT = 12

    Transaction = Struct.new(:txid, :amount, :timestamp, :from, :to, keyword_init: true)

    attr_reader :address

    def initialize(address, api_key: ENV['TRONGRID_API_KEY'])
      @address = address.to_s.strip
      @api_key = api_key
    end

    # @param since [Time] ignore anything older than this (UTC epoch millis)
    # @return [Array<Transaction>] ascending by block timestamp, de-duplicated
    def incoming_transactions(since:, upto: Time.current)
      raise ChainError, 'USDT wallet address is blank' if address.blank?

      found = {}
      fingerprint = nil

      MAX_PAGES.times do
        payload = fetch_page(since: since, upto: upto, fingerprint: fingerprint)
        raise ChainError, "TronGrid rejected the request: #{payload['error']}" unless payload['success']

        rows = Array(payload['data'])
        rows.each do |row|
          tx = normalize(row)
          found[tx.txid] = tx if tx
        end

        fingerprint = payload.dig('meta', 'fingerprint')
        break if fingerprint.blank? || rows.size < PAGE_SIZE
      end

      found.values.sort_by(&:timestamp)
    end

    private

    def normalize(row)
      return unless row['type'].to_s == 'Transfer'
      return unless row['to'].to_s == address
      return unless row.dig('token_info', 'address').to_s == USDT_CONTRACT
      return unless row.dig('token_info', 'symbol').to_s == 'USDT'
      return if row['transaction_id'].blank? || row['value'].blank?

      decimals = (row.dig('token_info', 'decimals') || 6).to_i
      amount = BigDecimal(row['value'].to_s) / (10**decimals)
      timestamp = Time.at(row['block_timestamp'].to_i / 1000.0).utc

      Transaction.new(
        txid: row['transaction_id'],
        amount: amount,
        timestamp: timestamp,
        from: row['from'],
        to: row['to']
      )
    rescue ArgumentError, TypeError, ZeroDivisionError => e
      Rails.logger.warn("[SpreeUsdt] ignored malformed chain row: #{e.message}")
      nil
    end

    def fetch_page(since:, upto:, fingerprint:)
      params = {
        'only_confirmed' => 'true',
        'only_to' => 'true',
        'limit' => PAGE_SIZE.to_s,
        'contract_address' => USDT_CONTRACT,
        'min_timestamp' => (since.to_f * 1000).floor.to_s,
        'max_timestamp' => (upto.to_f * 1000).ceil.to_s
      }
      params['fingerprint'] = fingerprint if fingerprint.present?

      uri = URI("#{BASE_URL}/v1/accounts/#{address}/transactions/trc20")
      uri.query = URI.encode_www_form(params)

      request = Net::HTTP::Get.new(uri)
      request['Accept'] = 'application/json'
      request['TRON-PRO-API-KEY'] = @api_key if @api_key.present?

      response = Net::HTTP.start(
        uri.hostname, uri.port, use_ssl: true,
        open_timeout: OPEN_TIMEOUT, read_timeout: READ_TIMEOUT
      ) { |http| http.request(request) }

      raise ChainError, "TronGrid HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)

      JSON.parse(response.body)
    rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, IOError, Errno::ECONNRESET,
           Errno::ECONNREFUSED, Errno::EHOSTUNREACH, OpenSSL::SSL::SSLError => e
      raise ChainError, "TronGrid unavailable: #{e.class}: #{e.message}"
    rescue JSON::ParserError => e
      raise ChainError, "TronGrid returned invalid JSON: #{e.message}"
    end
  end
end
