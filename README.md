# SemanticSlider3D

Everything about SemanticSlider3D --- slider-based 3D semantic editing technique.

## Project Structure

- `TRELLIS/` --- Adapted from [microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) (snapshot of commit `442aa1e`), Microsoft's structured-latent 3D object generation pipeline; contains core editing and evaluation algorithms. See [`MODIFICATIONS.md`](MODIFICATIONS.md) for what was changed.
- `sam-3d-objects/` --- Adapted from [facebookresearch/sam-3d-objects](https://github.com/facebookresearch/sam-3d-objects) (snapshot of commit `afdf6a3`), image-to-3D reconstruction driving the SAM3D backend. Covered by Meta's SAM License, **not** this repo's MIT license --- see [`LICENSE`](LICENSE).
- `ss3d_utils/` --- SemanticSlider3D's own utilities imported by the backends: slider/LPIPS mapping, multi-view Blender rendering, prompt generation, and offline evaluation (`val_*.py`).
- `playground_ui/` --- React interactive app (only front-end) for interactive playground with SemanticSlider3D, with TRELLIS and SAM3d for multi-modal 3D generation
- `ml_servers/` --- 3D object generation and editing backend
- `conda_env_configs/` --- Conda environment specs for the two envs (`trellis`, `sam3d`)
- `Caddyfile` --- single-origin reverse proxy for demos

See README files in each folder for more detail. Model weights are not tracked in this repository --- see the setup steps below.

## Instruction on Running Interactive Playground

### Conda Env Setup:

Use the env_nobuilds.yml files in each env folder (they're more portable since they omit build strings, according to Claude). Create conda env trellis and sam3d using following methods
```bash
conda env create -f conda_env_configs/trellis/env_nobuilds.yml
conda env create -f conda_env_configs/sam3d/env_nobuilds.yml
```
*If _no_builds.ymls do not work, use _history.ymls*

Other dependencies: blender needs to be installed and added to the PATH.

### Configure Paths and GPU Layout (`ml_servers/.env`)

Both backends read their paths and GPU layout from `ml_servers/.env`, loaded by `ml_servers/config.py` on import. On a new machine, use ml_servers/.env.example as a template and edit ml_servers/.env for your machine

Variables (all prefixed `SS3D_`, all optional — sensible defaults in `config.py`):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SS3D_DATA_DIR` | both servers | Per-session logs / GLBs / renders. Grows fast — point at a big disk. |
| `SS3D_SAM3D_CKPTS` | `app.py` | SAM3D checkpoint directory (several GB). |
| `SS3D_TRELLIS_ROOT` | `trellis_server.py` | Path to the TRELLIS clone. Defaults to `<repo>/TRELLIS`. |
| `SS3D_SAM3D_ROOT` | `app.py` | Path to the `sam-3d-objects` clone. Defaults to `<repo>/sam-3d-objects`. |
| `SS3D_APP_GPU` | `app.py` | GPU id(s) for SAM2 + SAM3D. Sets `CUDA_VISIBLE_DEVICES` before torch import, so the chosen physical GPU becomes `cuda:0`. Accepts `0`, `1`, `0,1`. |
| `SS3D_TRELLIS_PIPELINE_GPU` | `trellis_server.py` | Physical GPU id for the main text-to-3D pipeline. Override per run with `--gpu`. |
| `SS3D_TRELLIS_POOL_GPUS` | `trellis_server.py` | Worker pools for concurrent slider building. `"2,3"` = two pools on GPUs 2 and 3; `"2+3,4+5"` = two pools with two GPUs each. **Should not overlap with `SS3D_TRELLIS_PIPELINE_GPU`** — overlap causes VRAM contention under load. |
| `SS3D_TRELLIS_WORKERS_PER_GPU` | `trellis_server.py` | Workers per GPU within each pool. Default `4`. |

Shell exports (`export SS3D_FOO=...`) take precedence over `.env`, so CI / Docker overrides work without editing the file.

Unlike `app.py`, `trellis_server.py` does **not** narrow `CUDA_VISIBLE_DEVICES` — it passes physical GPU ids directly to its components.

### Configure AI Model Credentials (`.env` at the repo root)

> **You must populate this file with your own API keys before slider builds will work.** The slider pipeline (`ss3d_utils/text_gen_utils.py` and `ss3d_utils/slider_mapping.py`) calls OpenAI for prompt generation, view filtering, and image editing; some helper paths additionally reference Gemini and Anthropic (optional). All keys are read at import time by `ss3d_utils/_paths.py:load_ss3d_dotenv()`, which checks `<repo>/.env` first and falls back to `TRELLIS/.env` for older deployments.

Create the file at the repo root as `.env` (it is `.gitignore`-d, so it does not travel with the repo):

```bash
# <repo>/.env
OPENAI_API_KEY='sk-...'         # required — used by text_gen_utils + slider_mapping
```

Notes:

- **Use your own keys.** Do not commit it.
- **OpenAI is the load-bearing one.** Without `OPENAI_API_KEY`, slider builds fail in the prompt-generation step; with `RELAX=True` in `trellis_server.py` the per-anchor quality check is skipped, but the prompt-generation and view-filtering stages still need the key.

### Run Interactive Playground

You need to open three terminals:

- Terminal 1:
In `ml_servers`: activate trellis env `conda activate trellis`, and run `python trellis_server.py` (override the pipeline GPU per-run with `--gpu <n>` if needed; otherwise it uses `SS3D_TRELLIS_PIPELINE_GPU` from `.env`).
- Terminal 2:
In `ml_servers`: activate sam3d env `conda activate sam3d`, and run `python app.py` (uses `SS3D_APP_GPU` from `.env`).
- Terminal 3:
In `playground_ui`: run `npm start`(first time run should do `npm install` before `npm start`)

If running on a remote server and accessing from your local machine:

Start all three services on the server as described above. Then, on your **local machine**, use SSH port forwarding to tunnel the relevant ports to your localhost. The React app runs on port 3000, the SAM3D server on port 5001, and the Trellis server on port 5002:

```bash
ssh -L 3000:localhost:3000 -L 5001:localhost:5001 -L 5002:localhost:5002 user@server-address
```

This forwards each remote port to the same port on your local machine. Once connected, open `http://localhost:3000` in your local browser to use the UI. The React app will communicate with the backend servers through the other forwarded ports as if everything were running locally.

**Tip:** You can add the `-N` flag (`ssh -N -L ...`) if you only need the port forwarding and don't need an interactive shell session. The -N flag tells SSH to skip opening the shell and only do the port forwarding. This is useful if you already have a separate SSH session open for running commands and just want a dedicated connection purely for tunneling ports. In practice, you'll probably not use -N here since you need terminal sessions on the server anyway to start the three services. So that tip is more of a nice-to-know.

### Show Demo Over the Corporate Network (Caddy)

The SSH-tunnel setup above only lets _you_ hit `localhost:3000` on your laptop. To let a client point their browser at `http://<server-ip>:8080/` and drive the demo themselves, run a small reverse proxy (Caddy) on the server. Both you and the client must be on the corporate VPN that routes to this server.

#### Why a reverse proxy is needed

The React app is a single bundle that talks to **two** backends — SAM3D on port 5001 and Trellis on port 5002 (the latter also over Socket.IO for slider progress streaming). Two consequences:

1. **Browsers enforce same-origin rules** for cookies, CORS preflights, and websocket upgrades. If the client hit `:3000` directly, every API call would either fail CORS or need every endpoint pre-flagged. CRA's `setupProxy.js` solves this in development by running on the same machine as the dev server, but it's a dev-only feature — `npm run build` produces a static bundle with no proxy.
2. **The CRA dev server isn't built for external clients** anyway: it has a host-check that rejects non-localhost requests, ships source maps, and rebuilds on every save.

Caddy fixes both: it listens on one public port, serves the React production build, and routes `/trellis/*` + `/socket.io/*` to 5002 and the SAM3D whitelist to 5001. The browser sees one origin, so there's no CORS / websocket weirdness.

#### One-time setup

1. **Build the React app for production** (re-run whenever the frontend changes):
   ```bash
   cd playground_ui && npm run build
   ```
2. **Allow inbound traffic on the demo port** (`8080` by default — open to anything on the VPN that can route to the host):
   ```bash
   sudo ufw allow 8080/tcp
   ```
   Or restrict it to a single client IP:
   ```bash
   sudo ufw allow from <client-ip> to any port 8080 proto tcp
   ```
3. Install Caddy (these instructions assume `~/bin/caddy`). The config lives at the repo root as `Caddyfile` — edit the `/path/to/SemanticSlider3D` placeholders in it to point at your clone.

#### Running, reloading, and stopping Caddy

The two backends (`trellis_server.py` + `app.py`) must be running first. Then:

```bash
~/bin/caddy start  --config /path/to/SemanticSlider3D/Caddyfile   # daemonize
~/bin/caddy reload --config /path/to/SemanticSlider3D/Caddyfile   # hot-apply Caddyfile edits, no connection drop
~/bin/caddy stop                                                  # shut down the daemon
```

The client then opens `http://<server-ip>:8080/`. Logs land at `caddy.log` (rotated at 10 MB, max 4 files ≈ 15 MB cap).

Caddy is **not** auto-started on boot. If the server reboots, run `caddy start` again. (Ask for a systemd unit if you want it persistent.)

#### Closing the demo

```bash
~/bin/caddy stop
sudo ufw delete allow 8080/tcp   # optional — re-close the port
```

#### Keeping things in sync

When adding a new SAM3D endpoint, update both `playground_ui/src/setupProxy.js` (dev) **and** the SAM3D whitelist block in `Caddyfile` (prod). Otherwise it will work in `npm start` but 404 in the demo build.

