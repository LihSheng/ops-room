export function createProcessLifecycle() {
    let state = 'running';
    const operations = new Set();
    function track(promise, label = 'operation') {
        const tracked = Promise.resolve(promise);
        const record = { label, promise: tracked };
        operations.add(record);
        tracked.finally(() => operations.delete(record)).catch(() => { });
        return tracked;
    }
    function run(label, operation) {
        if (state !== 'running') {
            const error = new Error('Ops Room is draining and is not accepting new work');
            error.code = 'OPS_ROOM_DRAINING';
            return Promise.reject(error);
        }
        return track(Promise.resolve().then(operation), label);
    }
    function beginDrain() {
        if (state === 'running')
            state = 'draining';
        return getStatus();
    }
    function getStatus() {
        return {
            state,
            in_flight: operations.size,
            operations: [...operations].map((operation) => operation.label),
        };
    }
    async function waitForIdle(timeoutMs = 55_000) {
        const deadline = Date.now() + timeoutMs;
        while (operations.size > 0) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return { idle: false, timed_out: true, ...getStatus() };
            let timer;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve('timeout'), remaining);
            });
            const completed = Promise.allSettled([...operations].map((operation) => operation.promise))
                .then(() => 'completed');
            const result = await Promise.race([completed, timeout]);
            clearTimeout(timer);
            if (result === 'timeout') {
                return { idle: false, timed_out: true, ...getStatus() };
            }
        }
        return { idle: true, timed_out: false, ...getStatus() };
    }
    return {
        beginDrain,
        getStatus,
        isDraining: () => state !== 'running',
        run,
        track,
        waitForIdle,
    };
}
export function trackAcceptedOperation(lifecycle, label, operation) {
    return lifecycle.track(Promise.resolve().then(operation), label);
}
export const processLifecycle = createProcessLifecycle();
//# sourceMappingURL=process-lifecycle.js.map