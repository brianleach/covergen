# frozen_string_literal: true

require "quota"

RSpec.describe Quota do
  describe "#remaining" do
    it "never goes below zero" do
      expect(described_class.new(10).remaining(25)).to eq(0)
    end
  end
end
