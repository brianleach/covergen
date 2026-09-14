# frozen_string_literal: true

# The one thing a target repo has to opt into. covergen sets these env vars; the
# repo decides where the lcov goes. This is the plain-Ruby form of the snippet
# the rspec preflight prints (that one uses SimpleCov's "rails" profile).
if ENV["COVERAGE"]
  require "simplecov"

  if ENV["SIMPLECOV_LCOV"]
    require "simplecov-lcov"
    SimpleCov::Formatter::LcovFormatter.config do |c|
      c.report_with_single_file = true
      c.single_report_path = ENV.fetch("SIMPLECOV_LCOV_PATH", "coverage/lcov.info")
    end
    SimpleCov.formatter = SimpleCov::Formatter::LcovFormatter
  end

  SimpleCov.start do
    enable_coverage :line
    add_filter "/spec/"
  end
end

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
