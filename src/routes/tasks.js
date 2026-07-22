import { readTaskById, readTasksDir } from '../services/task-store.js';
export async function handleTasksList() {
    try {
        const tasks = await readTasksDir();
        return { tasks };
    }
    catch {
        return { tasks: [] };
    }
}
export async function handleTaskDetail(taskId) {
    const task = await readTaskById(taskId);
    return task ? { task } : null;
}
//# sourceMappingURL=tasks.js.map