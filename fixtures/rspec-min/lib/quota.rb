# frozen_string_literal: true

class Quota
  def initialize(limit)
    @limit = limit
  end

  # Covered by the fixture spec.
  def remaining(used)
    [@limit - used, 0].max
  end

  # Deliberately uncovered: the segment covergen is expected to find.
  def tier
    return :none if @limit.zero?
    return :small if @limit < 100

    :large
  end
end
