"""Central path configuration for the ml_servers.

Loads `ml_servers/.env` (if present) into the process environment, then exposes
path constants. Shell-exported vars still win over .env (via setdefault), so
CI/Docker overrides work without editing files.

On a new machine: copy `.env.example` to `.env`, edit the paths, done.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE_DIR)


def _load_dotenv(path):
    """Minimal .env parser: KEY=VALUE, #comments, optional quotes."""
    if not os.path.isfile(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            os.environ.setdefault(key, val)


_load_dotenv(os.path.join(BASE_DIR, '.env'))

DATA_DIR = os.environ.get('SS3D_DATA_DIR', os.path.join(BASE_DIR, 'logs'))
TRELLIS_ROOT = os.environ.get('SS3D_TRELLIS_ROOT', os.path.join(REPO_ROOT, 'TRELLIS'))

# SemanticSlider3D's own utilities. Lived at TRELLIS/ss3d_utils/ until it was
# hoisted to the repo root to separate our code from the vendored TRELLIS clone.
SS3D_UTILS_ROOT = os.environ.get('SS3D_UTILS_ROOT', os.path.join(REPO_ROOT, 'ss3d_utils'))

SAM3D_ROOT = os.environ.get('SS3D_SAM3D_ROOT', os.path.join(REPO_ROOT, 'sam-3d-objects'))
SAM3D_CKPTS = os.environ.get('SS3D_SAM3D_CKPTS', 'sam3d_ckpts')

# ss3d_utils/_paths.py re-derives TRELLIS_ROOT on its own (it is imported without
# going through this module when ss3d_utils is used standalone). Export the value
# resolved here so the two always agree, even when SS3D_TRELLIS_ROOT was never
# set in the shell or in .env.
os.environ.setdefault('SS3D_TRELLIS_ROOT', TRELLIS_ROOT)

# GPU selection for app.py (SAM2 + SAM3D). Accepts "0", "1", "0,1", etc.
# Only app.py should act on this — trellis_server.py uses absolute GPU ids and
# must NOT have CUDA_VISIBLE_DEVICES narrowed. The mutation therefore lives in
# app.py, not here; config.py only exposes the value.
APP_GPU = os.environ.get('SS3D_APP_GPU', '')


# --- trellis_server.py GPU settings ---
# Unlike app.py, trellis_server passes physical GPU ids directly to its
# components, so CUDA_VISIBLE_DEVICES is NOT set here.

# GPU for the main TRELLIS text-to-3D pipeline. Overridden by the `--gpu` flag.
TRELLIS_PIPELINE_GPU = int(os.environ.get('SS3D_TRELLIS_PIPELINE_GPU', '0'))


def _parse_pool_configs(gpus_spec, workers_per_gpu):
    """Parse pool DSL into POOL_CONFIGS list.

    Format: "<pool>,<pool>,..." where each <pool> is "+"-separated GPU ids.
      "2,3"       → two pools: [2], [3]   (current default)
      "2+3,4+5"   → two pools: [2,3], [4,5]
      "0"         → single pool: [0]
    """
    pools = []
    for chunk in gpus_spec.split(','):
        chunk = chunk.strip()
        if not chunk:
            continue
        gpu_ids = [int(x.strip()) for x in chunk.split('+') if x.strip()]
        pools.append({'gpu_ids': gpu_ids, 'workers_per_gpu': workers_per_gpu})
    return pools


TRELLIS_POOL_CONFIGS = _parse_pool_configs(
    os.environ.get('SS3D_TRELLIS_POOL_GPUS', '2,3'),
    int(os.environ.get('SS3D_TRELLIS_WORKERS_PER_GPU', '4')),
)
