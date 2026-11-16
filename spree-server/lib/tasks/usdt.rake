# frozen_string_literal: true

namespace :usdt do
  desc 'Check TRC20-USDT deposits now and complete any payment whose funds arrived'
  task check_deposits: :environment do
    result = SpreeUsdt::CheckDepositsJob.perform_now(false)
    puts "[usdt] waiting=#{result[:checked]} confirmed=#{result[:confirmed]} failed=#{result[:failed]}"
  end

  desc 'Start (or resume) the automatic once-a-minute deposit check, without restarting Puma'
  task start_auto_check: :environment do
    outcome = SpreeUsdt::CheckDepositsJob.start!
    case outcome
    when :started
      puts '[usdt] self-scheduling chain started; first check in ~1 minute'
    when :already_running
      puts '[usdt] a deposit check is already scheduled — nothing to do'
    when :recurring
      puts '[usdt] the Solid Queue recurring task is active — no chain needed'
    end
  end

  desc 'Show the current USDT wallet wiring, scheduler state and last on-chain activity'
  task status: :environment do
    job = SpreeUsdt::CheckDepositsJob
    puts "scheduler: #{job.handed_over_to_recurring? ? 'Solid Queue recurring task' : (job.running? ? 'self-scheduling job chain' : 'NOT RUNNING')}"

    Spree::PaymentMethod::Usdt.find_each do |pm|
      puts "payment method ##{pm.id}: #{pm.name}"
      puts "  wallet:  #{pm.effective_wallet_address.inspect}"
      puts "  network: #{pm.effective_network.inspect} / auto-check: #{SpreeUsdt::DepositVerifier.new(pm).auto_check_available?}"
      puts "  active:  #{pm.active?} / storefront_visible: #{pm.storefront_visible?}"
      puts "  description: #{pm.description.inspect}"
      next unless pm.effective_wallet_address.present?

      txs = SpreeUsdt::ChainClient.new(pm.effective_wallet_address).incoming_transactions(since: 7.days.ago)
      puts "  confirmed USDT transfers in last 7d: #{txs.size}"
      txs.last(3).each { |tx| puts "    #{tx.timestamp.iso8601} #{tx.amount.to_s('F')} USDT #{tx.txid}" }
    end
  end
end
