# Structured 3D Latents for Scalable and Versatile 3D Generation


**TRELLIS** is a large 3D asset generation model. It takes in text or image prompts and generates high-quality 3D assets in various formats, such as Radiance Fields, 3D Gaussians, and meshes. The cornerstone of **TRELLIS** is a unified Structured LATent (**SLAT**) representation that allows decoding to different output formats and Rectified Flow Transformers tailored for **SLAT** as the powerful backbones. We provide large-scale pre-trained models with up to 2 billion parameters on a large 3D asset dataset of 500K diverse objects. **TRELLIS** significantly surpasses existing methods, including recent ones at similar scales, and showcases flexible output format selection and local 3D editing capabilities which were not offered by previous models.

***Check out the [Project Page](https://microsoft.github.io/TRELLIS/) for more videos and interactive demos!***



## 🌟 Features

- **High Quality**: It produces diverse 3D assets at high quality with intricate shape and texture details.
- **Versatility**: It takes text or image prompts and can generate various final 3D representations including but not limited to *Radiance Fields*, *3D Gaussians*, and *meshes*, accommodating diverse downstream requirements.
- **Flexible Editing**: It allows for easy editings of generated 3D assets, such as generating variants of the same object or local editing of the 3D asset.

Please see the original TRELLIS's README.md for more details in using and training the model.

-------------------------------------------------------------------------------------------------------------------------------------
# 🎚️ Slider-based Continuous Semantic Attribute Control

This repository extends the original TRELLIS image-to-3D pipeline with **slider-based precise control over semantic attributes**. Instead of a single conditioning image producing a single asset, the user supplies a *positive*, *negative*, and *neutral* set of views, and a continuous `slider_scale ∈ ℝ` knob smoothly traverses the attribute axis defined by (negative → positive) — for example *small head ↔ oversized head*, *less shiny ↔ more shiny* — while preserving the identity provided by the neutral views.

### What's new vs. the original TRELLIS

The extension is implemented as two additions; everything else (encoders, decoders, transformers, training code) is unchanged:


| File                                                                                                                   | Role                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[trellis/pipelines/trellis_attribute_slider_with_image.py](trellis/pipelines/trellis_attribute_slider_with_image.py)` | New `TrellisImageTo3DAttributeSliderPipeline` — drop-in replacement for `TrellisImageTo3DPipeline` that accepts a (positive, negative, neutral) conditioning bundle and a `slider_scale` |
| `[trellis/pipelines/samplers/flow_euler.py](trellis/pipelines/samplers/flow_euler.py)`                                 | New `FlowEulerSamplerAttributeSlider` — replaces the standard rectified-flow sampler with one that fuses CFG with a slider-scaled edit direction                                         |


Concretely, the original sampler used standard classifier-free guidance:

```
v = v_uncond + cfg · (v_cond − v_uncond)
```

The slider sampler decomposes guidance and editing into two independent terms (`flow_euler.py:266-276`):

```
v_guided = v_uncond + cfg · (v_neutral − v_uncond)             # identity / reconstruction
v_target = v_guided + slider_scale · (v_pos − v_neg)           # continuous attribute edit
```

The `(v_pos − v_neg)` term is a **velocity-space edit direction** estimated *during* denoising (no fine-tuning, no LoRA), and `slider_scale` is a continuous, signed magnitude — the same model produces the full attribute spectrum in a single inference. The pipeline applies this jointly to both the sparse-structure and SLAT samplers, so geometry and appearance traverse the axis coherently.

The pipeline also adds:

- **Multi-view conditioning for editing** via `get_reconstruct_edit_cond` (encodes a list of original views, positive-edited views, and negative-edited views into a single conditioning dict).
- **Parallel inference** (`run_reconstruct_edit_parallel`) with two strategies — `'batch'` (one GPU, all conditions in one forward pass) and `'multi_gpu'` (one model copy per GPU) — controlled by `ss_batch_size_per_gpu` / `slat_batch_size_per_gpu` for VRAM tuning.

### Brief usage

```python
from trellis.pipelines import TrellisImageTo3DAttributeSliderPipeline

pipeline = TrellisImageTo3DAttributeSliderPipeline.from_pretrained(
    "microsoft/TRELLIS-image-large"
)
pipeline.cuda()

# Build conditioning from three view sets
cond = pipeline.get_reconstruct_edit_cond(
    images=original_views,            # identity / neutral
    positive_images=positive_views,   # "+" pole of the attribute
    negative_images=negative_views,   # "−" pole of the attribute
)

# Sweep the slider — same model, single conditioning, continuous control
for s in [-2.0, -1.0, 0.0, 1.0, 2.0]:
    out = pipeline.run_reconstruct_edit(cond, slider_scale=s, formats=['mesh', 'gaussian'])
```

For automatic mapping from a target perceptual-distance percentage to a slider value (with quality validation), see [`ss3d_utils/slider_mapping.py`](../ss3d_utils/slider_mapping.py) and [`ss3d_utils/LPIPS_PERCENTAGE_MAPPING_README.md`](../ss3d_utils/LPIPS_PERCENTAGE_MAPPING_README.md) at the repo root (these live outside this TRELLIS clone).



