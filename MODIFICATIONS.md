# Third-party components and modifications

Companion to `LICENSE`. Records what in this repository is third-party code,
what was changed, and which upstream licenses apply.

**For legal review:** the two items most likely to matter are (1) the
non-commercial runtime dependencies in the last section, which cap how the
assembled system may be used regardless of this repo's MIT license, and (2) the
`sam-3d-objects/` subtree, which is under a bespoke Meta agreement rather than an
open-source license.

## Original code

Written for this project and covered by the MIT license in `LICENSE`:

| Path | Contents |
| --- | --- |
| `ml_servers/` | `app.py` (SAM3D backend), `trellis_server.py` (TRELLIS backend), `config.py` |
| `ss3d_utils/` | slider mapping, multi-view rendering, prompt generation, evaluation |
| `playground_ui/` | React frontend |
| `Caddyfile` | single-origin reverse proxy for demos |

## Vendored third-party code

| Path | Upstream | License | Modified |
| --- | --- | --- | --- |
| `TRELLIS/` | [microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) @ **`442aa1e`** | MIT — `TRELLIS/LICENSE` | **Yes**, see below |
| `TRELLIS/trellis/representations/mesh/flexicubes/` | [MaxtirError/FlexiCubes](https://github.com/MaxtirError/FlexiCubes) @ **`815e075`** (NVIDIA FlexiCubes) | Apache 2.0 — `flexicubes/LICENSE.txt` | **Yes**, one file — see below |
| `sam-3d-objects/` | [facebookresearch/sam-3d-objects](https://github.com/facebookresearch/sam-3d-objects) @ **`afdf6a3`** | SAM License — `sam-3d-objects/LICENSE` | **Yes**, see below |

### Base version of TRELLIS

This snapshot is built on **`442aa1e`** — *"Merge pull request #335 from
ForeverFancy/main"*, dated **2025-11-05**, on the `main` branch of
`microsoft/TRELLIS`.

Established by diffing this tree against upstream commit-by-commit. `442aa1e` was
also upstream `HEAD` as of 2026-07-30, so **this snapshot has not fallen behind
upstream** — there is nothing to rebase onto.

`TRELLIS/.git` was not preserved (the snapshot was copied, not cloned), so the
commit is recorded here rather than in git metadata.

### Note on `sam-3d-objects/`

The SAM License is not an open-source license. Redistribution of that subtree, or
of any derivative of it, is permitted only under the terms of that Agreement, and
a copy of the Agreement must accompany it (§1(b)(i)). It therefore cannot be
relicensed under this repository's MIT terms. §1(b)(ii) additionally requires
that published research using SAM Materials acknowledge them.

Because this subtree **is** modified (below), it constitutes a derivative work of
the SAM Materials, and §1(b)(i) applies to it in full. Under §5(a) the
modifications themselves are owned by their author, but the subtree as a whole
may only be distributed under the SAM License.

## Changes made to `sam-3d-objects/`

Base version: **`afdf6a3`**, *"Add Roboflow link to README"*, 2025-12-01, `main`
branch of `facebookresearch/sam-3d-objects`. Determined by diffing this tree
against successive upstream commits and taking the closest match; the local
snapshot is dated 2025-12-06.

Note that upstream has since advanced (through at least `f91db41`, 2026-06-02),
so unlike the TRELLIS snapshot this one **has fallen behind**.

**Files modified** — 5 files

| File | Change | What |
| --- | --- | --- |
| `demo.py` | +254 −15 | substantially rewritten for this project (testing purpose only, not used for the ml_servers) |
| `sam3d_objects/model/backbone/tdfy_dit/utils/render_utils.py` | +3 −3 | Gaussian rendering backend switched from `"inria"` to `"gsplat"` (3 call sites) |
| `notebook/inference.py` | +3 −3 | enabled `with_mesh_postprocess` and `with_texture_baking`; disabled `use_vertex_color` |
| `sam3d_objects/model/backbone/tdfy_dit/renderers/gaussian_render.py` | +1 −1 | same `inria` → `gsplat` backend switch |
| `sam3d_objects/pipeline/inference_pipeline.py` | +1 −0 | one added line |

**Removed from the upstream tree:** `doc/`, and the notebook demo assets
(`demo_single_object.ipynb`, `demo_multi_object.ipynb`,
`demo_3db_mesh_alignment.ipynb`, `notebook/gaussians/`, `notebook/meshes/`).

**Added locally:** `interactive_app/` (a standalone Gradio app, superseded by
`ml_servers/app.py`) and `pipeline_output/` — both excluded from the repository
by `.gitignore`.

Everything else under `sam-3d-objects/` is byte-identical to upstream `afdf6a3`.

The `inria` → `gsplat` switch is worth noting beyond provenance: it changes which
Gaussian-splatting rasterizer backend is used at runtime, and those backends carry
different licenses.

## Changes made to `TRELLIS/`

Purpose: add attribute-slider sampling and pipelines for semantic 3D editing.

This list is a **file-by-file diff against upstream `442aa1e`**, not an estimate.
Line counts are `diff` added/removed lines.

**Files added** — entirely original work, 1,459 lines

| File | Lines | Purpose |
| --- | --- | --- |
| `trellis/pipelines/trellis_attribute_slider.py` | 777 | text-conditioned attribute-slider pipeline |
| `trellis/pipelines/trellis_attribute_slider_with_image.py` | 682 | image-conditioned variant |

**Files modified** — 462 lines added, 326 removed

| File | Change | Notes |
| --- | --- | --- |
| `trellis/pipelines/samplers/flow_euler.py` | +251 −0 | pure addition: `FlowEulerSamplerAttributeSlider`, alongside the untouched upstream `FlowEulerSampler` |
| `dataset_toolkits/blender_script/render.py` | +76 −4 | Blender multi-view render script, invoked by `ss3d_utils/render_multiviews_blender_mp.py` |
| `trellis/pipelines/trellis_text_to_3d.py` | +53 −7 | slider hooks in the text-to-3D pipeline |
| `trellis/representations/mesh/cube2mesh.py` | +7 −0 | mesh-extraction hook |
| `trellis/models/structured_latent_vae/decoder_mesh.py` | +6 −0 | mesh-extraction hook |
| `trellis/utils/render_utils.py` | +6 −0 | render hook |
| `trellis/pipelines/__init__.py` | +2 −1 | register the two new pipelines |
| `trellis/pipelines/samplers/__init__.py` | +1 −1 | export the new sampler |
| `README.md` | +43 −313 | upstream README replaced with project-specific notes |
| `.gitignore` | +17 −0 | project-specific ignores |

**Files removed from the upstream tree** — upstream demo and training entry
points, not used by this project:

`app.py`, `app_text.py`, `example.py`, `example_text.py`,
`example_multi_image.py`, `example_variant.py`, `train.py`, `DATASET.md`,
and `assets/` (65 files).

Everything else in `TRELLIS/` is **byte-identical to upstream `442aa1e`**.

## Changes made to `flexicubes/` (Apache 2.0)

Base version: **`815e075`**, *"Resolve merge conflict in flexicubes.py"*,
2025-04-29, `main` branch of `MaxtirError/FlexiCubes` — upstream `HEAD`.

Upstream TRELLIS carries flexicubes as an uninitialized submodule, so this
directory was compared against the FlexiCubes repository directly.

**One file modified**, `flexicubes.py`, **+8 −0**. A `to(device)` method added to
the `FlexiCubes` class after line 54, moving the class's tensor attributes onto a
given device:

```python
    def to(self, device):
        self.device = device
        for attr in vars(self):
            val = getattr(self, attr)
            if isinstance(val, torch.Tensor):
                setattr(self, attr, val.to(device))
        return self
```

This supports the multi-GPU worker pools in `ml_servers/trellis_server.py`.
Confirmed original: `git log --all -S` over the full upstream history finds no
commit in which this method ever existed. The file also carries the modification
notice described below.

**Files removed from the upstream tree:** the two unused demo notebooks,
`examples/extraction.ipynb` and `examples/optimization.ipynb`.

Every other file in the directory is byte-identical to upstream.

### Apache 2.0 §4(b) — satisfied

§4(b) requires that modified files "carry prominent notices stating that You
changed the files." `flexicubes.py` is modified, so this applies.

A notice to that effect is in the header of `flexicubes.py`, below the upstream
NVIDIA copyright and Apache license block, which is left intact.

## Runtime dependencies with use restrictions

Installed by the user via `TRELLIS/setup.sh`, **not** redistributed here, so no
redistribution obligation attaches to this repository. They are listed because
they restrict how the assembled system may be used.

| Package | License | Required? |
| --- | --- | --- |
| `nvdiffrast` (NVIDIA) | NVIDIA Source Code License — non-commercial research use only | **Yes.** `trellis/utils/postprocessing_utils.py` imports it at module level, so `ml_servers/trellis_server.py` cannot start without it. |
| `mip-splatting` / `diff_gaussian_rasterization` | Derived from Inria/MPII 3D Gaussian Splatting — research use only | In practice yes — used by `to_glb`'s multi-view bake and `render_utils.render_key_frames`. |
| `diffoctreerast` | — | No. `octree_renderer.py` degrades gracefully with a warning if absent. |

**Consequence:** although the original code here is MIT licensed, a working
installation of the full pipeline is subject to non-commercial research-use
restrictions. The permissive license on this repository does not lift them.

The license texts for `nvdiffrast` and `mip-splatting` are not present in this
tree; the summaries above are from knowledge of those projects and should be
verified against the upstream texts before any commercial reliance.
