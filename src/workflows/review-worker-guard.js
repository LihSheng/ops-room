export class ReviewCancelledError extends Error {
    constructor() {
        super('Review task cancellation was requested');
        this.name = 'ReviewCancelledError';
        this.code = 'REVIEW_CANCELLED';
    }
}
export function assertReviewNotCancelled(task) {
    if (task?.state === 'CANCEL_REQUESTED' || task?.state === 'CANCELLED')
        throw new ReviewCancelledError();
}
//# sourceMappingURL=review-worker-guard.js.map