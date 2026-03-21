import type {
  CognitionConcurrencyBucket,
  CognitionPacket,
  CompileTask,
} from "./packets";

type WorkbenchCacheEntry = {
  packet: CognitionPacket<unknown>;
  expiresAt: number;
};

type ScheduledWork = () => void;

type CognitionSchedulerLimits = Record<CognitionConcurrencyBucket, number>;

const DEFAULT_SCHEDULER_LIMITS: CognitionSchedulerLimits = {
  deterministic: 8,
  "tier1-local": 1,
  "tier1-cloud": 2,
};

class CognitionScheduler {
  private readonly activeCounts = new Map<CognitionConcurrencyBucket, number>();
  private readonly queues = new Map<CognitionConcurrencyBucket, ScheduledWork[]>();

  constructor(private readonly limits: CognitionSchedulerLimits) {
    for (const bucket of Object.keys(limits) as CognitionConcurrencyBucket[]) {
      this.activeCounts.set(bucket, 0);
      this.queues.set(bucket, []);
    }
  }

  schedule<T>(
    bucket: CognitionConcurrencyBucket,
    work: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.activeCounts.set(bucket, (this.activeCounts.get(bucket) ?? 0) + 1);

        void work()
          .then(resolve, reject)
          .finally(() => {
            this.activeCounts.set(bucket, Math.max((this.activeCounts.get(bucket) ?? 1) - 1, 0));
            this.drain(bucket);
          });
      };

      if ((this.activeCounts.get(bucket) ?? 0) < this.limits[bucket]) {
        start();
        return;
      }

      this.queues.get(bucket)?.push(start);
    });
  }

  private drain(bucket: CognitionConcurrencyBucket): void {
    const queue = this.queues.get(bucket);

    if (!queue || queue.length === 0) {
      return;
    }

    if ((this.activeCounts.get(bucket) ?? 0) >= this.limits[bucket]) {
      return;
    }

    const next = queue.shift();
    next?.();
  }
}

export type CognitionWorkbenchOptions = {
  schedulerLimits?: Partial<CognitionSchedulerLimits>;
};

export class CognitionWorkbench {
  private readonly taskRegistry = new Map<string, CompileTask<unknown, unknown>>();
  private readonly cache = new Map<string, WorkbenchCacheEntry>();
  private readonly inFlight = new Map<string, Promise<CognitionPacket<unknown> | null>>();
  private readonly scheduler: CognitionScheduler;

  constructor(
    tasks: Array<CompileTask<unknown, unknown>>,
    options?: CognitionWorkbenchOptions,
  ) {
    this.scheduler = new CognitionScheduler({
      ...DEFAULT_SCHEDULER_LIMITS,
      ...(options?.schedulerLimits ?? {}),
    });

    for (const task of tasks) {
      this.registerTask(task);
    }
  }

  registerTask<Input, Data>(task: CompileTask<Input, Data>): void {
    this.taskRegistry.set(task.id, task as CompileTask<unknown, unknown>);
  }

  getTaskIds(): string[] {
    return [...this.taskRegistry.keys()];
  }

  async runTask<Input, Data>(
    task: CompileTask<Input, Data>,
    input: Input,
  ): Promise<CognitionPacket<Data> | null> {
    if (!task.shouldRun(input)) {
      return null;
    }

    const fingerprint = task.fingerprint(input);
    const cacheKey = `${task.id}:${fingerprint}`;
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.packet as CognitionPacket<Data>;
    }

    const existing = this.inFlight.get(cacheKey);

    if (existing) {
      return existing as Promise<CognitionPacket<Data> | null>;
    }

    const promise = this.scheduler.schedule(task.classify(input), async () => {
      const freshCache = this.cache.get(cacheKey);

      if (freshCache && freshCache.expiresAt > Date.now()) {
        return freshCache.packet as CognitionPacket<Data>;
      }

      const data = await task.run(input);

      if (data == null) {
        return null;
      }

      const packet: CognitionPacket<Data> = {
        taskId: task.id,
        kind: task.kind,
        fingerprint,
        compiledAt: new Date().toISOString(),
        data,
      };

      this.cache.set(cacheKey, {
        packet,
        expiresAt: Date.now() + task.freshnessMs,
      });

      return packet;
    }).finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise as Promise<CognitionPacket<unknown> | null>);

    return promise;
  }

  async runBatch<Input, Data>(
    task: CompileTask<Input, Data>,
    inputs: Input[],
  ): Promise<Array<CognitionPacket<Data> | null>> {
    return Promise.all(inputs.map((input) => this.runTask(task, input)));
  }
}
