# ss3d_utils

Utility modules consumed by `ml_servers/trellis_server.py`. This README documents **only** the names that the server actually imports or calls — other helpers in these files exist for offline experiments and are not part of the server's runtime path.

`ml_servers/trellis_server.py` adds this directory to `sys.path` (`sys.path.insert(0, SS3D_UTILS_ROOT)`, resolved in `ml_servers/config.py`; defaults to `<repo>/ss3d_utils`) and then imports from each module by name.

This directory sits at the repo root, **not** inside the vendored `TRELLIS/` clone — it is SemanticSlider3D's own code. Modules here still reach into TRELLIS for the `trellis.*` package and the Blender render script; those paths are resolved centrally in [`_paths.py`](_paths.py) rather than by walking up from `__file__`.

The cross-references below use line numbers in `ml_servers/trellis_server.py`.

---

## `render_multiviews_blender_mp.py`

Multiprocess Blender renderer. Spawns Blender subprocesses (one per chunk of views), each pinned to a GPU via round-robin assignment, then merges their outputs into a single transforms.json + per-view PNGs.

### `get_multi_view_from_3d_assets_mp(asset_path, num_views, out_dir, max_workers=None, random_seed=None, eval_mode=False, fix_vertex_colors=False) -> bool`

Renders `num_views` images of a 3D asset (GLB / OBJ / etc.) into `out_dir`. Camera poses come from a Hammersley sphere sequence (or a uniform sweep when `eval_mode=True`). The function shells out to Blender once per worker chunk, so it depends on a working `blender` binary on `PATH`. Returns `True` on success, `False` if any subprocess fails.

- **Called at** `trellis_server.py:353` inside `render_multiviews(glb_path)` to produce the reference view set used by the slider build.
- **Side effects:** spawns Blender subprocesses; writes PNGs and a merged `transforms.json` under `out_dir`.

---

## `text_gen_utils.py`

Wraps the OpenAI Chat / Image APIs. Loads `OPENAI_API_KEY` (and `GEMINI_API_KEY_OLD`) from environment via `dotenv` and constructs a module-level `OpenAI` client (`_client`) at import time, so callers never pass a client. The model identifiers `gpt-5.2` and `gpt-image-1.5` are hard-coded.

> The three functions below are explicitly marked in source as duplicates of the same names in `val_editing.py`. `trellis_server.py` imports the `**text_gen_utils.py**` versions — those take no `client` argument because the singleton `_client` is used internally.

### `direction_generator_edit(basic_object: str, basic_attribute: str) -> List[str]`

Given an object name (e.g. `"a human face"`) and an attribute (e.g. `"very happy"`), generates a `[negative_prompt, positive_prompt]` editing pair via a single `chat.completions.create` call against `gpt-5.2`, with a JSON-schema response format that constrains the output to a 2-element string array. The system prompt enforces brevity (<20 words), sentiment-independent direction (positive = more of the attribute), and NSFW guardrails.

- **Called at** `trellis_server.py:776` to derive the `(neg_prompt, pos_prompt)` pair that drives the slider build.
- **Side effects:** one OpenAI Chat API call. Asserts the returned list has exactly 2 elements.

### `editing_prompt_view_filtering(editing_prompt: str, image_path: str) -> bool`

Asks `gpt-5.2` (vision) whether the region targeted by `editing_prompt` is clearly visible in the rendered view at `image_path`. The image is sent inline as a base64 data URL. Response is constrained to `{"result": bool}` via JSON schema.

- **Called at** `trellis_server.py:647` inside `filter_best_views(...)` to verify each ranked view before it gets sent to image editing.
- **Side effects:** one OpenAI Chat (vision) API call per invocation.

### `edit_image_gpt_image(input_image_path: str, edit_prompt: str) -> PIL.Image.Image`

Calls `_client.images.edit(model="gpt-image-1.5", ...)` with the input PNG and the prompt, decodes the base64-encoded result, and returns a PIL `Image`. The caller is responsible for saving it.

- **Called at** `trellis_server.py:677` inside `edit_best_views(...)` to produce the negative/positive edited views that condition the slider build. The server runs many of these in a `ThreadPoolExecutor`, so multiple concurrent OpenAI API calls happen during a single slider build.
- **Side effects:** one OpenAI Images API call per invocation.

---

## `val_editing.py`

ImageReward-based view scoring. Imports `ImageReward as RM`. Module-level `load_dotenv()` runs at import; no module-level singletons.

### `get_ImageReward_model(device="cuda:1") -> RM.Scorer`

Calls `RM.load("ImageReward-v1.0", device=device)` and returns the resulting scorer. Note the **default device is `"cuda:1"**` — `trellis_server.py:1036` calls it with no argument, so the ImageReward model lands on `cuda:1` regardless of `args.gpu`. If you change the pipeline GPU layout, double-check this default doesn't collide.

- **Called at** `trellis_server.py:1036` once at server startup; the result is stored in the module-level `rm_model` global and reused for every slider build.

### `select_best_views_by_ImageReward(model, prompt: str, view_image_dir: str) -> List[Tuple[str, float]]`

Scores every PNG under `view_image_dir` against `prompt` using the supplied ImageReward `model` and returns `[(image_path, score), ...]` sorted by filename (the caller is responsible for re-sorting by score if needed).

- **Called at** `trellis_server.py:812` to rank the rendered views by alignment with the positive editing prompt; the top-N then get verified by `editing_prompt_view_filtering` and edited by `edit_image_gpt_image`.

---

## `slider_mapping.py`

The slider-build core: maintains a persistent multi-GPU worker pool, samples LPIPS-vs-slider-value curves, and resolves "give me a slider value at LPIPS percentage X" queries.

### `class GPUWorkerPool(gpu_ids: List[int], workers_per_gpu: int = 1)`

Spawns `len(gpu_ids) * workers_per_gpu` long-lived worker processes (mp `spawn` context). Each worker loads its own TRELLIS pipeline pinned to its assigned GPU, so pool-level work is GIL-free and per-worker GPU contention is avoided. Each worker uses ~15 GB VRAM (the docstring notes A100-80GB can hold up to 4–5).

The constructor blocks until every worker reports `ready`, then installs a `SIGINT` handler that calls `shutdown()` and re-raises so Ctrl+C in the parent kills all workers cleanly.

**Public surface used by `trellis_server.py`:**


| Member                                                                                 | Used by                                                                                                                                                                                                              | Purpose                                                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `__init__(gpu_ids, workers_per_gpu)`                                                   | `trellis_server.py:1041`                                                                                                                                                                                             | One pool per entry in `TRELLIS_POOL_CONFIGS`.                                |
| `gpu_ids` (attr)                                                                       | indirect — the pool object is passed straight through to `get_lpips_curve_gradient_based` / `get_slider_value_from_lpips_percentage`, both of which read `pool.gpu_ids` to know which GPUs to use for LPIPS scoring. | —                                                                            |
| `set_conds(view_images_dir, edited_images_dir)`                                        | called internally by the two `slider_mapping` entrypoints below; pool-level cache skips the broadcast when the dirs match the previous call.                                                                         | Push the conditioning view directories to every worker.                      |
| `generate(view_images_dir, edited_images_dir, slider_values, out_dir, need_glb=False)` | called internally by the two entrypoints.                                                                                                                                                                            | Distribute slider values round-robin across workers and wait for completion. |
| `shutdown()`                                                                           | registered with `atexit` at `trellis_server.py:1044`.                                                                                                                                                                | Terminate all workers.                                                       |


`trellis_server.py` does not call `set_conds`, `generate`, or `shutdown` directly during a slider build — it just hands the pool object to the entrypoints below. Lifecycle calls (`__init_`_, `shutdown`) happen at `__main__` startup/exit.

### `get_lpips_curve_gradient_based(view_images_dir, edited_images_dir, editing_prompt_pair, boundaries, out_dir=None, gpu_ids=[0], n_samples=9, workers_per_gpu=1, pipelines=None, conds=None, pool=None, need_glb=False)`

Step 5 of the slider build. Given the conditioning images and the `(neg_prompt, pos_prompt)` pair, gradient-based-samples slider values across `boundaries`, generates a set of key-frames at each, computes LPIPS distance to the reference (slider value 0), runs GPT-vision quality verification on each candidate, and writes a `lpips_curve_gradient_<n_samples>.txt` file plus per-anchor `search_at_<value>/output.glb` outputs under `out_dir`.

When `pool` is passed, frame generation is delegated to that pool; otherwise a temporary one is spawned.

- **Called at** `trellis_server.py:853` inside `_create_slider_work` (Socket.IO `create_slider` handler).
- **Side effects:** GPU work via the pool, multiple OpenAI vision API calls (unless `RELAX=True` in `trellis_server.py` short-circuits validation — see `ml_servers/README.md` for the flag's exact behavior), and many files written under `out_dir`.

### `get_slider_value_from_lpips_percentage(lpips_curve_path, percentage, view_images_dir, edited_images_dir, editing_prompt_pair, out_dir, gpu_ids=[0], pipelines=None, conds=None, pool=None, max_candidates=5, invalid_proximity_threshold=0.05, relax=False) -> Tuple[float, float, bool]`

Reads the LPIPS curve produced by `get_lpips_curve_gradient_based`, finds the slider value whose LPIPS score corresponds to the requested percentage (0–100) of the curve's range, generates that frame, and returns `(slider_value, actual_lpips_score, is_valid)`. Quality-verifies up to `max_candidates` candidates per percentage; with `relax=True` the first candidate is accepted without GPT validation.

- **Called at** `trellis_server.py:950` inside `_add_anchor_work` (Socket.IO `add_anchor_point` handler) to add a new anchor at a user-specified percentage on an already-built slider.
- **Prerequisite:** `lpips_curve_path` must already exist — it's produced by `get_lpips_curve_gradient_based` during the initial slider build.
- **See also:** `LPIPS_PERCENTAGE_MAPPING_README.md` in this directory has more detail on the percentage-mapping logic, candidate selection, and the multi-percentage variant (`get_slider_values_from_lpips_percentages`, not used by the server).

---

## Cross-cutting notes

- **OpenAI key.** Three `text_gen_utils` functions plus the validation paths inside `slider_mapping` all assume `OPENAI_API_KEY` is available in the environment. `text_gen_utils.py` calls `load_dotenv()` at import, so an `.env` file in the working directory (or any ancestor) is sufficient.
- **GPU layout.** `get_ImageReward_model`'s default device is `"cuda:1"`. If you reassign GPUs via `SS3D_TRELLIS_PIPELINE_GPU` / `SS3D_TRELLIS_POOL_GPUS`, audit this default to make sure ImageReward isn't sharing a GPU you'd rather keep clear.
- **Duplication.** `direction_generator_edit`, `editing_prompt_view_filtering`, and `edit_image_gpt_image` exist in both `val_editing.py` (with a `client` arg) and `text_gen_utils.py` (without). The server imports the `text_gen_utils` versions — keep edits in sync if you change either set of behavior.

