import os
import sys

# Import config FIRST — it loads .env so APP_GPU is populated.
# Then apply CUDA_VISIBLE_DEVICES HERE (not in config.py) so this side effect
# only affects app.py — trellis_server.py imports the same config module and
# must keep all physical GPUs visible.
# Must happen before `import torch` / ultralytics for the pin to take effect.
from config import BASE_DIR, DATA_DIR, SAM3D_ROOT, SAM3D_CKPTS, APP_GPU
if APP_GPU:
    os.environ['CUDA_VISIBLE_DEVICES'] = APP_GPU

import cv2
import numpy as np
import base64
import torch
import uuid
import json
import shutil
import fcntl
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_cors import CORS
from ultralytics.models.sam import SAM2DynamicInteractivePredictor
import logging

# Add sam-3d-objects paths for importing inference module and sam3d_objects
sys.path.append(os.path.join(SAM3D_ROOT, 'notebook'))
sys.path.append(SAM3D_ROOT)

try:
    from inference import Inference, load_image, load_mask
    INFERENCE_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Could not import inference modules: {e}")
    INFERENCE_AVAILABLE = False

TEMPLATE_DIR = os.path.join(BASE_DIR, 'templates')
os.makedirs(DATA_DIR, exist_ok=True)

# Session management: { session_id: { user_id, upload_folder, downloads_folder, state... } }
active_sessions = {}

def get_session_folders(user_id: str, session_id: str):
    """Get or create session-specific folders."""
    session_dir = os.path.join(DATA_DIR, user_id, session_id)
    upload_folder = os.path.join(session_dir, 'uploads')
    downloads_folder = os.path.join(session_dir, 'downloads')
    os.makedirs(upload_folder, exist_ok=True)
    os.makedirs(downloads_folder, exist_ok=True)
    return upload_folder, downloads_folder

def get_session_state_path(user_id: str, session_id: str):
    """Get path to session state JSON file."""
    return os.path.join(DATA_DIR, user_id, session_id, 'session_state.json')

def save_session_state(session_data: dict):
    """Save session state to disk for persistence.

    Merges finished_objects from disk before writing, so that objects added
    by other processes (e.g. the trellis server) are not lost.
    """
    state_path = get_session_state_path(session_data['user_id'], session_data['session_id'])
    lock_path = state_path + '.lock'

    with open(lock_path, 'w') as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            # Merge finished_objects: keep entries from disk that aren't in our in-memory list
            # but skip any that were explicitly deleted this session
            memory_objects = list(session_data.get('finished_objects', []))
            memory_ids = {obj['object_index'] for obj in memory_objects}
            deleted_ids = session_data.get('deleted_object_ids', set())

            if os.path.exists(state_path):
                try:
                    with open(state_path, 'r') as f:
                        disk_state = json.load(f)
                    for obj in disk_state.get('finished_objects', []):
                        if obj['object_index'] not in memory_ids and obj['object_index'] not in deleted_ids:
                            memory_objects.append(obj)
                            memory_ids.add(obj['object_index'])
                    # Also preserve object_states written by /save_object_states
                    disk_object_states = disk_state.get('object_states')
                except Exception:
                    disk_object_states = None
            else:
                disk_object_states = None

            # Update in-memory session to stay in sync
            session_data['finished_objects'] = memory_objects

            # Create a serializable copy (exclude non-serializable fields)
            state_to_save = {
                'session_id': session_data['session_id'],
                'user_id': session_data['user_id'],
                'current_object_index': session_data['current_object_index'],
                'processed_points_count': session_data['processed_points_count'],
                'merged_objects': {str(k): v for k, v in session_data['merged_objects'].items()},
                'current_image_path': session_data['current_image_path'],
                'created_at': session_data['created_at'],
                'updated_at': datetime.now().isoformat(),
                # Store list of finished objects for gallery restoration
                'finished_objects': memory_objects,
                'deleted_object_ids': list(deleted_ids),
            }

            # Preserve object_states from disk if present
            if disk_object_states is not None:
                state_to_save['object_states'] = disk_object_states

            with open(state_path, 'w') as f:
                json.dump(state_to_save, f, indent=2)
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)

def load_session_state(user_id: str, session_id: str):
    """Load session state from disk."""
    state_path = get_session_state_path(user_id, session_id)
    if not os.path.exists(state_path):
        return None
    
    try:
        with open(state_path, 'r') as f:
            state = json.load(f)
        # Convert merged_objects keys back to int
        state['merged_objects'] = {int(k): v for k, v in state.get('merged_objects', {}).items()}
        return state
    except Exception as e:
        print(f"Error loading session state: {e}")
        return None

COMMONS_DIR = os.path.join(DATA_DIR, 'commons')

def copy_commons_to_session(downloads_folder: str):
    """Copy all commons objects into a new session's downloads folder.

    Returns the list of finished_objects from commons session_state.json,
    or an empty list if commons doesn't exist.
    """
    commons_state_path = os.path.join(COMMONS_DIR, 'session_state.json')
    if not os.path.exists(commons_state_path):
        return []

    try:
        with open(commons_state_path, 'r') as f:
            commons_state = json.load(f)
    except Exception as e:
        print(f"Warning: Could not read commons session_state.json: {e}")
        return []

    finished_objects = commons_state.get('finished_objects', [])
    if not finished_objects:
        return []

    # Copy all files and directories from commons (except session_state.json)
    for item_name in os.listdir(COMMONS_DIR):
        if item_name == 'session_state.json':
            continue
        src = os.path.join(COMMONS_DIR, item_name)
        dst = os.path.join(downloads_folder, item_name)
        try:
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        except Exception as e:
            print(f"Warning: Failed to copy commons item {item_name}: {e}")

    print(f"Copied {len(finished_objects)} commons objects to {downloads_folder}")
    return finished_objects


def build_commons_gallery_items(finished_objects: list, session_id: str, downloads_folder: str):
    """Build gallery items for commons objects so they can be displayed immediately."""
    gallery_items = []
    for obj in finished_objects:
        obj_idx = obj['object_index']
        glb_filename = obj.get('glb_filename', f'{obj_idx}.glb')
        glb_path = os.path.join(downloads_folder, glb_filename)
        if not os.path.exists(glb_path):
            print(f"Warning: Commons GLB for {obj_idx} not found at {glb_path}, skipping")
            continue
        gallery_items.append({
            'object_index': obj_idx,
            'source': 'commons',
            'prompt': obj.get('prompt', ''),
            'is_combined': False,
            'has_3d': True,
            'glb_url': f"/trellis/downloads/{session_id}/{glb_filename}",
        })
    return gallery_items


def get_or_create_session(user_id: str, session_id: str = None):
    """Get existing session or create a new one."""
    if session_id and session_id in active_sessions:
        return active_sessions[session_id]
    
    # Create new session
    new_session_id = session_id or datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:6]
    upload_folder, downloads_folder = get_session_folders(user_id, new_session_id)
    
    # Copy commons objects into the new session
    commons_objects = copy_commons_to_session(downloads_folder)

    session_data = {
        'session_id': new_session_id,
        'user_id': user_id,
        'upload_folder': upload_folder,
        'downloads_folder': downloads_folder,
        'current_object_index': 0,
        'processed_points_count': 0,
        'merged_objects': {},
        'current_image_path': None,
        'created_at': datetime.now().isoformat(),
        'finished_objects': commons_objects  # Seed with commons objects
    }

    active_sessions[new_session_id] = session_data
    save_session_state(session_data)
    print(f"Created new session: {new_session_id} for user: {user_id}")
    return session_data

def resume_session(user_id: str, session_id: str):
    """Resume an existing session from disk."""
    # Check if already active — reload finished_objects from disk in case
    # the trellis server added objects since we last loaded
    if session_id in active_sessions:
        saved_state = load_session_state(user_id, session_id)
        if saved_state:
            active_sessions[session_id]['finished_objects'] = saved_state.get('finished_objects', [])
            active_sessions[session_id]['deleted_object_ids'] = set(saved_state.get('deleted_object_ids', []))
        return active_sessions[session_id]

    # Try to load from disk
    saved_state = load_session_state(user_id, session_id)
    if not saved_state:
        return None

    upload_folder, downloads_folder = get_session_folders(user_id, session_id)

    session_data = {
        'session_id': session_id,
        'user_id': user_id,
        'upload_folder': upload_folder,
        'downloads_folder': downloads_folder,
        'current_object_index': saved_state.get('current_object_index', 0),
        'processed_points_count': 0,  # Reset this as predictor state is not persisted
        'merged_objects': saved_state.get('merged_objects', {}),
        'current_image_path': saved_state.get('current_image_path'),
        'created_at': saved_state.get('created_at', datetime.now().isoformat()),
        'finished_objects': saved_state.get('finished_objects', []),
        'deleted_object_ids': set(saved_state.get('deleted_object_ids', []))
    }
    
    active_sessions[session_id] = session_data
    print(f"Resumed session: {session_id} for user: {user_id}")
    return session_data

# Legacy global variables (for backward compatibility during transition)
current_object_index = 0
processed_points_count = 0
merged_objects = {}

app = Flask(__name__, template_folder=TEMPLATE_DIR)
CORS(app)  # Enable CORS for React dev server

# Configure logging
logging.basicConfig(level=logging.DEBUG)
app.logger.setLevel(logging.DEBUG)

print(f"App initialized.")
print(f"Base Dir: {BASE_DIR}")
print(f"Data Dir: {DATA_DIR}")
print(f"Template Dir: {TEMPLATE_DIR}")
print(f"GPU (SS3D_APP_GPU): {APP_GPU or '<default: all visible>'}")

# Initialize SAM2 Predictor
overrides = dict(conf=0.01, task="segment", mode="predict", imgsz=1024, model="sam2_t.pt", save=False)
try:
    predictor = SAM2DynamicInteractivePredictor(overrides=overrides, max_obj_num=100)
    print("SAM2 Predictor initialized successfully.")
except Exception as e:
    print(f"Error initializing predictor: {e}")
    predictor = None

# Initialize 3D Inference Model
inference_model = None

def get_inference_model():
    global inference_model
    if inference_model is None and INFERENCE_AVAILABLE:
        try:
            print("Initializing 3D Inference Model (Lazy Load)...")
            tag = "hf"
            # Adjust path to point to checkpoints correctly
            config_path = os.path.join(SAM3D_CKPTS, tag, 'pipeline.yaml')
            inference_model = Inference(config_path, compile=False)
            print("3D Inference Model initialized successfully.")
        except Exception as e:
            print(f"Error initializing 3D inference model: {e}")
            inference_model = None
    return inference_model

current_image_path = None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/favicon.ico')
def favicon():
    return "", 204

@app.route('/start_session', methods=['POST'])
def start_session():
    """Start a new session for a user."""
    data = request.json
    user_id = data.get('user_id', '').strip()
    
    if not user_id:
        return jsonify({'error': 'User ID is required'}), 400
    
    # Sanitize user_id (only allow alphanumeric, underscore, dash)
    import re
    if not re.match(r'^[a-zA-Z0-9_-]+$', user_id):
        return jsonify({'error': 'User ID can only contain letters, numbers, underscores, and dashes'}), 400
    
    session_data = get_or_create_session(user_id)

    # Build gallery items for any commons objects that were copied
    gallery_items = build_commons_gallery_items(
        session_data.get('finished_objects', []),
        session_data['session_id'],
        session_data['downloads_folder'],
    )

    return jsonify({
        'session_id': session_data['session_id'],
        'user_id': session_data['user_id'],
        'message': f'Session started for user {user_id}',
        'gallery_items': gallery_items,
    })

@app.route('/get_user_sessions/<user_id>', methods=['GET'])
def get_user_sessions_route(user_id):
    """List all sessions for a user with detailed info."""
    user_dir = os.path.join(DATA_DIR, user_id)
    if not os.path.exists(user_dir):
        return jsonify({'sessions': []})
    
    sessions = []
    for session_dir in sorted(os.listdir(user_dir), reverse=True):
        session_path = os.path.join(user_dir, session_dir)
        if os.path.isdir(session_path):
            # Load session state if available
            saved_state = load_session_state(user_id, session_dir)
            
            # Count files
            uploads_dir = os.path.join(session_path, 'uploads')
            downloads_dir = os.path.join(session_path, 'downloads')
            uploads = os.listdir(uploads_dir) if os.path.exists(uploads_dir) else []
            downloads = os.listdir(downloads_dir) if os.path.exists(downloads_dir) else []
            
            # Get image filename if exists
            image_files = [f for f in uploads if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
            
            session_info = {
                'session_id': session_dir,
                'upload_count': len(uploads),
                'download_count': len(downloads),
                'object_count': len(saved_state.get('finished_objects', [])) if saved_state else 0,
                'created_at': saved_state.get('created_at', '') if saved_state else '',
                'updated_at': saved_state.get('updated_at', '') if saved_state else '',
                'has_image': len(image_files) > 0,
                'image_name': image_files[0] if image_files else None
            }
            sessions.append(session_info)
    
    return jsonify({'sessions': sessions})

@app.route('/resume_session', methods=['POST'])
def resume_session_route():
    """Resume an existing session."""
    data = request.json
    user_id = data.get('user_id', '').strip()
    session_id = data.get('session_id', '').strip()
    
    if not user_id or not session_id:
        return jsonify({'error': 'User ID and Session ID are required'}), 400
    
    session_data = resume_session(user_id, session_id)
    if not session_data:
        return jsonify({'error': 'Session not found or could not be loaded'}), 404
    
    # Get finished objects for gallery restoration
    finished_objects = session_data.get('finished_objects', [])
    
    # Generate thumbnails for each finished object
    gallery_items = []
    for obj in finished_objects:
        obj_idx = obj['object_index']

        # Handle commons objects (copied from shared commons directory)
        if obj.get('source') == 'commons':
            glb_filename = obj.get('glb_filename', f'{obj_idx}.glb')
            glb_path = os.path.join(session_data['downloads_folder'], glb_filename)
            if not os.path.exists(glb_path):
                print(f"Warning: Commons GLB for {obj_idx} not found at {glb_path}, skipping")
                continue
            gallery_items.append({
                'object_index': obj_idx,
                'source': 'commons',
                'prompt': obj.get('prompt', ''),
                'is_combined': False,
                'has_3d': True,
                'glb_url': f"/trellis/downloads/{session_data['session_id']}/{glb_filename}",
            })
            continue

        # Handle trellis-generated objects (no mask/image needed)
        if obj.get('source') == 'trellis':
            glb_filename = obj.get('glb_filename', f'{obj_idx}.glb')
            glb_path = os.path.join(session_data['downloads_folder'], glb_filename)
            if not os.path.exists(glb_path):
                print(f"Warning: Trellis GLB for {obj_idx} not found at {glb_path}, skipping")
                continue
            gallery_items.append({
                'object_index': obj_idx,
                'source': 'trellis',
                'prompt': obj.get('prompt', ''),
                'is_combined': False,
                'has_3d': True,
                'glb_url': f"/trellis/downloads/{session_data['session_id']}/{glb_filename}",
            })
            continue

        # Handle SAM3D-generated objects (need mask + image for thumbnail)
        mask_path = os.path.join(session_data['downloads_folder'], f'curr_mask_obj_{obj_idx}.png')

        # Use per-object image_path - required for multi-image support
        obj_image_path = obj.get('image_path')

        # Skip objects without image_path - they can't be properly restored
        if not obj_image_path:
            print(f"Warning: Object {obj_idx} missing image_path, skipping (legacy object)")
            continue

        if not os.path.exists(obj_image_path):
            print(f"Warning: Image for object {obj_idx} not found at {obj_image_path}, skipping")
            continue

        if not os.path.exists(mask_path):
            print(f"Warning: Mask for object {obj_idx} not found, skipping")
            continue

        try:
            img_str = generate_thumbnail(obj_image_path, mask_path)
            glb_path = os.path.join(session_data['downloads_folder'], f'object_{obj_idx}.glb')
            has_3d = os.path.exists(glb_path)

            gallery_items.append({
                'object_index': obj_idx,
                'object_image': img_str,
                'is_combined': obj.get('is_combined', False),
                'has_3d': has_3d,
                'glb_url': f"/trellis/downloads/{session_data['session_id']}/object_{obj_idx}.glb" if has_3d else None,
                'image_path': obj_image_path,  # Include so frontend knows which image this object belongs to
                'image_filename': os.path.basename(obj_image_path)  # For display purposes
            })
        except Exception as e:
            print(f"Error generating thumbnail for object {obj_idx}: {e}")
    
    # Get list of all uploaded images in the session
    upload_folder = session_data['upload_folder']
    all_images = []
    if os.path.exists(upload_folder):
        for f in os.listdir(upload_folder):
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
                all_images.append({
                    'filename': f,
                    'path': os.path.join(upload_folder, f)
                })
    
    # Load saved object states (transforms + visibility)
    saved_state = load_session_state(user_id, session_id)
    object_states = saved_state.get('object_states') if saved_state else None

    return jsonify({
        'session_id': session_data['session_id'],
        'user_id': session_data['user_id'],
        'current_image_path': session_data['current_image_path'],
        'image_filename': os.path.basename(session_data['current_image_path']) if session_data['current_image_path'] else None,
        'gallery_items': gallery_items,
        'all_images': all_images,  # List of all images in session
        'object_states': object_states,
        'message': f'Session resumed for user {user_id}'
    })

@app.route('/upload', methods=['POST'])
def upload_file():
    global current_image_path, processed_points_count, current_object_index, merged_objects
    app.logger.info("Upload request received")
    
    session_id = request.form.get('session_id')
    if not session_id or session_id not in active_sessions:
        app.logger.error("Invalid or missing session_id")
        return jsonify({'error': 'Invalid session. Please start a session first.'}), 400
    
    session_data = active_sessions[session_id]
    
    if 'file' not in request.files:
        app.logger.error("No file part")
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        app.logger.error("No selected file")
        return jsonify({'error': 'No selected file'}), 400
    
    filename = file.filename
    filepath = os.path.join(session_data['upload_folder'], filename)
    file.save(filepath)
    
    # Update session state - keep object index and finished objects, only reset current image
    session_data['current_image_path'] = filepath
    session_data['processed_points_count'] = 0
    # Don't reset current_object_index - continue from where we left off
    # Don't reset finished_objects - keep objects from all images
    # Don't reset merged_objects - keep merge relationships
    
    # Also update global for backward compatibility
    current_image_path = filepath
    current_object_index = session_data['current_object_index']
    processed_points_count = 0
    merged_objects = session_data.get('merged_objects', {})
    
    print(f"Image uploaded to: {filepath} (session: {session_id}), continuing from object index {current_object_index}")
    
    # Reset predictor state when new image is uploaded (predictor memory is image-specific)
    if predictor:
        predictor.memory_bank = []
        predictor.obj_idx_set = set()
    
    # Save session state
    save_session_state(session_data)
    
    return jsonify({'message': 'File uploaded successfully', 'filepath': filename})

@app.route('/uploads/<session_id>/<filename>')
def uploaded_file(session_id, filename):
    if session_id not in active_sessions:
        return jsonify({'error': 'Invalid session'}), 404
    return send_from_directory(active_sessions[session_id]['upload_folder'], filename)

@app.route('/downloads/<session_id>/<filename>')
def downloaded_file(session_id, filename):
    if session_id not in active_sessions:
        return jsonify({'error': 'Invalid session'}), 404
    return send_from_directory(active_sessions[session_id]['downloads_folder'], filename)

@app.route('/reset', methods=['POST'])
def reset_state():
    global processed_points_count
    app.logger.info("Reset request received")
    if predictor:
        predictor.memory_bank = []
        predictor.obj_idx_set = set()
        processed_points_count = 0
        print("Predictor memory reset.")
    return jsonify({'status': 'reset'})

@app.route('/segment', methods=['POST'])
def segment():
    global current_image_path, processed_points_count, current_object_index
    app.logger.info("Segment request received")
    
    # Ensure some memory is free
    torch.cuda.empty_cache()

    if not predictor:
        app.logger.error("Predictor not initialized")
        return jsonify({'error': 'Predictor not initialized'}), 500

    data = request.json
    session_id = data.get('session_id')
    points_list = data.get('points', [])
    labels_list = data.get('labels', [])
    
    # Get session data
    if session_id and session_id in active_sessions:
        session_data = active_sessions[session_id]
        current_image_path = session_data['current_image_path']
        processed_points_count = session_data['processed_points_count']
        current_object_index = session_data['current_object_index']
        downloads_folder = session_data['downloads_folder']
    else:
        downloads_folder = os.path.join(BASE_DIR, 'downloads')
        os.makedirs(downloads_folder, exist_ok=True)
    
    if not current_image_path:
        return jsonify({'error': 'No image uploaded'}), 400
    
    app.logger.info(f"Points: {points_list}, Labels: {labels_list}")
    
    if not points_list:
        # Return original image if no points
        img = cv2.imread(current_image_path)
        if img is None:
            return jsonify({'error': 'Failed to read image'}), 500
        _, buffer = cv2.imencode('.jpg', img)
        img_str = base64.b64encode(buffer).decode('utf-8')
        return jsonify({'image': img_str})

    try:
        current_len = len(points_list)
        results = None
        
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            if current_len == processed_points_count + 1:
                new_pt = points_list[-1]
                new_lbl = labels_list[-1]
                results = predictor(
                    source=current_image_path,
                    points=[new_pt],
                    labels=[new_lbl],
                    update_memory=True,
                    obj_ids=[current_object_index]
                )
                processed_points_count = current_len
            else:
                print("Full replay triggered...")
                predictor.memory_bank = []
                predictor.obj_idx_set = set()
                processed_points_count = 0
                
                for pt, lbl in zip(points_list, labels_list):
                    results = predictor(
                        source=current_image_path,
                        points=[pt],
                        labels=[lbl],
                        update_memory=True,
                        obj_ids=[current_object_index]
                    )
                processed_points_count = current_len

        # Update session state
        if session_id and session_id in active_sessions:
            active_sessions[session_id]['processed_points_count'] = processed_points_count

        if not results:
            return jsonify({'error': 'No results generated'}), 500

        result = results[0]
        annotated_frame = result.plot(boxes=False)
        
        if len(result.masks.data) > 0:
            mask = result.masks.data[0].cpu().numpy()
            mask = (mask * 255).astype(np.uint8)
            cv2.imwrite(os.path.join(downloads_folder, f'curr_mask_obj_{current_object_index}.png'), mask)
        else:
            return jsonify({'error': 'No mask generated'}), 500
        
        _, buffer = cv2.imencode('.jpg', annotated_frame)
        cv2.imwrite(os.path.join(downloads_folder, 'annotated_frame.jpg'), annotated_frame)
        img_str = base64.b64encode(buffer).decode('utf-8')
        
        return jsonify({'image': img_str})

    except Exception as e:
        print(f"Segmentation error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/finish_object', methods=['POST'])
def finish_object():
    global current_image_path, current_object_index, processed_points_count
    if not predictor:
        return jsonify({'error': 'State invalid'}), 400

    data = request.json
    session_id = data.get('session_id')
    
    # Get session data
    if session_id and session_id in active_sessions:
        session_data = active_sessions[session_id]
        current_image_path = session_data['current_image_path']
        current_object_index = session_data['current_object_index']
        downloads_folder = session_data['downloads_folder']
    else:
        downloads_folder = os.path.join(BASE_DIR, 'downloads')
    
    if not current_image_path:
        return jsonify({'error': 'No image uploaded'}), 400
    
    try:
        mask_path = os.path.join(downloads_folder, f'curr_mask_obj_{current_object_index}.png')
        if not os.path.exists(mask_path):
            return jsonify({'error': 'No mask found. Please segment first.'}), 400
            
        # Generate thumbnail
        img_str = generate_thumbnail(current_image_path, mask_path)
        
        finished_index = current_object_index
        
        predictor.memory_bank = []
        predictor.obj_idx_set = set()
        current_object_index += 1
        processed_points_count = 0
        
        # Update session state
        if session_id and session_id in active_sessions:
            session_data = active_sessions[session_id]
            session_data['current_object_index'] = current_object_index
            session_data['processed_points_count'] = 0
            
            # Track finished object for session restoration (include image path for multi-image support)
            if 'finished_objects' not in session_data:
                session_data['finished_objects'] = []
            session_data['finished_objects'].append({
                'object_index': finished_index,
                'is_combined': False,
                'image_path': current_image_path  # Store which image this object came from
            })
            
            # Save session state to disk
            save_session_state(session_data)
        
        return jsonify({'object_image': img_str, 'object_index': finished_index, 'is_combined': False})

    except Exception as e:
        print(f"Finish object error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/combine_objects', methods=['POST'])
def combine_objects():
    global current_object_index, merged_objects, current_image_path
    data = request.json
    indices = data.get('indices', [])
    session_id = data.get('session_id')
    
    if len(indices) < 2:
        return jsonify({'error': 'Need at least 2 objects to combine'}), 400
    
    # Get session data
    if session_id and session_id in active_sessions:
        session_data = active_sessions[session_id]
        current_image_path = session_data['current_image_path']
        current_object_index = session_data['current_object_index']
        merged_objects = session_data['merged_objects']
        downloads_folder = session_data['downloads_folder']
    else:
        downloads_folder = os.path.join(BASE_DIR, 'downloads')
        
    try:
        # Load all masks
        masks = []
        for idx in indices:
            path = os.path.join(downloads_folder, f'curr_mask_obj_{idx}.png')
            if os.path.exists(path):
                masks.append(cv2.imread(path, cv2.IMREAD_GRAYSCALE))
            else:
                return jsonify({'error': f'Mask for object {idx} not found'}), 404
        
        # Combine masks (logical OR)
        combined_mask = masks[0]
        for m in masks[1:]:
            combined_mask = cv2.bitwise_or(combined_mask, m)
            
        # Save new mask
        new_index = current_object_index
        new_path = os.path.join(downloads_folder, f'curr_mask_obj_{new_index}.png')
        cv2.imwrite(new_path, combined_mask)
        
        # Track merge
        merged_objects[new_index] = indices
        
        # Generate thumbnail
        img_str = generate_thumbnail(current_image_path, new_path)
        
        current_object_index += 1
        
        # Update session state
        if session_id and session_id in active_sessions:
            session_data = active_sessions[session_id]
            session_data['current_object_index'] = current_object_index
            session_data['merged_objects'] = merged_objects
            
            # Remove combined objects from finished_objects and add new combined object
            if 'finished_objects' not in session_data:
                session_data['finished_objects'] = []
            session_data['finished_objects'] = [
                obj for obj in session_data['finished_objects'] 
                if obj['object_index'] not in indices
            ]
            session_data['finished_objects'].append({
                'object_index': new_index,
                'is_combined': True,
                'image_path': current_image_path  # Store which image this combined object uses
            })
            
            save_session_state(session_data)
        
        return jsonify({'object_image': img_str, 'object_index': new_index, 'is_combined': True})
        
    except Exception as e:
        print(f"Combine error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/uncombine_object', methods=['POST'])
def uncombine_object():
    global merged_objects, current_image_path
    data = request.json
    obj_index = data.get('object_index')
    session_id = data.get('session_id')
    
    # Get session data
    if session_id and session_id in active_sessions:
        session_data = active_sessions[session_id]
        current_image_path = session_data['current_image_path']
        merged_objects = session_data['merged_objects']
        downloads_folder = session_data['downloads_folder']
    else:
        downloads_folder = os.path.join(BASE_DIR, 'downloads')
    
    if obj_index not in merged_objects:
        return jsonify({'error': 'Object is not a combined object'}), 400
        
    original_indices = merged_objects[obj_index]
    restored_objects = []
    
    # Get the combined object's image path to use for restored objects
    combined_obj_image_path = current_image_path
    if session_id and session_id in active_sessions:
        for obj in session_data.get('finished_objects', []):
            if obj['object_index'] == obj_index:
                combined_obj_image_path = obj.get('image_path') or current_image_path
                break
    
    try:
        for idx in original_indices:
            mask_path = os.path.join(downloads_folder, f'curr_mask_obj_{idx}.png')
            if os.path.exists(mask_path):
                img_str = generate_thumbnail(combined_obj_image_path, mask_path)
                is_nested_combined = idx in merged_objects
                restored_objects.append({
                    'object_index': idx, 
                    'object_image': img_str,
                    'is_combined': is_nested_combined,
                    'image_filename': os.path.basename(combined_obj_image_path) if combined_obj_image_path else None
                })
        
        # Remove from merged registry
        del merged_objects[obj_index]
        
        # Update session state
        if session_id and session_id in active_sessions:
            session_data = active_sessions[session_id]
            session_data['merged_objects'] = merged_objects
            
            # Remove combined object and restore original objects with their image paths
            if 'finished_objects' not in session_data:
                session_data['finished_objects'] = []
            session_data['finished_objects'] = [
                obj for obj in session_data['finished_objects'] 
                if obj['object_index'] != obj_index
            ]
            for idx in original_indices:
                is_nested_combined = idx in merged_objects
                session_data['finished_objects'].append({
                    'object_index': idx,
                    'is_combined': is_nested_combined,
                    'image_path': combined_obj_image_path  # Use the combined object's image path
                })
            
            save_session_state(session_data)
        
        return jsonify({'restored_objects': restored_objects})
    except Exception as e:
        print(f"Uncombine error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/delete_object', methods=['POST'])
def delete_object():
    data = request.json
    idx = data.get('object_index')
    session_id = data.get('session_id')
    
    # Remove from finished_objects in session and track as deleted
    if session_id and session_id in active_sessions:
        session_data = active_sessions[session_id]
        if 'finished_objects' in session_data:
            session_data['finished_objects'] = [
                obj for obj in session_data['finished_objects']
                if obj['object_index'] != idx
            ]
            # Track deleted IDs so save_session_state merge won't resurrect them
            if 'deleted_object_ids' not in session_data:
                session_data['deleted_object_ids'] = set()
            session_data['deleted_object_ids'].add(idx)
            save_session_state(session_data)
    
    print(f"Delete object {idx} (session: {session_id})")
    return jsonify({'success': True})

def generate_thumbnail(image_path, mask_path):
    binary_mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    original_img = cv2.imread(image_path)
    h, w = original_img.shape[:2]
    
    if binary_mask.shape != (h, w):
        binary_mask = cv2.resize(binary_mask, (w, h), interpolation=cv2.INTER_NEAREST)
    
    b, g, r = cv2.split(original_img)
    _, binary_mask = cv2.threshold(binary_mask, 127, 255, cv2.THRESH_BINARY)
    rgba = cv2.merge([b, g, r, binary_mask])
        
    contours, _ = cv2.findContours(binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        x, y, w_rect, h_rect = cv2.boundingRect(np.vstack(contours))
        pad = 10
        x = max(0, x - pad)
        y = max(0, y - pad)
        w_rect = min(w - x, w_rect + 2*pad)
        h_rect = min(h - y, h_rect + 2*pad)
        cropped_rgba = rgba[y:y+h_rect, x:x+w_rect]
    else:
        cropped_rgba = rgba
        
    _, buffer = cv2.imencode('.png', cropped_rgba)
    return base64.b64encode(buffer).decode('utf-8')

@app.route('/to_3d', methods=['POST'])
def to_3d():
    global current_image_path
    model = get_inference_model()
    if not INFERENCE_AVAILABLE or model is None:
        return jsonify({'error': '3D Inference model not available'}), 503
        
    data = request.json
    obj_index = data.get('object_index')
    session_id = data.get('session_id')
    
    if obj_index is None:
        return jsonify({'error': 'Object index required'}), 400
    
    # Get session data
    if session_id and session_id in active_sessions:
        session_data = active_sessions[session_id]
        downloads_folder = session_data['downloads_folder']
        
        # Find the image path for this specific object
        obj_image_path = session_data['current_image_path']  # Default to current
        for obj in session_data.get('finished_objects', []):
            if obj['object_index'] == obj_index:
                obj_image_path = obj.get('image_path') or obj_image_path
                break
        current_image_path = obj_image_path
    else:
        downloads_folder = os.path.join(BASE_DIR, 'downloads')
        
    try:
        mask_path = os.path.join(downloads_folder, f'curr_mask_obj_{obj_index}.png')
        if not os.path.exists(mask_path):
            return jsonify({'error': f'Mask for object {obj_index} not found'}), 404
            
        image = load_image(current_image_path)
        mask = load_mask(mask_path)
        
        print(f"Running 3D inference for object {obj_index} (session: {session_id})...")
        
        if predictor:
            predictor.memory_bank = []
            predictor.obj_idx_set = set()
        torch.cuda.empty_cache()
        
        output = model(image, mask, seed=42)
        
        glb_filename = f"object_{obj_index}.glb"
        glb_path = os.path.join(downloads_folder, glb_filename)
        output['glb'].export(glb_path)
        print(f"Saved GLB to {glb_path}")
        
        return jsonify({'glb_url': f'/trellis/downloads/{session_id}/{glb_filename}'})

    except Exception as e:
        print(f"3D Generation error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/resolve_variant', methods=['POST'])
def resolve_variant():
    """Resolve the URL for a slider variant GLB (served from this server to avoid
    GIL contention with the trellis server during slider creation)."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    glb_filename = data.get('glb_filename')
    slider_index = data.get('slider_index')
    slider_value = data.get('slider_value')

    if not all([session_id, user_id, glb_filename, slider_index is not None, slider_value is not None]):
        return jsonify({'error': 'Missing required fields'}), 400

    use_original = data.get('use_original', False)

    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    glb_name = glb_filename[:-4]
    sv = f"{float(slider_value):.5f}"

    # When use_original is true and slider is at origin, serve the original GLB
    if use_original and float(slider_value) == 0.0:
        url = f'/serve_variant/{user_id}/{session_id}/{glb_filename}'
        return jsonify({'url': url})

    variant_path = os.path.join(downloads_folder, f'{glb_name}_slider_map_{slider_index}', f'search_at_{sv}', 'output.glb')

    if os.path.exists(variant_path):
        url = f'/serve_variant/{user_id}/{session_id}/{glb_name}_slider_map_{slider_index}/search_at_{sv}/output.glb'
    else:
        url = f'/serve_variant/{user_id}/{session_id}/{glb_filename}'

    return jsonify({'url': url})


@app.route('/serve_variant/<user_id>/<session_id>/<path:subpath>')
def serve_variant(user_id, session_id, subpath):
    """Serve variant GLBs from the downloads directory (separate from trellis server)."""
    downloads_folder = os.path.join(DATA_DIR, user_id, session_id, 'downloads')
    filepath = os.path.join(downloads_folder, subpath)
    if os.path.exists(filepath):
        return send_from_directory(os.path.dirname(filepath), os.path.basename(filepath))
    return jsonify({'error': 'File not found'}), 404


@app.route('/save_object_states', methods=['POST'])
def save_object_states():
    """Save object transforms and visibility to session state."""
    data = request.json
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    object_states = data.get('object_states')

    if not session_id or not user_id or object_states is None:
        return jsonify({'error': 'Missing required fields'}), 400

    state_path = get_session_state_path(user_id, session_id)
    if not os.path.exists(state_path):
        return jsonify({'error': 'Session not found'}), 404

    lock_path = state_path + '.lock'
    try:
        with open(lock_path, 'w') as lock_f:
            fcntl.flock(lock_f, fcntl.LOCK_EX)
            try:
                with open(state_path, 'r') as f:
                    state = json.load(f)
                state['object_states'] = object_states
                with open(state_path, 'w') as f:
                    json.dump(state, f, indent=2)
            finally:
                fcntl.flock(lock_f, fcntl.LOCK_UN)
        return jsonify({'ok': True})
    except Exception as e:
        print(f"Error saving object states: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/log_behavior', methods=['POST'])
def log_behavior():
    """Log a user behavior event to a JSONL file per session."""
    data = request.json
    if not data:
        return jsonify({'error': 'No data'}), 400

    session_id = data.get('sessionId')
    user_id = data.get('userId')
    if not session_id or not user_id:
        return jsonify({'error': 'Missing sessionId or userId'}), 400

    # Write to a JSONL file in the session's data directory
    log_dir = os.path.join(DATA_DIR, user_id, session_id)
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, 'behavior_log.jsonl')

    with open(log_path, 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps(data) + '\n')
        fcntl.flock(f, fcntl.LOCK_UN)

    return jsonify({'ok': True})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
