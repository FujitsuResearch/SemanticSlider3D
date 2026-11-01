"""Path resolution for ss3d_utils.

ss3d_utils used to live at TRELLIS/ss3d_utils/, so every module derived the
TRELLIS root as "my parent directory" via os.path.dirname(os.path.dirname(
__file__)). After the move to <repo>/ss3d_utils/ that expression resolves to the
repo root instead, silently breaking the Blender render script path and the
`from utils import sphere_hammersley_sequence` import.

This module centralises the resolution so there is exactly one place to change.
It mirrors the convention in ml_servers/config.py: an SS3D_ environment variable
wins, otherwise fall back to a layout-relative default.
"""
import os

# <repo>/ss3d_utils/_paths.py -> <repo>/ss3d_utils -> <repo>
UTILS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(UTILS_DIR)

# TRELLIS clone. ml_servers/config.py exports the same variable name, so when the
# servers are launched with SS3D_TRELLIS_ROOT set in ml_servers/.env, both agree.
TRELLIS_ROOT = os.environ.get('SS3D_TRELLIS_ROOT', os.path.join(REPO_ROOT, 'TRELLIS'))

# Blender multiview rendering assets, which stayed behind in the TRELLIS clone.
DATASET_TOOLKITS = os.path.join(TRELLIS_ROOT, 'dataset_toolkits')
RENDER_SCRIPT = os.path.join(DATASET_TOOLKITS, 'blender_script', 'render.py')


def load_ss3d_dotenv():
    """Load the API-key .env explicitly.

    A bare dotenv.load_dotenv() walks up from the *calling file's* directory. It
    used to find TRELLIS/.env one level up from TRELLIS/ss3d_utils/; from
    <repo>/ss3d_utils/ it would walk past <repo> to the filesystem root, find
    nothing, and load nothing WITHOUT raising -- so OPENAI_API_KEY would end up
    unset and only surface as a failed API call mid-slider-build.

    Checks <repo>/.env first, then TRELLIS/.env for backward compatibility with
    existing deployments. Returns the path loaded, or None if neither exists.
    """
    from dotenv import load_dotenv

    for candidate in (os.path.join(REPO_ROOT, '.env'),
                      os.path.join(TRELLIS_ROOT, '.env')):
        if os.path.isfile(candidate):
            load_dotenv(candidate)
            return candidate
    return None
