/** Covered by the fixture spec. */
function backoffMs(attempt) {
  return Math.min(1000 * 2 ** attempt, 30000);
}

/** Deliberately uncovered: the segment covergen is expected to find. */
function shouldRetry(status, attempt) {
  if (attempt >= 5) {
    return false;
  }
  if (status === 429) {
    return true;
  }
  return status >= 500 && status < 600;
}

module.exports = { backoffMs, shouldRetry };
