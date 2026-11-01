import os
import cv2
import numpy as np
import sys
import csv
# Import inference code for 3D lift
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "notebook"))

from inference import Inference, load_image, load_mask
from ultralytics.models.sam import SAM3SemanticPredictor

def test_sam_3d_inference():
    # load model
    tag = "hf"
    config_path = f"sam3d_ckpts/{tag}/pipeline.yaml"
    inference = Inference(config_path, compile=False)

    # load image (RGBA only, mask is embedded in the alpha channel)
    # image = load_image("notebook/images/shutterstock_stylish_kidsroom_1640806567/image.png")
    image = load_image("interactive_app/uploads/minimalist_room.png")
    # mask = load_single_mask("notebook/images/shutterstock_stylish_kidsroom_1640806567", index=14)
    mask = load_mask('interactive_app/downloads/curr_mask_obj_0.png')

    # run model
    output = inference(image, mask, seed=42)

    # export gaussian splat
    output["gs"].save_ply(f"splat_obj_0.ply")
    output['glb'].export("splat_obj_0.glb")
    print("Your reconstruction has been saved to splat_obj_0.ply")

def test_sam3_semantic_inference(img_path, classes, out_dir):
    # Initialize predictor with configuration
    overrides = dict(
        conf=0.1,
        task="segment",
        mode="predict",
        model="sam3d_ckpts/sam3.pt",
        half=True,  # Use FP16 for faster inference
        save=True,
    )
    predictor = SAM3SemanticPredictor(overrides=overrides)

    # Set image once for multiple queries
    predictor.set_image(img_path)

    # Query with multiple text prompts
    # classes = ["furnitures", "wall", "floor", "ceiling"]
    results = predictor(text=classes)

    print(results[0].masks.shape)
    # output each mask to png
    for i in range(results[0].masks.data.shape[0]):
        obj_type = int(results[0].boxes[i].cls.cpu().numpy()[0])
        obj_name = classes[obj_type]
        print(f"Saving mask for {obj_name}")
        mask = results[0].masks.data[i].cpu().numpy()
        mask = (mask * 255).astype(np.uint8)
        cv2.imwrite(f"{out_dir}/mask_{i}_{obj_name}.png", mask)


def get_inference_model():
    print("Initializing 3D Inference Model (Lazy Load)...")
    tag = "hf"
    data_path = "/data/sam3d_ckpts"
    # Adjust path to point to checkpoints correctly
    config_path = os.path.join(data_path, tag, 'pipeline.yaml')
    inference_model = Inference(config_path, compile=False)
    print("3D Inference Model initialized successfully.")
    return inference_model

def lift_to_3d_directly(model, image_path, scale, out_dir=".", seed=42):
    image = load_image(image_path)
    # create a mask that is the same size as the image and is True everywhere
    mask_bool = np.ones_like(image, dtype=bool)[..., -1]
    output = model(image, mask_bool, seed=seed)

    base_name = "object"
    ply_path = os.path.join(out_dir, f"{base_name}_at_{scale}.ply")
    glb_path = os.path.join(out_dir, f"{base_name}_at_{scale}.glb")
    output["gs"].save_ply(ply_path)
    output["glb"].export(glb_path)
    print(f"3D Gaussian splat saved to {ply_path}")
    print(f"3D mesh (GLB) saved to {glb_path}")

def get_segment_model():
    overrides = dict(
        conf=0.05,
        task="segment",
        mode="predict",
        model="/data/sam3d_ckpts/sam3.pt",
        half=True,
        save=False,
    )
    predictor = SAM3SemanticPredictor(overrides=overrides)
    return predictor

def segment_and_lift_to_3d(
    model_3d,
    model_seg,
    image_path,
    object_description,
    scale,
    out_dir=".",
    seed=42,
):
    """
    Pipeline: image + short text description -> segment target object -> lift to 3D.

    Steps:
    1. Run SAM3 semantic segmentation with text=[object_description] to get 2D mask(s).
    2. Union of all instance masks.
    3. Run the existing 3D Inference pipeline (image + mask) to get Gaussian splat + mesh.
    4. Save .ply and .glb under out_dir.

    Batch processing: Reuse the same model_3d and model_seg across many images/folders.
    No reset needed. For each new image, set_image() is called here to switch the segmenter;
    the 3D model is stateless.
    """
    os.makedirs(out_dir, exist_ok=True)
    # For batch processing: reuse the same model_seg; set_image() switches to this image (no full model reset needed).
    model_seg.set_image(image_path)
    # Single-class query: description is the class
    results = model_seg(text=[object_description])

    if not results or results[0].masks is None or results[0].masks.data.shape[0] == 0:
        print("No masks found")
        return None

    masks = results[0].masks.data.cpu().numpy()
    # union of all masks
    mask_union = masks.sum(axis=0) > 0
    mask_union = (mask_union * 255).astype(np.uint8)
    cv2.imwrite(os.path.join(out_dir, f"segment_mask_at_{scale}.png"), mask_union)
    print(f"Segmentation mask saved to {os.path.join(out_dir, f'segment_mask_at_{scale}.png')}")
    # 3D lift
    image = load_image(image_path)
    mask_bool = mask_union.astype(bool) if mask_union.dtype != bool else mask_union
    output = model_3d(image, mask_bool, seed=seed)

    base_name = "object_3d"
    ply_path = os.path.join(out_dir, f"{base_name}_at_{scale}.ply")
    glb_path = os.path.join(out_dir, f"{base_name}_at_{scale}.glb")
    output["gs"].save_ply(ply_path)
    output["glb"].export(glb_path)
    print(f"3D Gaussian splat saved to {ply_path}")
    print(f"3D mesh (GLB) saved to {glb_path}")

def batch_lift_to_3d(sam3d_model, model_seg, assets_dir, asset_info_path, asset_folders, param_combo):
    asset_info_dict = {}
    with open(asset_info_path, 'r') as f:
        asset_info = csv.reader(f)
        next(asset_info)
        for i, row in enumerate(asset_info):
            desc, edit, asset_name = row
            asset_info_dict[i] = {
                "desc": desc,
                "edit": edit,
                "asset_name": asset_name
            }
    for asset_folder in asset_folders:
        if asset_folder != 'asset_35':
            continue
        if not os.path.isdir(os.path.join(assets_dir, asset_folder, param_combo)):
            continue
        
        asset_id = int(asset_folder.split('_')[1])
        asset_desc = asset_info_dict[asset_id]["desc"]
        asset_desc = 'food'
        print(f"Processing asset folder: {asset_folder} with description: {asset_desc}")
        out_dir = os.path.join(assets_dir, asset_folder, "3d_output")
        os.makedirs(out_dir, exist_ok=True)
        # read scales.txt
        scales_path = os.path.join(assets_dir, asset_folder, param_combo, "scales.txt")
        with open(scales_path, 'r') as f:
            scales = f.readlines()
        scales = [scale.strip() for scale in scales]
        
        for scale in scales:
            img_path = os.path.join(assets_dir, asset_folder, param_combo, f"search_at_{scale}.png")
            segment_and_lift_to_3d(sam3d_model, model_seg, img_path, asset_desc, scale, out_dir=out_dir)

def check_invalid_segmentations(assets_dir, asset_info_path, asset_folders, param_combo):
    asset_info_dict = {}
    missing_segmentations = []
    with open(asset_info_path, 'r') as f:
        asset_info = csv.reader(f)
        next(asset_info)
        for i, row in enumerate(asset_info):
            desc, edit, asset_name = row
            asset_info_dict[i] = {
                "desc": desc,
                "edit": edit,
                "asset_name": asset_name
            }
    for asset_folder in asset_folders:
        if not os.path.isdir(os.path.join(assets_dir, asset_folder, param_combo)):
            continue
        
        asset_id = int(asset_folder.split('_')[1])
        asset_desc = asset_info_dict[asset_id]["desc"]
        print(f"Processing asset folder: {asset_folder} with description: {asset_desc}")
        out_dir = os.path.join(assets_dir, asset_folder, "3d_output")
        os.makedirs(out_dir, exist_ok=True)
        # read scales.txt
        scales_path = os.path.join(assets_dir, asset_folder, param_combo, "scales.txt")
        with open(scales_path, 'r') as f:
            scales = f.readlines()
        scales = [scale.strip() for scale in scales]
        for scale in scales:
            glb_path = os.path.join(assets_dir, asset_folder, '3d_output', f"object_3d_at_{scale}.glb")
            seg_path = os.path.join(assets_dir, asset_folder, '3d_output', f"segment_mask_at_{scale}.png")
            if not os.path.exists(seg_path):
                print(f"No segmentation mask found for {asset_folder} at scale {scale}")
                missing_segmentations.append((asset_folder, scale))
    with open('missing_segmentations.txt', 'w') as f:
        for asset_folder, scale in missing_segmentations:
            f.write(f"{asset_folder},{scale}\n")
    print(f"Found {len(missing_segmentations)} missing segmentations")


def patch_lift_to_3d(sam3d_model, model_seg, assets_dir, asset_info_path, missing_assets_info_path, param_combo):
    asset_info_dict = {}
    with open(asset_info_path, 'r') as f:
        asset_info = csv.reader(f)
        next(asset_info)
        for i, row in enumerate(asset_info):
            desc, edit, asset_name = row
            asset_info_dict[i] = {
                "desc": desc,
                "edit": edit,
                "asset_name": asset_name
            }
    missing_assets_info = []
    with open(missing_assets_info_path, 'r') as f:
        rows = csv.reader(f)
        for i, row in enumerate(rows):
            asset_folder, scale = row
            missing_assets_info.append((asset_folder, scale))

    for asset_folder, scale in missing_assets_info:
        print(f"Patching {asset_folder} at scale {scale}")
        out_dir = os.path.join(assets_dir, asset_folder, "3d_output")
        img_path = os.path.join(assets_dir, asset_folder, param_combo, f"search_at_{scale}.png")
        segment_and_lift_to_3d(sam3d_model, model_seg, img_path, 'a person', scale, out_dir=out_dir)

if __name__ == "__main__":
    
    sam3d_model = get_inference_model()
    model_seg = get_segment_model()

    assets_dir = '/data/sliders/test_img_03082026_v3'
    asset_info_path = '../TRELLIS/validation/new_validation.csv'
    asset_folders = sorted(os.listdir(assets_dir))
    param_combo = 'str0.60_sn500'

    missing_assets_info_path = 'missing_segmentations.txt'
    # check_invalid_segmentations(assets_dir, asset_info_path, asset_folders, param_combo)
    # patch_lift_to_3d(sam3d_model, model_seg, assets_dir, asset_info_path, missing_assets_info_path, param_combo)
    batch_lift_to_3d(sam3d_model, model_seg, assets_dir, asset_info_path, asset_folders, param_combo)