# ml_servers

Backend servers for the SemanticSlider3D interactive playground. This folder contains two Flask servers: one for 3D object generation and slider editing (Trellis text-to-3d + SemanticSlider3D core), and one for image-based 3D reconstruction (SAM3D + logistics).

## Configuration (`config.py` + `.env`)

All paths and GPU layout for both servers are centralized in `config.py`, which loads `ml_servers/.env` on import. On a new machine, copy `.env.example` → `.env` and edit the values. Shell exports (`export SS3D_FOO=...`) take precedence over `.env`, so CI / Docker overrides work without editing the file.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SS3D_DATA_DIR` | both | Per-session logs / GLBs / renders root. Default: `<ml_servers>/logs`. |
| `SS3D_SAM3D_CKPTS` | `app.py` | SAM3D checkpoint directory (several GB). Default: `sam3d_ckpts`, relative to the working directory you launch `app.py` from. |
| `SS3D_TRELLIS_ROOT` | `trellis_server.py` | TRELLIS clone path. Default: `<repo>/TRELLIS`. |
| `SS3D_SAM3D_ROOT` | `app.py` | `sam-3d-objects` clone path. Default: `<repo>/sam-3d-objects`. |
| `SS3D_APP_GPU` | `app.py` | GPU id(s) for SAM2 + SAM3D. Sets `CUDA_VISIBLE_DEVICES` before torch import, so the chosen physical GPU becomes `cuda:0` inside the process. Accepts `0`, `1`, `0,1`. Default: unset (all GPUs visible). |
| `SS3D_TRELLIS_PIPELINE_GPU` | `trellis_server.py` | Physical GPU id for the main text-to-3D pipeline. Override per run with `--gpu`. Default: `0`. |
| `SS3D_TRELLIS_POOL_GPUS` | `trellis_server.py` | Worker pools for concurrent slider building. `"2,3"` = two pools on GPUs 2 and 3; `"2+3,4+5"` = two pools with two GPUs each; `"0"` = single pool on GPU 0. Should not overlap with the pipeline GPU. Default: `"2,3"`. |
| `SS3D_TRELLIS_WORKERS_PER_GPU` | `trellis_server.py` | Workers per GPU within each pool. Default: `4`. |

`app.py` and `trellis_server.py` treat GPUs differently:
- `app.py` narrows `CUDA_VISIBLE_DEVICES` via `SS3D_APP_GPU`, so torch only ever sees `cuda:0` regardless of which physical GPU was selected.
- `trellis_server.py` does **not** narrow `CUDA_VISIBLE_DEVICES`. It passes physical GPU ids directly to the pipeline (`--gpu` / `SS3D_TRELLIS_PIPELINE_GPU`) and to the pool workers (`SS3D_TRELLIS_POOL_GPUS`). The `/trellis/generate` handler wraps `pipeline.run` and `postprocessing_utils.to_glb` in `with torch.cuda.device(args.gpu):` because the spconv slat sampler and the diff_gaussian_rasterization kernel both dispatch on `torch.cuda.current_device()` rather than on the input tensor's device.

## `app.py`

Flask server handling session management, image segmentation (SAM2), image-to-3D reconstruction (SAM3D), and file serving. This is the "logistics" server that the playground UI talks to for most non-slider operations. Runs on port 5001 by default.

### Usage

```bash
conda activate sam3d
python app.py
```

GPU and paths come from `ml_servers/.env` — see [Configuration](#configuration-configpy--env) above. Set `SS3D_APP_GPU` to pick the SAM2 + SAM3D GPU.

### Dependencies

- **SAM2** — `ultralytics` SAM2DynamicInteractivePredictor for interactive image segmentation.
- **SAM3D** — `inference` module from `<SS3D_SAM3D_ROOT>/notebook/` (defaults to `<repo>/sam-3d-objects/notebook/`) for single-image-to-3D reconstruction.

### Startup

On launch, the server:

1. Initializes the SAM2 interactive predictor (`sam2_t.pt`).
2. Lazily loads the SAM3D inference model on first `/to_3d` call (checkpoints from `SS3D_SAM3D_CKPTS`, default `sam3d_ckpts`).

### Functions

#### Session management

- `**get_session_folders(user_id, session_id)`** — Creates and returns `(upload_folder, downloads_folder)` paths for a session.
- `**get_session_state_path(user_id, session_id)**` — Returns path to `session_state.json`.
- `**save_session_state(session_data)**` — Saves session state to disk with file locking. Merges `finished_objects` from disk so that objects added by `trellis_server.py` are not lost.
- `**load_session_state(user_id, session_id)**` — Loads session state from disk.
- `**get_or_create_session(user_id, session_id)**` — Gets an existing in-memory session or creates a new one. New sessions are seeded with commons objects.
- `**resume_session(user_id, session_id)**` — Resumes a session from disk, reloading `finished_objects` to pick up any trellis-added objects.

#### Commons (shared pre-loaded objects)

- `**copy_commons_to_session(downloads_folder)**` — Copies all GLBs and metadata from the `commons/` directory into a new session so every user starts with a set of pre-built objects.
- `**build_commons_gallery_items(finished_objects, session_id, downloads_folder)**` — Builds gallery item dicts for commons objects so the frontend can display them immediately.

#### Image processing

- `**generate_thumbnail(image_path, mask_path)**` — Applies a segmentation mask to the original image, crops to the bounding box, and returns a base64-encoded RGBA PNG.
- `**get_inference_model()**` — Lazy-loads and returns the SAM3D inference model singleton.

### API Endpoints (REST)


| Method | Route                                          | Description                                                                                                                                                 |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/start_session`                               | Create a new session for a user. Returns session ID and any commons gallery items.                                                                          |
| GET    | `/get_user_sessions/<user_id>`                 | List all sessions for a user with object counts, timestamps, and image info.                                                                                |
| POST   | `/resume_session`                              | Resume an existing session from disk. Returns gallery items, uploaded images, and object states.                                                            |
| POST   | `/upload`                                      | Upload an image to the session. Resets predictor state for the new image.                                                                                   |
| GET    | `/uploads/<session_id>/<filename>`             | Serve an uploaded image.                                                                                                                                    |
| GET    | `/downloads/<session_id>/<filename>`           | Serve a downloaded/generated file.                                                                                                                          |
| POST   | `/reset`                                       | Reset the SAM2 predictor memory (clear all segmentation state).                                                                                             |
| POST   | `/segment`                                     | Run SAM2 interactive segmentation with given points/labels. Supports incremental (1 new point) and full-replay modes. Returns annotated image + saves mask. |
| POST   | `/finish_object`                               | Finalize the current segmentation as an object. Clears predictor, increments object index, returns thumbnail.                                               |
| POST   | `/combine_objects`                             | Merge multiple object masks (logical OR) into a new combined object.                                                                                        |
| POST   | `/uncombine_object`                            | Split a combined object back into its original components.                                                                                                  |
| POST   | `/delete_object`                               | Remove an object from the session. Tracks deletion so it won't be resurrected on merge.                                                                     |
| POST   | `/to_3d`                                       | Run SAM3D image-to-3D reconstruction for a segmented object. Returns GLB download URL.                                                                      |
| POST   | `/resolve_variant`                             | Resolve a slider variant GLB URL (duplicate of trellis endpoint, serves from this server to avoid GIL contention).                                          |
| GET    | `/serve_variant/<user_id>/<session_id>/<path>` | Serve variant GLBs from the downloads directory.                                                                                                            |
| POST   | `/save_object_states`                          | Persist object transforms and visibility to `session_state.json`.                                                                                           |
| POST   | `/log_behavior`                                | Log a user behavior event to a per-session JSONL file.                                                                                                      |


---

## `trellis_server.py`

Flask + SocketIO server that handles text-to-3D generation and semantic slider creation/manipulation. Runs on port 5002 by default.

### Usage

```bash
conda activate trellis
python trellis_server.py [--gpu <n>] [--port 5002]
```

`--gpu` overrides `SS3D_TRELLIS_PIPELINE_GPU` for a single run. Pool layout (`SS3D_TRELLIS_POOL_GPUS`, `SS3D_TRELLIS_WORKERS_PER_GPU`) is read from `.env` only — there is no CLI flag for pools. Pipeline and pool GPUs should not overlap; if they do, slider-build workers will fight the pipeline for VRAM.

### Module-level tuning constants

A handful of constants near the top of `trellis_server.py` are not exposed via `.env` and must be edited in source. They mostly affect slider build cost vs. quality:

| Constant | Default | Effect |
| --- | --- | --- |
| `NUM_VIEWS` | `40` | Number of multi-view renders fed into the best-view selection step. |
| `NUM_SAMPLES` | `4` | Samples generated per slider build. Higher → smoother slider, longer build. |
| `MAX_WORKERS` | `int(NUM_VIEWS * 0.2)` | Cap on concurrent worker threads inside slider construction. |
| `RELAX` | `True` | Skips GPT-vision validation of slider candidates (see below). |

**`RELAX` flag** — when `True`, step 5 of the slider build (`get_lpips_curve_gradient_based` in `ss3d_utils/slider_mapping.py`) accepts the top LPIPS candidate at each target percentage **without** running `get_quality_change_verification` against the editing prompt pair. Trade-off:

- `RELAX = True` (current default): faster builds, no per-anchor OpenAI vision-validation calls. Anchors are chosen purely by LPIPS proximity to the target percentage. Recommended for demos and large sweeps where validation cost dominates.
- `RELAX = False`: each candidate goes through GPT vision validation. Cleaner anchor points (each is verified to actually express the intended attribute change), but slower and consumes API quota. If all candidates fail, the code falls back to the closest already-validated observation along the curve.

The flag is passed through to `get_lpips_curve_gradient_based(..., relax=RELAX)` at the call site in `_create_slider_work`.

### Dependencies

- **TRELLIS pipeline** — imported from `<SS3D_TRELLIS_ROOT>/trellis/` (defaults to `<repo>/TRELLIS/trellis/`).
- **ss3d_utils** — slider mapping, view rendering, prompt generation, and evaluation utilities imported from `<SS3D_UTILS_ROOT>/` (defaults to `<repo>/ss3d_utils/`). This is SemanticSlider3D's own code; it sits at the repo root rather than inside the vendored TRELLIS clone.

### Startup (`__main__`)

On launch, the server:

1. Calls `torch.cuda.set_device(args.gpu)`, then loads the Trellis Text-to-3D pipeline (`TrellisTextTo3DPipeline`) onto `cuda:<args.gpu>`. After load, `_pin_text_cond_model_to_device` rebinds the text encoder and `encode_text` to that device — the upstream `Pipeline.to()` only moves `self.models` and otherwise leaves `text_cond_model` (with hardcoded `.cuda()` calls) on `cuda:0`, which would mismatch on any non-zero pipeline GPU.
2. Loads the ImageReward model for view ranking (`get_ImageReward_model`).
3. Spins up GPU worker pools (`GPUWorkerPool` from `slider_mapping`) for concurrent slider building. Pool configuration comes from `TRELLIS_POOL_CONFIGS` in `config.py`, parsed from `SS3D_TRELLIS_POOL_GPUS` (default `"2,3"` → two pools on GPUs 2 and 3) × `SS3D_TRELLIS_WORKERS_PER_GPU` (default `4`).

### Functions

#### GPU pool management

- `**acquire_gpu_pool()`** — Blocks until a GPU worker pool is free. Returns `(pool, lock, pool_index)`.
- `**release_gpu_pool(lock)`** — Releases a previously acquired pool so other jobs can use it.

#### LPIPS curve / anchor helpers

- `**find_lpips_curve(slider_map_dir)**` — Finds the `lpips_curve_gradient_*.txt` file in a slider map directory. When multiple exist, returns the one with the highest sample count.
- `**read_anchors_from_lpips(lpips_path, require_glb=True)**` — Reads and merges anchor points from all LPIPS curve files in the directory. Returns `[slider_value, normalized_lpips]` pairs, optionally filtering to only anchors that have a corresponding `output.glb`.
- `**append_anchor_to_lpips(lpips_path, slider_value, raw_lpips)**` — Appends a new data point to the LPIPS curve file, skipping duplicates.

#### Session state

- `**save_trellis_object_to_session(user_id, session_id, object_id, glb_filename, prompt, seed)**` — Appends a generated object entry to the session's `session_state.json`. Uses file locking (`fcntl`) to avoid races with `app.py`.

#### Mesh processing

- `**bake_vertex_colors_to_texture(glb_path, texture_size=1024)**` — Converts a vertex-color GLB into a UV-textured GLB using xatlas for UV parametrization and barycentric rasterization. Caches the result as `*_textured.glb`. Needed because Blender's renderer expects UV textures. The functions is skipped if already UV-textured. In fact, **this function was never used** because both TRELLIS and SAM3D already use UV textures.
- `**render_multiviews(glb_path)`** — Bakes vertex colors (if needed) then calls `get_multi_view_from_3d_assets_mp` (from `ss3d_utils/render_multiviews_blender_mp`) to render multi-view images via Blender. Returns the output directory.

#### View selection and editing

- `**filter_best_views(best_views_target, target_prompt, best_view_dir, N=10)**` — Takes ranked views and verifies each with `editing_prompt_view_filtering` (GPT vision check). Copies up to N verified views to `best_view_dir`.
- `**edit_best_views(best_view_paths, sub_out_dir, neg_prompt, pos_prompt)**` — Edits each best view with both negative and positive prompts using `edit_image_gpt_image` (GPT image editing). Runs edits in parallel via `ThreadPoolExecutor`.

### API Endpoints (REST)


| Method | Route                                                   | Description                                                                                                |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| POST   | `/trellis/generate`                                     | Generate a 3D object from a text prompt. Runs the Trellis pipeline, exports GLB, returns the download URL. |
| POST   | `/trellis/render_views`                                 | Render multi-views for an existing GLB (calls `render_multiviews`).                                        |
| GET    | `/trellis/downloads/<session_id>/<filename>`            | Serve a generated GLB file.                                                                                |
| GET    | `/trellis/downloads/<session_id>/slider_variant/<path>` | Serve a slider variant GLB from `search_at_<value>/output.glb`.                                            |
| POST   | `/trellis/resolve_variant`                              | Resolve a slider value to a variant GLB URL, falling back to the original.                                 |
| POST   | `/trellis/fork_anchor`                                  | Copy a slider anchor's GLB as a new standalone object.                                                     |
| POST   | `/trellis/get_sliders`                                  | Return all existing sliders for a GLB with their build status, prompts, and anchor points.                 |
| POST   | `/trellis/set_anchor_rotation`                          | Persist a Y-rotation correction for a specific slider anchor.                                              |
| GET    | `/trellis/pool_status`                                  | Return how many GPU pools are available for new slider jobs.                                               |


### WebSocket Events (SocketIO)


| Event                   | Direction       | Description                                                                                   |
| ----------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `create_slider`         | client → server | Start building a semantic slider. Dispatches `_create_slider_work` in a background thread.    |
| `slider_progress`       | server → client | Step-by-step progress updates during slider creation.                                         |
| `slider_complete`       | server → client | Slider build finished, includes anchor points and prompts.                                    |
| `slider_error`          | server → client | Slider build failed.                                                                          |
| `add_anchor_point`      | client → server | Add a new anchor at a given percentage. Dispatches `_add_anchor_work` in a background thread. |
| `anchor_point_progress` | server → client | Progress update for anchor generation.                                                        |
| `anchor_point_complete` | server → client | Anchor added, returns updated anchor list.                                                    |
| `anchor_point_error`    | server → client | Anchor generation failed.                                                                     |


### Slider creation pipeline (`_create_slider_work`)

The 5-step slider build process (each step is skippable via cached flag files):

1. **Prompt generation** — `direction_generator_edit` generates negative/positive editing prompts from the object name and attribute.
2. **Best view selection** — `select_best_views_by_ImageReward` ranks multi-view renders by relevance to the positive prompt.
3. **View filtering** — `filter_best_views` verifies top views with GPT vision.
4. **Image editing** — `edit_best_views` applies negative/positive edits to each selected view.
5. **Slider map construction** — `slider_mapping.get_lpips_curve_gradient_based` builds the slider map using GPU worker pools, producing variant GLBs at anchor points along the LPIPS curve. The `RELAX` constant (see [Module-level tuning constants](#module-level-tuning-constants)) decides whether each anchor is GPT-vision-verified or accepted purely by LPIPS proximity.

### Anchor point addition (`_add_anchor_work`)

Generates a new variant GLB at a user-specified percentage along the LPIPS curve via `slider_mapping.get_slider_value_from_lpips_percentage`, appends it to the curve file, and returns the updated anchor list.