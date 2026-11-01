"""
Render multiview images for all search_at_* folders in a slider_map directory.

Usage:
    python render_slider_map_multiviews.py <slider_map_folder> [--output_dir OUTPUT_DIR] [--num_views NUM_VIEWS] [--max_workers MAX_WORKERS]

Example:
    python render_slider_map_multiviews.py <path>
"""

import os
import sys
import argparse
import glob

sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'TRELLIS', 'validation'))
from render_multiviews_blender_mp import get_multi_view_from_3d_assets_mp


def render_slider_map_multiviews(slider_map_folder, output_dir=None, num_views=24, max_workers=None):
    if output_dir is None:
        output_dir = os.path.join(slider_map_folder, 'multiviews')
    os.makedirs(output_dir, exist_ok=True)

    search_dirs = sorted(glob.glob(os.path.join(slider_map_folder, 'search_at_*')))
    if not search_dirs:
        print(f"No search_at_* folders found in {slider_map_folder}")
        return

    for search_dir in search_dirs:
        glb_path = os.path.join(search_dir, 'output.glb')
        if not os.path.isfile(glb_path):
            print(f"Skipping {os.path.basename(search_dir)}: no output.glb")
            continue

        folder_name = os.path.basename(search_dir)
        views_dir = os.path.join(output_dir, folder_name)

        # Skip if already rendered
        if os.path.exists(views_dir) and len([f for f in os.listdir(views_dir) if f.endswith('.png')]) >= num_views:
            print(f"Already rendered: {folder_name}")
            continue

        os.makedirs(views_dir, exist_ok=True)
        print(f"Rendering {num_views} views for {folder_name}...")
        success = get_multi_view_from_3d_assets_mp(
            asset_path=glb_path,
            num_views=num_views,
            out_dir=views_dir,
            max_workers=max_workers,
            eval_mode=True,
        )
        if success:
            print(f"  Done: {views_dir}")
        else:
            print(f"  Failed: {folder_name}")

    print(f"\nAll multiviews saved to {output_dir}")


def render_glb_multiviews(
    glb_path, output_dir, num_views=24, max_workers=None, folder_name=None
):
    if not os.path.isfile(glb_path):
        print(f"File not found: {glb_path}")
        return False

    if folder_name is None:
        folder_name = os.path.splitext(os.path.basename(glb_path))[0]
    views_dir = os.path.join(output_dir, folder_name)

    if (os.path.exists(views_dir)
            and len([f for f in os.listdir(views_dir)
                     if f.endswith('.png')]) >= num_views):
        print(f"Already rendered: {folder_name}")
        return True

    os.makedirs(views_dir, exist_ok=True)
    print(f"Rendering {num_views} views for {glb_path}...")
    success = get_multi_view_from_3d_assets_mp(
        asset_path=glb_path,
        num_views=num_views,
        out_dir=views_dir,
        max_workers=max_workers,
        eval_mode=True,
    )
    if success:
        print(f"  Done: {views_dir}")
    else:
        print(f"  Failed: {glb_path}")
    return success


if __name__ == '__main__':
    NUM_VIEWS = 24
    MAX_WORKERS = int(NUM_VIEWS * 0.2)
    # parser = argparse.ArgumentParser(description='Render multiviews for slider_map search results')
    # parser.add_argument('slider_map_folder', help='Path to the slider_map folder')
    # parser.add_argument('--output_dir', default=None, help='Output directory (default: <slider_map_folder>/multiviews)')
    # parser.add_argument('--num_views', type=int, default=24, help='Number of views to render (default: 24)')
    # parser.add_argument('--max_workers', type=int, default=None, help='Max parallel workers (default: auto)')
    # args = parser.parse_args()
