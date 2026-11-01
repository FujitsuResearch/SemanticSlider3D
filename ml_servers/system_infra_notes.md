# System Infrastructure - Trellis Server

## 1. Persistent Multi-Process GPU Worker Pool (`GPUWorkerPool`)

Instead of spawning a new process and loading a ~15GB model every time a request comes in, we pre-spawn persistent worker processes at server startup (via `mp.get_context('spawn')`). Each worker loads its own full pipeline into VRAM once and then sits in a loop waiting for tasks via IPC queues.

Naive approaches would either (a) load/unload models per-request (huge latency), or (b) share a single pipeline behind a lock (sequential bottleneck). This design gives each worker its own CUDA context and pipeline, so multiple workers on the same GPU can interleave inference without Python's GIL blocking them — because they're separate OS processes, not threads.

`_pool_worker_loop` (slider_mapping.py:789) loads the pipeline once, then loops on `task_queue.get()`. `GPUWorkerPool.__init__` (slider_mapping.py:838) spawns `workers_per_gpu` processes per GPU (4 per GPU, since A100-80GB fits ~4x15GB pipelines).

## 2. Round-Robin Task Distribution

When a slider needs to generate multiple 3D variants (different slider values), the pool distributes them evenly across workers: value 0 goes to worker 0, value 1 to worker 1, etc., wrapping around.

This is a simple but effective load-balancing strategy that ensures no single worker gets overloaded. It avoids the overhead of a dynamic work-stealing scheduler while still achieving near-optimal utilization when tasks are roughly uniform in cost (which they are — each slider value produces one 3D asset).

`GPUWorkerPool.generate` (slider_mapping.py:904) — the `worker_chunks[wid] = slider_values[i % n_workers]` loop.

## 3. Two-Level Condition Caching

Before generating 3D variants, each worker must compute "conditions" from the input views and edited images. This is expensive. We cache at two levels:

- **Pool level** (`set_conds` in trellis_server.py:842): if the pool already has conditions for this asset, skip sending IPC messages entirely.
- **Worker level** (`_pool_worker_loop` slider_mapping.py:809): each worker independently checks if its cached `cond_key` matches — a safety net if pool-level state gets out of sync.

Without this, every slider request (including "add anchor point") would recompute conditions across all workers — redundant GPU work that would multiply latency by the number of workers.

## 4. Semaphore + Lock Pool Scheduling

We have multiple independent GPU pools (pool 0 on GPU 2, pool 1 on GPU 3). A `threading.Semaphore` limits concurrent slider jobs to the number of pools. Each pool has its own `threading.Lock`. When a request comes in, it acquires the semaphore (blocking if all pools are busy), then tries each pool's lock non-blockingly to find a free one.

This solves a real concurrency problem — each pool has mutable state (`set_conds` changes what the workers are conditioned on), so two slider jobs can't share a pool simultaneously. The semaphore provides backpressure (requests queue up instead of failing), while per-pool locks ensure mutual exclusion. This lets two users build sliders concurrently on different GPUs without interfering with each other.

`acquire_gpu_pool` / `release_gpu_pool` (trellis_server.py:68-88), `POOL_CONFIGS` (trellis_server.py:54-57).

## 5. Concurrent Image Editing via ThreadPoolExecutor

When editing the best views (step 3), we fan out all edit requests (both negative and positive prompts for each view) to a `ThreadPoolExecutor`, making them run in parallel.

Each edit calls an external API (`edit_image_gpt_image` — GPT image editing). These are I/O-bound, so threading is appropriate (no GIL issue for network waits). By running all edits concurrently rather than sequentially, wall-clock time drops from `N * 2 * latency` to roughly `1 * latency` (assuming the API can handle the concurrency).

`edit_best_views` (trellis_server.py:652-678).

## 6. Multi-Process Blender Rendering

`render_multiviews_blender_mp` renders 40 views of the 3D asset using Blender, parallelized across multiple worker processes (up to `MAX_WORKERS = 8`).

trellis_server.py:351, called from `render_multiviews`.

## 7. File-Based Locking for Session State

Multiple server components (trellis server + a separate app.py) can write to the same `session_state.json`. We use `fcntl.flock` (OS-level file locking) to ensure atomic read-modify-write.

Without this, concurrent writes from two processes would cause lost updates or corrupted JSON. This is a real distributed systems concern — coordinating between separate server processes on the same machine.

`save_trellis_object_to_session` (trellis_server.py:196-232).

## 8. WebSocket-Based Async Progress Streaming

Slider creation is a multi-minute, multi-step pipeline. Instead of blocking an HTTP request, we use Socket.IO to accept the job, dispatch to a background thread, and stream step-by-step progress events back to the client in real time.

`handle_create_slider` (trellis_server.py:692) captures the socket ID, launches `_create_slider_work` as a background task, which emits `slider_progress` / `slider_complete` / `slider_error` events back to that specific client.

---

**Strongest CV material:** Items 1, 4, and 3 together form a cohesive story about designing a multi-GPU serving system with process-level parallelism, pool-based scheduling, and caching to maximize throughput.
