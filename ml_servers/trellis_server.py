import os
import sys
import glob
import argparse

# Paths and GPU config come from ml_servers/config.py, which loads .env on import.
# Edit .env (copy from .env.example) to change DATA_DIR, TRELLIS_ROOT, GPU layout, etc.
from config import DATA_DIR, TRELLIS_ROOT, SS3D_UTILS_ROOT, TRELLIS_PIPELINE_GPU, TRELLIS_POOL_CONFIGS

parser = argparse.ArgumentParser(description='Trellis Text-to-3D Server')
parser.add_argument('--gpu', type=int, default=TRELLIS_PIPELINE_GPU,
                    help='GPU device index for the Trellis pipeline '
                         '(default: $SS3D_TRELLIS_PIPELINE_GPU or 0)')
parser.add_argument('--port', type=int, default=5002, help='Server port')
args = parser.parse_args()

os.environ['SPCONV_ALGO'] = 'native'

import uuid
import json
import fcntl
import torch
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import time
import shutil
import numpy as np

# Add TRELLIS to path
sys.path.insert(0, TRELLIS_ROOT)
from trellis.pipelines import TrellisTextTo3DPipeline
from trellis.utils import postprocessing_utils

# Add ss3d_utils path (repo root; formerly TRELLIS/ss3d_utils, before that TRELLIS/validation)
sys.path.insert(0, SS3D_UTILS_ROOT)
from render_multiviews_blender_mp import get_multi_view_from_3d_assets_mp
from text_gen_utils import direction_generator_edit, editing_prompt_view_filtering, edit_image_gpt_image
from val_editing import get_ImageReward_model, select_best_views_by_ImageReward
import slider_mapping

os.makedirs(DATA_DIR, exist_ok=True)
NUM_VIEWS = 40
NUM_SAMPLES = 4
MAX_WORKERS = int(NUM_VIEWS * 0.2)
RELAX = True

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Module-level globals — initialized in __main__ to avoid re-init in spawned children
import atexit
import threading

# Independent GPU pools so multiple sliders can be built concurrently.
# Each pool gets its own GPU(s) and conditions, avoiding set_conds conflicts.
# Configure via SS3D_TRELLIS_POOL_GPUS / SS3D_TRELLIS_WORKERS_PER_GPU in .env.
POOL_CONFIGS = TRELLIS_POOL_CONFIGS
MAX_CONCURRENT_SLIDERS = len(POOL_CONFIGS)
pipeline = None
rm_model = None
gpu_pools = []          # list of GPUWorkerPool instances
_pool_locks = []        # one threading.Lock per pool
_pool_semaphore = None  # limits concurrent slider jobs to len(gpu_pools)
_active_jobs = 0        # track how many jobs are in-flight (for /pool_status)
_active_jobs_lock = threading.Lock()


def acquire_gpu_pool():
    """Block until a GPU pool is available, return (pool, lock, pool_index)."""
    global _active_jobs
    _pool_semaphore.acquire()
    with _active_jobs_lock:
        _active_jobs += 1
    for idx, lock in enumerate(_pool_locks):
        if lock.acquire(blocking=False):
            return gpu_pools[idx], lock, idx
    # Fallback: shouldn't happen, but wait on first pool
    _pool_locks[0].acquire()
    return gpu_pools[0], _pool_locks[0], 0


def release_gpu_pool(lock):
    """Release a previously acquired GPU pool."""
    global _active_jobs
    lock.release()
    _pool_semaphore.release()
    with _active_jobs_lock:
        _active_jobs -= 1

def find_lpips_curve(slider_map_dir):
    """Find the lpips_curve_gradient_*.txt file in a slider map directory.

    Returns the path if found, otherwise None.  When multiple files exist
    (e.g. from runs with different sample counts), returns the one with
    the highest number, since its anchors have corresponding GLB files.
    """
    import re
    matches = glob.glob(os.path.join(slider_map_dir, 'lpips_curve_gradient_*.txt'))
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    def extract_num(path):
        m = re.search(r'lpips_curve_gradient_(\d+)\.txt$', path)
        return int(m.group(1)) if m else -1
    return max(matches, key=extract_num)


def read_anchors_from_lpips(lpips_path, require_glb=True):
    """Read anchor points from lpips_curve_gradient files.

    Merges data from **all** lpips_curve_gradient_*.txt files in the same
    directory (not just the highest-numbered one), because earlier rounds
    may contain valid anchors with GLBs that were dropped in later rounds.

    Returns a list of [slider_value_str, normalized_lpips] pairs, built
    from all *valid* data lines.  If *require_glb* is True, only include
    points that have a corresponding ``search_at_{sv}/output.glb``.
    """
    slider_map_dir = os.path.dirname(lpips_path)

    # Merge all lpips curve files, keyed by slider value (later files win on conflicts)
    all_files = sorted(glob.glob(os.path.join(slider_map_dir, 'lpips_curve_gradient_*.txt')))
    merged = {}  # sv_str -> (lpips_val, valid_str)
    for fpath in all_files:
        with open(fpath, 'r') as f:
            parts = f.read().split('\n\n')
        for line in parts[0].split('\n'):
            cols = line.strip().split(',')
            if len(cols) < 3:
                continue
            sv, lpips_val, valid = cols[0], float(cols[1]), cols[2]
            merged[sv] = (lpips_val, valid)

    anchors_raw = []
    for sv, (lpips_val, valid) in merged.items():
        if valid != '1':
            continue
        if require_glb:
            glb_path = os.path.join(slider_map_dir, f'search_at_{sv}', 'output.glb')
            if not os.path.exists(glb_path):
                # For the origin point (sv=0), keep it even without a
                # dedicated GLB — the frontend falls back to the original.
                if float(sv) != 0.0:
                    continue
        anchors_raw.append([sv, lpips_val])

    if not anchors_raw:
        return []

    min_lpips = min(a[1] for a in anchors_raw)
    max_lpips = max(a[1] for a in anchors_raw)
    lpips_range = max_lpips - min_lpips

    anchors = []
    for sv, raw in anchors_raw:
        normalized = (raw - min_lpips) / lpips_range if lpips_range > 0 else 0.5
        anchors.append([sv, normalized])
    anchors.sort(key=lambda x: x[1])
    return anchors


def append_anchor_to_lpips(lpips_path, slider_value, raw_lpips):
    """Append a new valid data point to the lpips_curve_gradient file.

    Inserts the new line at the end of the data section (before the
    metadata block separated by a blank line).  Skips if a line with the
    same slider value already exists.
    """
    sv_str = f"{slider_value:.5f}"

    with open(lpips_path, 'r') as f:
        content = f.read()

    parts = content.split('\n\n', 1)
    data_section = parts[0].rstrip('\n')
    metadata = parts[1] if len(parts) > 1 else ''

    # Check for existing entry with the same slider value
    for line in data_section.split('\n'):
        cols = line.strip().split(',')
        if len(cols) >= 1 and cols[0] == sv_str:
            return

    new_line = f"{sv_str},{raw_lpips:.5f},1"
    data_section += '\n' + new_line

    with open(lpips_path, 'w') as f:
        f.write(data_section + '\n\n' + metadata)


def save_trellis_object_to_session(user_id, session_id, object_id, glb_filename, prompt, seed):
    """Append a trellis-generated object to the session's finished_objects list."""
    state_path = os.path.join(DATA_DIR, user_id, session_id, 'session_state.json')
    lock_path = state_path + '.lock'
    try:
        # Use file lock to prevent race with app.py writing to the same file
        with open(lock_path, 'w') as lock_f:
            fcntl.flock(lock_f, fcntl.LOCK_EX)
            try:
                if os.path.exists(state_path):
                    with open(state_path, 'r') as f:
                        state = json.load(f)
                else:
                    state = {
                        'session_id': session_id,
                        'user_id': user_id,
                        'current_object_index': 0,
                        'processed_points_count': 0,
                        'merged_objects': {},
                        'current_image_path': None,
                        'created_at': None,
                        'finished_objects': [],
                    }

                state.setdefault('finished_objects', [])
                state['finished_objects'].append({
                    'object_index': object_id,
                    'source': 'trellis',
                    'prompt': prompt,
                    'seed': seed,
                    'glb_filename': glb_filename,
                    'is_combined': False,
                })

                with open(state_path, 'w') as f:
                    json.dump(state, f, indent=2)
                print(f"Saved trellis object {object_id} to session state")
            finally:
                fcntl.flock(lock_f, fcntl.LOCK_UN)
    except Exception as e:
        print(f"Warning: Failed to update session state: {e}")


def bake_vertex_colors_to_texture(glb_path, texture_size=1024):
    """Re-export a vertex-color GLB as a UV-textured GLB.

    If the GLB already has texture visuals (e.g. Trellis), it is left unchanged.
    Returns the path to the (possibly rewritten) GLB.
    """
    import trimesh
    import xatlas
    from PIL import Image

    # Cache: skip if already re-exported
    cached_path = glb_path.replace('.glb', '_textured.glb')
    if os.path.exists(cached_path):
        return cached_path

    _t0 = time.time()
    scene = trimesh.load(glb_path)
    geom = list(scene.geometry.values())[0] if isinstance(scene, trimesh.Scene) else scene

    # Skip if already UV-textured
    if isinstance(geom.visual, trimesh.visual.TextureVisuals):
        return glb_path

    if not hasattr(geom.visual, 'vertex_colors'):
        return glb_path

    vert_colors = np.array(geom.visual.vertex_colors[:, :3], dtype=np.float32) / 255.0
    vertices = np.array(geom.vertices, dtype=np.float64)
    faces = np.array(geom.faces, dtype=np.int32)

    # UV parametrize with xatlas
    vmapping, new_faces, uvs = xatlas.parametrize(vertices, faces)
    new_vertices = vertices[vmapping]
    new_colors = vert_colors[vmapping]

    # Rasterize vertex colors onto UV texture using vectorized barycentric interpolation
    tex = np.zeros((texture_size, texture_size, 3), dtype=np.float32)
    weight = np.zeros((texture_size, texture_size), dtype=np.float32)

    # Precompute all triangle UV pixel coords and colors
    tri_uvs = uvs[new_faces]  # (F, 3, 2)
    tri_cols = new_colors[new_faces]  # (F, 3, 3)

    # Convert UVs to pixel space
    px = tri_uvs[:, :, 0] * (texture_size - 1)  # (F, 3)
    py = (1.0 - tri_uvs[:, :, 1]) * (texture_size - 1)  # (F, 3)

    # Barycentric denominator for all faces
    v0x, v0y = px[:, 0], py[:, 0]
    v1x, v1y = px[:, 1], py[:, 1]
    v2x, v2y = px[:, 2], py[:, 2]
    denom = (v1y - v2y) * (v0x - v2x) + (v2x - v1x) * (v0y - v2y)

    # Process faces in batches to limit memory
    valid = np.abs(denom) > 1e-10
    face_indices = np.where(valid)[0]

    for fi in face_indices:
        x_min = max(int(np.floor(min(px[fi]))), 0)
        x_max = min(int(np.ceil(max(px[fi]))), texture_size - 1)
        y_min = max(int(np.floor(min(py[fi]))), 0)
        y_max = min(int(np.ceil(max(py[fi]))), texture_size - 1)
        if x_min > x_max or y_min > y_max:
            continue

        # Grid of pixel centers in this bbox
        xs = np.arange(x_min, x_max + 1) + 0.5
        ys = np.arange(y_min, y_max + 1) + 0.5
        gx, gy = np.meshgrid(xs, ys)  # (H, W)

        d = denom[fi]
        w0 = ((v1y[fi] - v2y[fi]) * (gx - v2x[fi]) + (v2x[fi] - v1x[fi]) * (gy - v2y[fi])) / d
        w1 = ((v2y[fi] - v0y[fi]) * (gx - v2x[fi]) + (v0x[fi] - v2x[fi]) * (gy - v2y[fi])) / d
        w2 = 1.0 - w0 - w1

        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue

        c = (w0[..., None] * tri_cols[fi, 0] +
             w1[..., None] * tri_cols[fi, 1] +
             w2[..., None] * tri_cols[fi, 2])

        rows = gy[inside].astype(int)
        cols = gx[inside].astype(int)
        np.add.at(tex, (rows, cols), c[inside])
        np.add.at(weight, (rows, cols), 1.0)

    mask = weight > 0
    tex[mask] /= weight[mask, None]
    tex = np.clip(tex * 255, 0, 255).astype(np.uint8)

    texture_img = Image.fromarray(tex)
    material = trimesh.visual.material.PBRMaterial(
        roughnessFactor=1.0,
        baseColorTexture=texture_img,
        baseColorFactor=np.array([255, 255, 255, 255], dtype=np.uint8),
    )
    new_mesh = trimesh.Trimesh(
        vertices=new_vertices,
        faces=new_faces,
        visual=trimesh.visual.TextureVisuals(uv=uvs, material=material),
    )

    out_path = glb_path.replace('.glb', '_textured.glb')
    new_mesh.export(out_path)
    print(f"Re-exported vertex-color GLB as UV-textured: {out_path} ({time.time() - _t0:.1f}s)")
    return out_path


def render_multiviews(glb_path):
    """Render multi-views from a GLB file. Returns the output directory."""
    # Re-export vertex-color GLBs with baked UV textures for Blender
    render_glb = bake_vertex_colors_to_texture(glb_path)
    base = os.path.splitext(glb_path)[0]
    out_dir = base + '_views'
    get_multi_view_from_3d_assets_mp(
        asset_path=render_glb,
        num_views=NUM_VIEWS,
        out_dir=out_dir,
        max_workers=MAX_WORKERS,
    )
    return out_dir


@app.route('/trellis/generate', methods=['POST'])
def generate():
    """Synchronous: run pipeline, export GLB, render multi-views, return result."""
    data = request.json
    prompt = data.get('prompt', '').strip()
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    seed = data.get('seed', 42)

    if not prompt:
        return jsonify({'error': 'Prompt is required'}), 400
    if not session_id or not user_id:
        return jsonify({'error': 'session_id and user_id are required'}), 400

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    os.makedirs(downloads_folder, exist_ok=True)

    try:
        print(f"Generating 3D from text: '{prompt}' (seed={seed}, session={session_id})")
        torch.cuda.empty_cache()

        # Pin current CUDA device for this Flask thread. spconv kernels in the
        # slat sampler and the diff_gaussian_rasterization kernel used by
        # to_glb's multi-view bake both dispatch on torch.cuda.current_device()
        # (not the tensor's device), so without this they'd launch on cuda:0
        # and crash with "illegal memory access" when the pipeline lives on
        # cuda:N>0. This mirrors what the pool workers do via
        # torch.cuda.set_device() in their spawned processes.
        with torch.cuda.device(args.gpu):
            outputs = pipeline.run(prompt, seed=seed)

            glb = postprocessing_utils.to_glb(
                outputs['gaussian'][0],
                outputs['mesh'][0],
                simplify=0.95,
                texture_size=1024,
            )

        object_id = f"trellis_{uuid.uuid4().hex[:8]}"
        glb_filename = f"{object_id}.glb"
        glb_path = os.path.join(downloads_folder, glb_filename)
        glb.export(glb_path)
        print(f"Saved GLB to {glb_path}")

        # Record in session state
        save_trellis_object_to_session(user_id, session_id, object_id, glb_filename, prompt, seed)

        # Multi-view rendering is triggered separately by the client via /trellis/render_views

        return jsonify({
            'glb_url': f'/trellis/downloads/{session_id}/{glb_filename}',
            'object_id': object_id,
            'glb_filename': glb_filename,
        })

    except Exception as e:
        print(f"Trellis generation error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/trellis/render_views', methods=['POST'])
def render_views():
    """Synchronous: render multi-views for an existing GLB."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    glb_filename = data.get('glb_filename')

    if not session_id or not user_id or not glb_filename:
        return jsonify({'error': 'session_id, user_id, and glb_filename are required'}), 400

    glb_path = os.path.join(DATA_DIR, user_id, session_id, 'downloads', glb_filename)
    if not os.path.exists(glb_path):
        return jsonify({'error': f'GLB file not found: {glb_filename}'}), 404

    try:
        print(f"Rendering multi-views for {glb_path}")
        views_dir = render_multiviews(glb_path)
        print(f"Multi-views saved to {views_dir}")
        return jsonify({'success': True, 'views_dir': views_dir})
    except Exception as e:
        print(f"Render views error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/trellis/downloads/<session_id>/<filename>')
def serve_download(session_id, filename):
    """Serve generated GLB files."""
    for user_dir in os.listdir(DATA_DIR):
        downloads_folder = os.path.join(DATA_DIR, user_dir, session_id, 'downloads')
        filepath = os.path.join(downloads_folder, filename)
        if os.path.exists(filepath):
            return send_from_directory(downloads_folder, filename)
    return jsonify({'error': 'File not found'}), 404


@app.route('/trellis/downloads/<session_id>/slider_variant/<path:subpath>')
def serve_slider_variant(session_id, subpath):
    """Serve variant GLBs from slider map subdirectories.

    Expected subpath: {glb_name}_slider_map_{idx}/search_at_{value}/output.glb
    """
    for user_dir in os.listdir(DATA_DIR):
        downloads_folder = os.path.join(DATA_DIR, user_dir, session_id, 'downloads')
        filepath = os.path.join(downloads_folder, subpath)
        if os.path.exists(filepath):
            return send_from_directory(os.path.dirname(filepath), os.path.basename(filepath))
    return jsonify({'error': 'Variant file not found'}), 404

@app.route('/trellis/resolve_variant', methods=['POST'])
def resolve_variant():
    """Return the URL for a slider variant, falling back to the original GLB."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    glb_filename = data.get('glb_filename')
    slider_index = data.get('slider_index')
    slider_value = data.get('slider_value')

    if not all([session_id, user_id, glb_filename, slider_index is not None, slider_value is not None]):
        return jsonify({'error': 'Missing required fields'}), 400

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    glb_name = glb_filename[:-4]
    sv = f"{float(slider_value):.5f}"
    variant_path = os.path.join(downloads_folder, f'{glb_name}_slider_map_{slider_index}', f'search_at_{sv}', 'output.glb')

    if os.path.exists(variant_path):
        url = f'/trellis/downloads/{session_id}/slider_variant/{glb_name}_slider_map_{slider_index}/search_at_{sv}/output.glb'
    else:
        url = f'/trellis/downloads/{session_id}/{glb_filename}'

    return jsonify({'url': url})


@app.route('/trellis/fork_anchor', methods=['POST'])
def fork_anchor():
    """Copy a slider anchor's GLB as a new standalone object."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    glb_filename = data.get('glb_filename')       # parent object GLB
    slider_index = data.get('slider_index')
    slider_value = data.get('slider_value')        # e.g. "1.11612"
    name = data.get('name', '').strip()

    if not all([session_id, user_id, glb_filename, slider_index is not None, slider_value is not None]):
        return jsonify({'error': 'Missing required fields'}), 400

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    glb_name = glb_filename[:-4]
    sv = f"{float(slider_value):.5f}"

    # Locate the anchor's GLB: search_at_<sv>/output.glb, else fall back to the original
    variant_glb = os.path.join(downloads_folder, f'{glb_name}_slider_map_{slider_index}', f'search_at_{sv}', 'output.glb')
    original_glb = os.path.join(downloads_folder, glb_filename)
    source_glb = variant_glb if os.path.exists(variant_glb) else original_glb

    if not os.path.exists(source_glb):
        return jsonify({'error': 'Source GLB not found'}), 404

    # Create new object with unique ID
    object_id = f"fork_{uuid.uuid4().hex[:8]}"
    new_glb_filename = f"{object_id}.glb"
    new_glb_path = os.path.join(downloads_folder, new_glb_filename)
    shutil.copy2(source_glb, new_glb_path)

    display_name = name or f"{glb_name} @ {sv}"

    # Record in session state
    save_trellis_object_to_session(user_id, session_id, object_id, new_glb_filename, display_name, seed=0)

    return jsonify({
        'object_id': object_id,
        'glb_url': f'/trellis/downloads/{session_id}/{new_glb_filename}',
        'glb_filename': new_glb_filename,
        'name': display_name,
    })


@app.route('/trellis/get_sliders', methods=['POST'])
def get_sliders():
    """Return all existing sliders for a GLB asset with their build status."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    glb_filename = data.get('glb_filename')

    if not session_id or not user_id or not glb_filename:
        return jsonify({'error': 'session_id, user_id, and glb_filename are required'}), 400

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    glb_name = glb_filename[:-4]  # strip .glb
    slider_info_path = os.path.join(downloads_folder, f'{glb_name}_sliders.json')

    if not os.path.exists(slider_info_path):
        return jsonify({'sliders': []})

    with open(slider_info_path, 'r') as f:
        slider_info = json.load(f)

    result = []
    for idx_str, entry in slider_info.items():
        slider_idx = int(idx_str)
        slider_map_dir = os.path.join(downloads_folder, f'{glb_name}_slider_map_{slider_idx}')
        lpips_path = find_lpips_curve(slider_map_dir)
        slider_entry = {
            'slider_index': slider_idx,
            'object': entry.get('object', ''),
            'attribute': entry.get('attribute', ''),
            'neg_prompt': entry.get('neg_prompt', ''),
            'pos_prompt': entry.get('pos_prompt', ''),
            'glb_filename': glb_filename,
            'complete': lpips_path is not None,
        }
        if slider_entry['complete']:
            anchors = read_anchors_from_lpips(lpips_path)
            # Append per-anchor Y-rotation (3rd element) from stored rotations
            anchor_rotations = entry.get('anchor_rotations', {})
            slider_entry['anchors'] = [
                [a[0], a[1], anchor_rotations.get(a[0], 0)]
                for a in anchors
            ]
            # Check availability for origin toggle
            origin_recon_path = os.path.join(slider_map_dir, 'search_at_0.00000', 'output.glb')
            original_glb_path = os.path.join(downloads_folder, glb_filename)
            slider_entry['has_origin_recon'] = os.path.exists(origin_recon_path)
            slider_entry['has_original'] = os.path.exists(original_glb_path)
        else:
            slider_entry['anchors'] = []
        result.append(slider_entry)

    return jsonify({'sliders': result})


@app.route('/trellis/set_anchor_rotation', methods=['POST'])
def set_anchor_rotation():
    """Persist a Y-rotation correction for a specific slider anchor."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    glb_filename = data.get('glb_filename')
    slider_index = data.get('slider_index')
    slider_value = data.get('slider_value')
    y_rotation = data.get('y_rotation', 0)

    if not all([session_id, user_id, glb_filename, slider_index is not None, slider_value is not None]):
        return jsonify({'error': 'Missing required fields'}), 400

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    glb_name = glb_filename[:-4]
    slider_info_path = os.path.join(downloads_folder, f'{glb_name}_sliders.json')

    if not os.path.exists(slider_info_path):
        return jsonify({'error': 'Slider info not found'}), 404

    with open(slider_info_path, 'r') as f:
        slider_info = json.load(f)

    idx_str = str(slider_index)
    if idx_str not in slider_info:
        return jsonify({'error': f'Slider index {slider_index} not found'}), 404

    entry = slider_info[idx_str]
    if 'anchor_rotations' not in entry:
        entry['anchor_rotations'] = {}
    entry['anchor_rotations'][str(slider_value)] = y_rotation

    with open(slider_info_path, 'w') as f:
        json.dump(slider_info, f, indent=2)

    return jsonify({'ok': True})


def filter_best_views(best_views_target, target_prompt, best_view_dir, N=10):
    # the goal is to get N verified good images from the ranked list of views
    # the function is a duplicate of the function in val_editing.py
    verified_good_images = []
    for i, (view_image_path, score) in enumerate(best_views_target):
        print(f"Checking image {view_image_path} with editing prompt: {target_prompt}...")
        time_start = time.time()
        result = editing_prompt_view_filtering(target_prompt, view_image_path)
        total_time = time.time() - time_start
        print(f"Result: {result}")
        print(f"Time taken: {total_time:.2f} seconds")
        if result:
            verified_good_images.append((view_image_path, score))
            if len(verified_good_images) >= N:
                break
    print(f"Found {len(verified_good_images)} verified good images after checking {i+1} views")
    for j, (view_path, score) in enumerate(verified_good_images):
        shutil.copy(view_path, os.path.join(best_view_dir, f'best_{j}_{os.path.basename(view_path).split(".")[0]}_{score:.2f}.png'))
    verified_best_view_paths = [os.path.join(best_view_dir, f) for f in os.listdir(best_view_dir) if f.endswith(".png")]
    verified_best_view_paths.sort(key=lambda x: int(os.path.basename(x).split("_")[1]))
    return verified_good_images

def edit_best_views(best_view_paths, sub_out_dir, neg_prompt, pos_prompt):
    reassurance_prompt = (
        " Do not change any other attributes of the object and its background that are irrelevant to the editing. "
        "If the part that is supposed to be edited is not visible in the image, do not edit it."
    )

    def _edit_single(best_view_path, prompt, suffix):
        base = '.'.join(os.path.basename(best_view_path).split(".")[:-1])
        edited_name = f"{base}{suffix}"
        out_path = os.path.join(sub_out_dir, edited_name)
        if os.path.exists(out_path):
            print(f"Skipping {out_path} because it already exists")
            return
        print(f"Editing view {os.path.basename(best_view_path)} with prompt: {prompt[:60]}...")
        start_time = time.time()
        edited_image = edit_image_gpt_image(best_view_path, prompt + reassurance_prompt)
        edited_image.save(out_path)
        print(f"Edited {edited_name} in {time.time() - start_time:.1f}s")

    from concurrent.futures import ThreadPoolExecutor, as_completed
    futures = []
    with ThreadPoolExecutor() as executor:
        for best_view_path in best_view_paths:
            futures.append(executor.submit(_edit_single, best_view_path, neg_prompt, '_edited_neg.png'))
            futures.append(executor.submit(_edit_single, best_view_path, pos_prompt, '_edited_pos.png'))
        for future in as_completed(futures):
            future.result()  # raise any exceptions

@app.route('/trellis/pool_status', methods=['GET'])
def pool_status():
    """Return how many pools are available for new slider jobs."""
    with _active_jobs_lock:
        active = _active_jobs
    return jsonify({
        'max_concurrent': MAX_CONCURRENT_SLIDERS,
        'active_jobs': active,
        'available': MAX_CONCURRENT_SLIDERS - active,
    })


@socketio.on('create_slider')
def handle_create_slider(data):
    """Validate and dispatch slider creation to a background thread."""
    glb_filename = data.get('glb_filename', '').strip()
    object_name = data.get('object', '').strip()
    attribute = data.get('attribute', '').strip()
    request_id = data.get('request_id', '')

    if not glb_filename or not object_name or not attribute:
        emit('slider_error', {'error': 'glb_filename, object, and attribute are required', 'request_id': request_id})
        return
    if not data.get('session_id') or not data.get('user_id'):
        emit('slider_error', {'error': 'session_id and user_id are required', 'request_id': request_id})
        return

    sid = request.sid  # capture socket ID for emitting from background thread
    socketio.start_background_task(_create_slider_work, data, sid, request_id)


def _create_slider_work(data, sid, request_id):
    """Background worker: acquire a GPU pool, build the slider, release the pool."""
    glb_filename = data['glb_filename'].strip()
    object_name = data['object'].strip()
    attribute = data['attribute'].strip()
    slider_index = data.get('slider_index', 0)
    num_samples = data.get('num_samples', NUM_SAMPLES)
    session_id = data['session_id']
    user_id = data['user_id']

    def progress(step, message, skipped=False):
        socketio.emit('slider_progress', {
            'slider_index': slider_index,
            'step': step,
            'message': message,
            'skipped': skipped,
            'request_id': request_id,
        }, to=sid)

    print(f"Create slider: asset={glb_filename}, object={object_name}, attribute={attribute} "
          f"(session={session_id}, user={user_id}, request_id={request_id})")

    # Acquire a GPU pool (blocks until one is free)
    progress(0, 'Waiting for a GPU pool...')
    pool, pool_lock, pool_idx = acquire_gpu_pool()
    print(f"Acquired GPU pool {pool_idx} for request {request_id}")

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    view_image_dir = os.path.join(downloads_folder, glb_filename[:-4] + '_views')
    best_view_dir = os.path.join(downloads_folder, glb_filename[:-4] + f'_best_views_slider_{slider_index}')
    os.makedirs(best_view_dir, exist_ok=True)
    edited_image_dir = os.path.join(downloads_folder, glb_filename[:-4] + f'_edited_views_slider_{slider_index}')
    os.makedirs(edited_image_dir, exist_ok=True)
    slider_map_dir = os.path.join(downloads_folder, glb_filename[:-4] + f'_slider_map_{slider_index}')
    os.makedirs(slider_map_dir, exist_ok=True)

    # Flag file paths for each step
    prompts_done_flag = os.path.join(downloads_folder, glb_filename[:-4] + f'_slider_{slider_index}_prompts.done')
    best_views_done_flag = os.path.join(best_view_dir, '.done')
    editing_done_flag = os.path.join(edited_image_dir, '.done')
    slider_map_done_flag = os.path.join(slider_map_dir, '.done')
    slider_info_path = os.path.join(downloads_folder, glb_filename[:-4] + '_sliders.json')

    try:
        # step 1. make positive and negative prompt:
        if os.path.exists(prompts_done_flag):
            with open(slider_info_path, 'r') as f:
                slider_info = json.load(f)
            cached = slider_info[str(slider_index)]
            neg_prompt, pos_prompt = cached['neg_prompt'], cached['pos_prompt']
            print(f"Step 1. SKIPPED (cached) — neg: {neg_prompt}, pos: {pos_prompt}")
            progress(1, 'Generating prompts — skipped (cached)', skipped=True)
        else:
            progress(1, 'Generating negative and positive prompts...')
            print(f"Step 1. Generating negative and positive prompts...")
            neg_prompt, pos_prompt = direction_generator_edit(object_name, attribute)
            if not neg_prompt.endswith('.'):
                neg_prompt += '.'
            if not pos_prompt.endswith('.'):
                pos_prompt += '.'
            print(f"Negative prompt: {neg_prompt}")
            print(f"Positive prompt: {pos_prompt}")

            # Save to slider info so prompts can be reloaded on skip
            if os.path.exists(slider_info_path):
                with open(slider_info_path, 'r') as f:
                    slider_info = json.load(f)
            else:
                slider_info = {}
            slider_info[str(slider_index)] = {
                'object': object_name,
                'attribute': attribute,
                'neg_prompt': neg_prompt,
                'pos_prompt': pos_prompt,
            }
            with open(slider_info_path, 'w') as f:
                json.dump(slider_info, f, indent=2)

            open(prompts_done_flag, 'w').close()

        # step 2 + 2.5. generate and filter best views:
        if os.path.exists(best_views_done_flag):
            print(f"Step 2/2.5. SKIPPED (cached)")
            progress(2, 'Selecting & filtering best views — skipped (cached)', skipped=True)
        else:
            if os.path.exists(best_view_dir):
                shutil.rmtree(best_view_dir)
            os.makedirs(best_view_dir, exist_ok=True)

            progress(2, 'Selecting best views...')
            print(f"Step 2. Generating best views...")
            best_views_target = select_best_views_by_ImageReward(rm_model, pos_prompt, view_image_dir)
            best_views_target.sort(key=lambda x: x[1], reverse=True)
            print(f"# Best views: {len(best_views_target)}")

            progress(2, 'Filtering best views...')
            print(f"Step 2.5. Filtering best views...")
            filter_best_views(best_views_target, pos_prompt, best_view_dir, N=10)
            print(f"Step 2/2.5 done.")

            open(best_views_done_flag, 'w').close()

        # Collect best view paths for step 3
        filtered_best_view_paths = sorted(
            [os.path.join(best_view_dir, f) for f in os.listdir(best_view_dir) if f.endswith('.png')],
            key=lambda x: int(os.path.basename(x).split('_')[1])
        )

        # step 3. edit the images:
        if os.path.exists(editing_done_flag):
            print(f"Step 3. SKIPPED (cached)")
            progress(3, 'Editing images — skipped (cached)', skipped=True)
        else:
            if os.path.exists(edited_image_dir):
                shutil.rmtree(edited_image_dir)
            os.makedirs(edited_image_dir, exist_ok=True)

            progress(3, 'Editing images...')
            print(f"Step 3. Editing images...")
            edit_best_views(filtered_best_view_paths, edited_image_dir, neg_prompt, pos_prompt)
            print(f"Editing images done.")

            open(editing_done_flag, 'w').close()

        # step 4. save the slider map (GPU-heavy — this is where the pool is needed):
        if os.path.exists(slider_map_done_flag):
            print(f"Step 4. SKIPPED (cached)")
            progress(4, 'Saving slider map — skipped (cached)', skipped=True)
        else:
            print(f"Step 4. building slider map...")
            progress(4, 'Building slider map...')
            pool.set_conds(view_image_dir, edited_image_dir)
            slider_mapping.get_lpips_curve_gradient_based(
                view_image_dir,
                edited_image_dir,
                (neg_prompt, pos_prompt),
                [5, -5],
                slider_map_dir,
                gpu_ids=pool.gpu_ids,
                n_samples=num_samples,
                pool=pool,
                need_glb=True,
            )
            print(f"Slider map saved.")
            open(slider_map_done_flag, 'w').close()

        # step 5. read initial anchor points from lpips curve:
        lpips_path = find_lpips_curve(slider_map_dir)
        if not lpips_path:
            lpips_path = os.path.join(slider_map_dir, f"lpips_curve_gradient_{num_samples}.txt")
        progress(5, 'Reading anchor points from LPIPS curve...')
        anchors = read_anchors_from_lpips(lpips_path)
        # Preserve any existing per-anchor Y-rotations (relevant when resuming)
        anchor_rotations = slider_info.get(str(slider_index), {}).get('anchor_rotations', {})
        anchors = [[a[0], a[1], anchor_rotations.get(a[0], 0)] for a in anchors]
        print(f"Initial anchor points: {anchors}")

        socketio.emit('slider_complete', {
            'success': True,
            'glb_filename': glb_filename,
            'object': object_name,
            'attribute': attribute,
            'slider_index': slider_index,
            'neg_prompt': neg_prompt,
            'pos_prompt': pos_prompt,
            'anchors': anchors,
            'request_id': request_id,
        }, to=sid)

    except Exception as e:
        print(f"Create slider error: {e}")
        import traceback
        traceback.print_exc()
        socketio.emit('slider_error', {'error': str(e), 'slider_index': slider_index, 'request_id': request_id}, to=sid)
    finally:
        release_gpu_pool(pool_lock)
        print(f"Released GPU pool {pool_idx} for request {request_id}")

@socketio.on('add_anchor_point')
def handle_add_anchor_point(data):
    """Validate and dispatch anchor point addition to a background thread."""
    print(f"[add_anchor_point] Received: {data}")
    slider_index = data.get('slider_index', 0)
    request_id = data.get('request_id', '')

    if not data.get('glb_filename', '').strip():
        emit('anchor_point_error', {'error': 'glb_filename is required', 'slider_index': slider_index, 'request_id': request_id})
        return
    if not data.get('session_id') or not data.get('user_id'):
        emit('anchor_point_error', {'error': 'session_id and user_id are required', 'slider_index': slider_index, 'request_id': request_id})
        return

    sid = request.sid
    socketio.start_background_task(_add_anchor_work, data, sid, request_id)


def _add_anchor_work(data, sid, request_id):
    """Background worker: acquire a GPU pool, add anchor, release the pool."""
    slider_index = data.get('slider_index', 0)
    session_id = data['session_id']
    user_id = data['user_id']
    glb_filename = data['glb_filename'].strip()
    percentage = float(data.get('percentage', 0))

    pool, pool_lock, pool_idx = acquire_gpu_pool()
    print(f"Acquired GPU pool {pool_idx} for anchor request {request_id}")

    try:
        downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
        glb_name = glb_filename[:-4]
        view_image_dir = os.path.join(downloads_folder, glb_name + '_views')
        edited_image_dir = os.path.join(downloads_folder, glb_name + f'_edited_views_slider_{slider_index}')
        slider_map_dir = os.path.join(downloads_folder, glb_name + f'_slider_map_{slider_index}')

        lpips_path = find_lpips_curve(slider_map_dir)
        if lpips_path is None:
            socketio.emit('anchor_point_error', {'error': 'Slider not built yet', 'slider_index': slider_index, 'request_id': request_id}, to=sid)
            return

        # Read prompts from slider info
        slider_info_path = os.path.join(downloads_folder, glb_name + '_sliders.json')
        with open(slider_info_path, 'r') as f:
            slider_info = json.load(f)

        # Convert from UI scale (-100..100) to backend scale (0..100)
        backend_percentage = (percentage + 100) / 2
        socketio.emit('anchor_point_progress', {'slider_index': slider_index, 'message': f'Generating anchor at {percentage:.0f}%...', 'request_id': request_id}, to=sid)

        pool.set_conds(view_image_dir, edited_image_dir)
        sv, raw_lpips, valid = slider_mapping.get_slider_value_from_lpips_percentage(
            lpips_curve_path=lpips_path,
            percentage=backend_percentage,
            view_images_dir=view_image_dir,
            edited_images_dir=edited_image_dir,
            editing_prompt_pair=(slider_info[str(slider_index)]['neg_prompt'], slider_info[str(slider_index)]['pos_prompt']),
            out_dir=slider_map_dir,
            gpu_ids=pool.gpu_ids,
            pool=pool,
            relax=RELAX,
        )

        if sv is None:
            socketio.emit('anchor_point_error', {
                'error': f'Could not generate a valid anchor at {percentage:.0f}%',
                'slider_index': slider_index,
                'request_id': request_id,
            }, to=sid)
            return

        # Append the new point to the lpips curve file and re-read all anchors
        append_anchor_to_lpips(lpips_path, sv, raw_lpips)
        anchors = read_anchors_from_lpips(lpips_path)

        # Preserve existing per-anchor Y-rotations
        anchor_rotations = slider_info.get(str(slider_index), {}).get('anchor_rotations', {})
        anchors = [[a[0], a[1], anchor_rotations.get(a[0], 0)] for a in anchors]

        print(f"Added anchor at {percentage}%: sv={sv:.5f}, raw_lpips={raw_lpips:.5f}")

        socketio.emit('anchor_point_complete', {
            'success': True,
            'slider_index': slider_index,
            'anchors': anchors,
            'request_id': request_id,
        }, to=sid)

    except Exception as e:
        print(f"Add anchor point error: {e}")
        import traceback
        traceback.print_exc()
        socketio.emit('anchor_point_error', {'error': str(e), 'slider_index': slider_index, 'request_id': request_id}, to=sid)
    finally:
        release_gpu_pool(pool_lock)
        print(f"Released GPU pool {pool_idx} for anchor request {request_id}")

    


def _pin_text_cond_model_to_device(pipeline, device):
    """Work around a TRELLIS bug: Pipeline.to() only moves self.models, leaving
    text_cond_model (and hardcoded .cuda() calls in encode_text) on cuda:0.
    On any non-zero device this causes a cuda:0/cuda:N mismatch at inference.
    Here we move the text encoder and rebind encode_text to use self.device.
    """
    tcm = getattr(pipeline, 'text_cond_model', None)
    if tcm is None:
        return
    tcm['model'].to(device)

    @torch.no_grad()
    def encode_text(self, text):
        encoding = self.text_cond_model['tokenizer'](
            text, max_length=77, padding='max_length',
            truncation=True, return_tensors='pt',
        )
        tokens = encoding['input_ids'].to(self.device)
        return self.text_cond_model['model'](input_ids=tokens).last_hidden_state

    import types
    pipeline.encode_text = types.MethodType(encode_text, pipeline)
    # null_cond was computed on cuda:0 at load time — recompute on the new device
    tcm['null_cond'] = pipeline.encode_text([''])


if __name__ == '__main__':
    pipeline_device = f"cuda:{args.gpu}"
    print(f"Loading Trellis Text-to-3D pipeline on {pipeline_device}...")
    # Match what _pool_worker_loop does: set the current CUDA device so
    # subsequent .to() / model init lands in the right context for spconv.
    torch.cuda.set_device(args.gpu)
    pipeline = TrellisTextTo3DPipeline.from_pretrained("microsoft/TRELLIS-text-large")
    pipeline.to(device=pipeline_device)
    _pin_text_cond_model_to_device(pipeline, pipeline_device)
    print("Trellis pipeline ready.")

    rm_model = get_ImageReward_model()

    print(f"Starting {len(POOL_CONFIGS)} GPU worker pools...")
    for i, cfg in enumerate(POOL_CONFIGS):
        print(f"  Pool {i}: gpus={cfg['gpu_ids']}, workers_per_gpu={cfg['workers_per_gpu']}")
        p = slider_mapping.GPUWorkerPool(cfg['gpu_ids'], workers_per_gpu=cfg['workers_per_gpu'])
        gpu_pools.append(p)
        _pool_locks.append(threading.Lock())
        atexit.register(p.shutdown)
    _pool_semaphore = threading.Semaphore(len(gpu_pools))
    print(f"All {len(gpu_pools)} GPU worker pools ready (max {MAX_CONCURRENT_SLIDERS} concurrent sliders).")

    socketio.run(app, host='0.0.0.0', port=args.port, debug=False, allow_unsafe_werkzeug=True)
