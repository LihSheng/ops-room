export class FixSupersededError extends Error {
  constructor(reviewedSha, currentSha) {
    super(`Fix task superseded: reviewed SHA ${reviewedSha} is not current SHA ${currentSha}`);
    this.name = 'FixSupersededError';
    this.reviewedSha = reviewedSha;
    this.currentSha = currentSha;
  }
}

export function assertFixHeadCurrent({ reviewedSha, currentSha }) {
  if (!reviewedSha || !currentSha || reviewedSha !== currentSha) {
    throw new FixSupersededError(reviewedSha, currentSha);
  }
}
