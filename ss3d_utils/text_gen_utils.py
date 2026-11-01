import base64
import json
import os
import shutil
from typing import List

from _paths import load_ss3d_dotenv
from openai import OpenAI
from google import genai
from PIL import Image
import io

load_ss3d_dotenv()

_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
_gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY_OLD"))


def _encode_image(image_path: str) -> str:
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def direction_generator_edit(basic_object: str, basic_attribute: str,): # it's a duplicate of the function in val_editing.py
    # use openai api to generate direction

    # sys prompt v2.1
    sys_prompt = (
        "You are an expert assistant specializing in generating concise, high-impact prompts for image editing APIs. "
        "Given an 'Object A' and an 'Attribute B', your task is to generate a 'negative_prompt' and a 'positive_prompt' "
        "that modify the object along the spectrum of that attribute.\n\n"
        
        "### INSTRUCTIONS:\n"
        "1. Positive Prompt: Edit Object A to present the MAXIMUM extreme or highest intensity of Attribute B.\n"
        "2. Negative Prompt: Edit Object A to present the MINIMUM extreme or exact opposite of Attribute B.\n"
        "3. Sentiment Independence: Note that Attribute B can itself be inherently negative (e.g., 'rusty'), neutral, or positive. "
        "The 'positive prompt' always means MORE of the attribute, and the 'negative prompt' always means LESS of it.\n"
        "4. Brevity (CRITICAL): Image models lose focus with long prompts. Keep the editing description concise and direct (under 20 words).\n\n"
        # "5. Context & Reassurance: ALWAYS end the generated prompt with this exact, concise phrasing: 'Keep all other elements unchanged. Skip edit if not visible.'\n\n"
        
        "### SAFETY GUARDRAILS (CRITICAL):\n"
        "- NEVER generate prompts that could trigger NSFW, nudity, or sexual content safety filters.\n"
        "- When reducing clothing, use safe, concise descriptors like 'casual summer wear' or 'lightweight clothing'. Avoid 'skimpy', 'revealing', 'bare', or 'underwear'.\n"
        "- Modifying physical traits ('very thin', 'highly muscular') is perfectly safe, but keep it purely descriptive and non-suggestive.\n\n"
        
        "### EXAMPLES:\n"
        "Object: 'a blue sofa' | Attribute: 'modern style'\n"
        "Negative: 'Make the sofa traditional, antique, and ornate style.'\n"
        "Positive: 'Make the sofa ultra-modern, sleek, and minimalist style.'\n\n"
        
        "Object: 'a woman' | Attribute: 'eye size'\n"
        "Negative: 'Make the woman's eyes extremely small and narrow.'\n"
        "Positive: 'Make the woman's eyes dramatically large and wide open.'\n\n"

        "Object: 'a woman' | Attribute: 'wearing very warm and thick clothes'\n"
        "Negative: 'Make the woman wear modest, casual summer clothes like a t-shirt.'\n"
        "Positive: 'Make the woman wear extremely warm, heavy winter coats and thick scarves.'\n\n"
        
        "### OUTPUT FORMAT:\n"
        "Return ONLY a valid JSON object matching this schema without any markdown formatting:\n"
        "{\"prompts\": [\"<negative_prompt>\", \"<positive_prompt>\"]}"
    )
    user_prompt = (
        f"Object: {basic_object} \n"
        f"Attribute: {basic_attribute} \n"
    )
    response = _client.chat.completions.create(
        model="gpt-5.2",
        messages=[
            {
                "role": "system",
                "content": sys_prompt
            },
            {
                "role": "user",
                "content": user_prompt
            }
        ],
        temperature=0.3,
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "direction_edit_prompts",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "prompts": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 2,
                            "items": {"type": "string"},
                        }
                    },
                    "required": ["prompts"],
                },
            },
        },
    )
    payload = json.loads(response.choices[0].message.content)
    prompts = payload["prompts"]
    assert len(prompts) == 2, f"Expected 2 prompts, got {len(prompts)}"
    return prompts  # [negative_prompt, positive_prompt]

def editing_prompt_view_filtering(editing_prompt: str, image_path: str): # it's a duplicate of the function in val_editing.py
    # Encode the image as a base64 data URL
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode("utf-8")
    image_url = f"data:image/png;base64,{img_b64}"

    response = _client.chat.completions.create(
        model="gpt-5.2",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a view-relevance checker for 3D object editing. "
                    "You will be given an editing prompt describing a desired change to a 3D object, "
                    "and an image showing the object rendered from a particular viewpoint.\n\n"
                    "Your task is to determine whether the region or part of the object targeted by the editing prompt "
                    "is clearly visible in this view.\n\n"
                    "Guidelines:\n"
                    "- If the edit targets a specific part (e.g., \"make the eyes bigger\"), check whether that part "
                    "is visible and not occluded or facing away from the camera.\n"
                    "- If the edit targets the entire object (e.g., \"change the color/style of the object\"), check whether the object "
                    "is sufficiently visible in the image.\n\n"
                    "Return {\"result\": true} if the targeted region is clearly visible, "
                    "or {\"result\": false} otherwise."
                )
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            f"Editing prompt: {editing_prompt}\n"
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url},
                    },
                ],
            }
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "editing_prompt_view_filtering",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "result": {"type": "boolean"}
                    },
                    "required": ["result"],
                },
            },
        },
    )
    payload = json.loads(response.choices[0].message.content)
    return payload["result"]

def edit_image_gpt_image(input_image_path: str, edit_prompt: str): # it's a duplicate of the function in val_editing.py
    # Edit the image using GPT-Image
    result = _client.images.edit(
        model="gpt-image-1.5",
        image=[
            open(input_image_path, "rb"),
        ],
        prompt=edit_prompt
    )
    image_base64 = result.data[0].b64_json
    image_bytes = base64.b64decode(image_base64)
    # convert image_bytes to Image
    image = Image.open(io.BytesIO(image_bytes))
    return image

def _describe_views(image_paths: List[str], model: str = "gpt-5.2", temperature: float = 0) -> str:
    DESCRIBE_PROMPT = (
        "Please describe the details of the 3D object, the detailed description will be used for a text to 3d model to generate this 3D object. "
        "Please provide details of the shape, color of each part, avoid imagination and solve it step by step. You do not need to describe the background."
    )
    content = [{"type": "text", "text": DESCRIBE_PROMPT}]
    for path in image_paths:
        b64 = _encode_image(path)
        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})

    resp = _client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        temperature=temperature,
    )
    return resp.choices[0].message.content


def describe_objs_from_views(
    views: List[str],
    model: str = "gpt-5.2",
    temperature: float = 0,
) -> str:
    """Describe a 3D object from multiple view images and summarize into one caption.

    Args:
        views: List of file paths to rendered view images (e.g. 4 camera views).
        model: OpenAI model name (must support vision).
        temperature: Sampling temperature for both stages.

    Returns:
        A single <=40-word caption describing the 3D object.
    """
    raw_captions = _describe_views(views, model=model, temperature=temperature)
    
    SUMMARIZE_PROMPT = (
        "This is a hard problem. Carefully summarize in ONE caption aiming for **no more than 40 words** "
        "based on the following captions (possibly incorrect) by people describing the 3D object. "
        "The caption will be used for a text to 3D model to generate this 3D object. "
        "Ensure the summary is concise and captures the essential information without including any additional commentary or unnecessary details. "
        "Please avoid hallucination. Raw captions: {raw_captions}. Please directly output the detailed caption without extra text. "
        "Provide the caption in a simple, plain text format with no markdown, bullet points, or special formatting."
    )

    resp = _client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": SUMMARIZE_PROMPT.format(raw_captions=raw_captions)}],
        temperature=temperature,
    )
    return resp.choices[0].message.content


def filter_questions(questions: List[str], image_editing_prompt: str) -> List[str]:
    """Filter out questions affected by an image editing prompt.

    Args:
        questions: Yes/no questions generated from the original text prompt.
        image_editing_prompt: The editing operation to be applied.

    Returns:
        The subset of questions that remain valid after the edit.
    """
    # sys prompt v2
    system_prompt = (
        "You are an accurate and balanced question filter for image-prompt faithfulness evaluation.\n\n"
        "Context: A set of yes/no questions was generated from a text prompt. "
        "An image editing operation will now be applied. "
        "Your goal is to evaluate which questions are no longer safe to use for evaluation because the edit changes their answers.\n\n"
        
        "Your task:\n"
        "1. REMOVE any question where the editing prompt directly contradicts or highly probably alters the visual attribute.\n"
        "2. KEEP questions that evaluate independent attributes that are reasonably expected to remain unchanged.\n\n"
        
        "Rules for Balanced Filtering:\n"
        "- Direct & Strong Correlated Conflicts: Remove questions if the edit requires the change, or if there is a strong, undeniable visual correlation (e.g., 'rusty' strongly implies 'not modern' and 'not shiny').\n"
        "- Presumption of Invariance: Assume attributes not explicitly or structurally targeted by the edit will remain unchanged. Do NOT over-extrapolate or remove questions based on weak, hypothetical, or 'possible but not guaranteed' side-effects.\n"
        "- Consider Style/Holistic Changes: Changing the 'style' of an object (e.g., 'traditional') alters its specific design elements (pattern, texture, materials), but generally leaves independent attributes (like base color, general shape, or object identity) unchanged.\n"
        "- Do not add new questions or modify existing ones.\n"
        "- Do not provide explanations. Return exactly the filtered lists.\n\n"
        
        "Example 1 (Direct Contradiction):\n"
        "original question list = ['Is the person young?', 'Is the person\'s hair curly?', 'Is the person male?']\n"
        "image editing prompt = 'Make the person old'\n"
        "removed_questions: ['Is the person young?']\n"
        "kept_questions: ['Is the person\'s hair curly?', 'Is the person male?']\n\n"
        
        "Example 2 (Indirect/Correlated Contradiction):\n"
        "original question list = ['Is the nose rounded?', 'Is the plane modern?', 'Is the plane shiny?']\n"
        "image editing prompt = 'Make the plane more rusty'\n"
        "removed_questions: ['Is the plane modern?', 'Is the plane shiny?']\n"
        "kept_questions: ['Is the nose rounded?']\n\n"
        
        "Example 3 (Style/Holistic Contradiction):\n"
        "original question list = ['Does the sofa have sleek, minimalist lines?', 'Are the sofa legs made of wood?', 'Is the sofa blue?']\n"
        "image editing prompt = 'Make the sofa more traditional looking'\n"
        "removed_questions: ['Does the sofa have sleek, minimalist lines?', 'Are the sofa legs made of wood?']\n"
        "kept_questions: ['Is the sofa blue?']"
    )

    user_prompt = (
        f"original question list = {questions}\n"
        f"image editing prompt = '{image_editing_prompt}'"
    )

    resp = _client.chat.completions.create(
        model="gpt-5.2",
        temperature=0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "filtered_questions",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "removed_questions": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "kept_questions": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["removed_questions", "kept_questions"],
                },
            },
        },
    )

    payload = json.loads(resp.choices[0].message.content)
    return payload["removed_questions"], payload["kept_questions"]

def quality_and_difference_control(ori_img_path: str, edited_img_path: str, editing_prompt: str) -> str:
    system_prompt = (
        "You are a balanced and precise Vision-Language Model acting as an evaluator for AI 3D asset editing pipelines.\n\n"
        "Context: You will be provided with an 'Original Image', an 'Edited Image', and the 'Editing Prompt'. "
        "CRITICAL: These are 2D renders of 3D assets at the exact same camera angle. 3D generative pipelines naturally produce minor variations, so do not expect pixel-perfect matches.\n\n"
        "Your task is to evaluate the Edited Image based on two strictly defined criteria:\n\n"
        
        "### CRITERION 1: Edit Isolation (Target Preservation)\n"
        "- Goal: Verify that the edit was successfully applied to the target area without causing significant collateral damage to the rest of the object.\n"
        "- Ignore Background: DO NOT compare or evaluate the background.\n"
        "- Acceptable Variations: Tolerate slight changes on unaffected visual elements. Minor texture softening, slight lighting/color shifts, or subtle geometry noise inherent to 3D generation are acceptable and should NOT cause a failure.\n"
        "- Visibility Exception: If the specific part targeted by the Editing Prompt is NOT visible from this camera angle, set `isolation_passed` to true by default.\n"
        "- Failure states: FAIL this criterion if there are obvious, substantial alterations to unedited parts. Examples of failures: changing the primary color or material of an unedited region, altering the fundamental shape of unedited parts, or adding/removing prominent features not mentioned in the prompt.\n\n"
        
        "### CRITERION 2: Object Integrity & Mesh Quality\n"
        "- Goal: Verify that the edited 3D object remains structurally coherent and visually logical.\n"
        "- Rules: The object must maintain its core structural integrity. Minor generative noise is fine, but the overall shape must make sense.\n"
        "- Failure states: FAIL this criterion if the object exhibits severe structural degradation, such as heavily melted textures, prominent floating/disconnected geometry, or large broken mesh patches.\n\n"
        
        "### INSTRUCTIONS:\n"
        "1. Analyze the Editing Prompt to pinpoint the intended target area.\n"
        "2. Check if the target is visible. If NOT visible, set `isolation_passed` to true and output 'Affected part not visible' for `isolation_reasoning`.\n"
        "3. Compare the objects. Ignore minor 3D noise, but check carefully for unprompted color, material, or structural changes in the unedited regions.\n"
        "4. Inspect the overall object for severe structural collapse or prominent artifacts.\n"
        "5. Return ONLY a valid JSON object without markdown formatting.\n\n"
        
        "### OUTPUT SCHEMA:\n"
        "{\n"
        "  \"isolation_reasoning\": \"Briefly explain if there were substantial changes to unedited areas (ignoring minor noise), or write 'Affected part not visible'.\",\n"
        "  \"isolation_passed\": true/false,\n"
        "  \"integrity_reasoning\": \"Briefly evaluate the structural coherence, noting any severe mesh or texture artifacts.\",\n"
        "  \"integrity_passed\": true/false\n"
        "}"
    )

    ori_b64 = _encode_image(ori_img_path)
    edited_b64 = _encode_image(edited_img_path)

    user_content = [
        {"type": "text", "text": f"Editing Prompt: '{editing_prompt}'"},
        {"type": "text", "text": "Original Image:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{ori_b64}"}},
        {"type": "text", "text": "Edited Image:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{edited_b64}"}},
    ]

    resp = _client.chat.completions.create(
        model="gpt-5.2",
        temperature=0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "quality_control",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "isolation_reasoning": {"type": "string"},
                        "isolation_passed": {"type": "boolean"},
                        "integrity_reasoning": {"type": "string"},
                        "integrity_passed": {"type": "boolean"},
                    },
                    "required": [
                        "isolation_reasoning",
                        "isolation_passed",
                        "integrity_reasoning",
                        "integrity_passed",
                    ],
                },
            },
        },
    )

    return json.loads(resp.choices[0].message.content)


def quality_control_only(ori_img_path: str, edited_img_path: str, editing_prompt: str) -> str:
    system_prompt = (
        "You are a balanced and precise Vision-Language Model acting as an evaluator for AI 3D asset editing pipelines.\n\n"
        "Context: You will be provided with an 'Original Image', an 'Edited Image', and the 'Editing Prompt'. "
        "CRITICAL: These are 2D renders of 3D assets at the exact same camera angle. 3D generative pipelines naturally produce minor variations.\n\n"
        "Your sole task is to evaluate the Edited Image based strictly on the structural quality and integrity of the object.\n\n"
        
        "### CRITERION: Object Integrity & Mesh Quality\n"
        "- Goal: Verify that the edited 3D object remains structurally coherent, visually logical, and free of catastrophic rendering errors.\n"
        "- Ignore Background: DO NOT evaluate or penalize the background. Focus entirely on the foreground object.\n"
        "- Rules: The object must maintain its core structural integrity. Minor generative noise, slight texture softening, or subtle artifacts inherent to 3D generation are acceptable and should NOT cause a failure.\n"
        "- Failure states: FAIL this criterion if the foreground object exhibits severe structural degradation, such as heavily melted textures, prominent floating/disconnected geometry, large broken mesh patches, or unrecognizable geometric distortions.\n\n"
        
        "### INSTRUCTIONS:\n"
        "1. Review the Original Image and Editing Prompt to understand the baseline structure of the object.\n"
        "2. Inspect the Edited Image specifically looking for severe structural collapse or prominent 3D artifacts. Ignore minor 3D noise.\n"
        "3. Return ONLY a valid JSON object without markdown formatting.\n\n"
        
        "### OUTPUT SCHEMA:\n"
        "{\n"
        "  \"quality_reasoning\": \"Briefly evaluate the structural coherence of the edited object, noting any severe mesh or texture artifacts. Explicitly state if only minor noise was observed.\",\n"
        "  \"quality_passed\": true/false\n"
        "}"
    )
    ori_b64 = _encode_image(ori_img_path)
    edited_b64 = _encode_image(edited_img_path)

    user_content = [
        {"type": "text", "text": f"Editing Prompt: '{editing_prompt}'"},
        {"type": "text", "text": "Original Image:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{ori_b64}"}},
        {"type": "text", "text": "Edited Image:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{edited_b64}"}},
    ]
    
    resp = _client.chat.completions.create(
        model="gpt-5.2",
        temperature=0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "quality_control",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "quality_reasoning": {"type": "string"},
                        "quality_passed": {"type": "boolean"},
                    },
                    "required": ["quality_reasoning", "quality_passed"],
                },
            },
        },
    )
    return json.loads(resp.choices[0].message.content)


perceptual_logic_system_prompt = (
    "You are a sophisticated evaluator specializing in human perception and 3D asset quality.\n\n"
    "### CONTEXT:\n"
    "- Input 1: Quad-view (4 angles) of an 'Original Object'.\n"
    "- Input 2: Quad-view (4 angles) of an 'Edited Object'.\n"
    "- Input 3: An 'Editing Prompt'.\n\n"
    "### YOUR GOAL:\n"
    "Determine if the edited object is a high-quality, 'logical' evolution of the original asset. "
    "You are not checking for strict isolation; you are checking for structural sanity and human preference.\n\n"
    "### EVALUATION CRITERIA:\n"
    "1. PERCEPTUAL LOGIC & SENSE-MAKING:\n"
    "- Does the edit 'make sense' to a human? Even if the model edited more than requested, is the result a plausible, coherent object?\n"
    "- Identify 'Weird' elements: Spot any unreasonable distortions, uncanny textures, or 'glitchy' transitions that feel unnatural.\n"
    "- Alignment: Does the execution of the prompt align with human expectations? "
    "(e.g., if asked for 'large lights,' they should look like functional, well-integrated lights, not messy blobs).\n\n"
    "2. STRUCTURAL INTEGRITY (THE 'BROKEN' TEST):\n"
    "- Scan all 4 views for catastrophic failures: melted regions, hollow voids where there should be volume, floating geometric 'shards', or mesh-tearing.\n"
    "- Ignore Minor Noise: Do not penalize for slight texture blurring or minor pixel jitter. Only penalize if the object feels 'broken' or 'collapsed'.\n\n"
    "### RULES OF JUDGMENT:\n"
    "- BE LENIENT ON ISOLATION: If the model changed the material of the whole car to match the new lights, and it looks good/coherent, do NOT fail it. "
    "Only fail if the change is 'weird' or breaks the object's logic.\n"
    "- BE STRICT ON WEIRDNESS: If an edit introduces 'unreasonable' structures (like a hole in the roof or a distorted door) "
    "that have nothing to do with the prompt, it is a FAILURE.\n"
    "- MULTI-VIEW CHECK: A structural break in any one of the 4 views constitutes an overall failure.\n\n"
    "### INSTRUCTIONS:\n"
    "1. Compare the two assets. Ask yourself: 'Is this a better or logically altered version of the original, or does it look broken/weird?'\n"
    "2. Identify any specific view (1-4) where the structure collapses or becomes unreasonable.\n"
    "3. Return ONLY a valid JSON object.\n\n"
    "### OUTPUT SCHEMA:\n"
    "{\n"
    "  \"evaluation_reasoning\": \"Describe why the edit either feels 'right' and coherent or why it feels 'weird', 'broken', or 'unreasonable'. Reference specific views if artifacts are present.\",\n"
    "  \"passed\": true/false\n"
    "}"
)

change_and_structure_system_prompt = (
    "You are a sophisticated Vision-Language Model specializing in the perceptual evaluation of 3D asset renders.\n\n"
    "### CONTEXT:\n"
    "- Input 1: An image containing 4 camera views (quad-view) of the 'Original Object'.\n"
    "- Input 2: An image containing 4 camera views (quad-view) of the 'Edited Object'.\n"
    "- Input 3: An 'Editing Prompt' describing the intended transformation.\n\n"
    "### YOUR TASK:\n"
    "Analyze all 4 views to determine if the editing process caused 'unreasonable' issues. "
    "You must distinguish between acceptable stylistic interpretations and unacceptable structural failures.\n\n"
    
    "1. REASONABLE & PROMPT-RELATED VARIATIONS (BE LENIENT):\n"
    "- If the prompted change is difficult to see, very subtle, or seems missing entirely "
    "(e.g., the prompt asked for a 'bigger head' but it looks the same), it is COMPLETELY FINE. Do not penalize for a lack of obvious change.\n"
    "- Forgive unprompted changes that are indirectly related to the prompt or follow its aesthetic theme.\n"
    "- Forgive misinterpretations where a change is visually similar to the prompt (e.g., if asked for 'extremely large eyes,' "
    "and they are rendered so big they resemble sunglasses, this is an acceptable stylistic interpretation).\n"
    "- Minor texture shifts, lighting variations, or incidental color bleeds in the general area of the edit are completely acceptable.\n\n"
    
    "2. PERCEPTUAL SANITY & STRUCTURAL INTEGRITY (BE STRICT):\n"
    "- Apply 'The Weird Test': Does the edit result in a look that is 'unreasonable' or 'illogical' for this type of object compared to the original?\n"
    "- Failure: Substantial unprompted changes that make NO sense (e.g., a hole appearing in a car roof when only the tires were edited, or a door melting into the body).\n"
    "- Failure: Structural degradation like heavily melted textures, floating/disconnected geometry, broken mesh patches, "
    "or distorted 'spikes' that look like generative glitches rather than intentional design.\n\n"
    
    "### EVALUATION RULES:\n"
    "- IGNORE BACKGROUND: Do not evaluate anything outside the foreground object.\n"
    "- MULTI-VIEW CONSISTENCY: If a 'weird' or 'broken' failure is visible in ANY of the 4 views, the asset fails.\n"
    "- LOGIC OVER ISOLATION: Do not fail an image just because it changed more than requested or the edit is too subtle. "
    "ONLY fail it if the unprompted change is illogical, broken, or perceptually 'wrong'.\n\n"
    
    "### INSTRUCTIONS:\n"
    "1. Identify the intended change based on the Editing Prompt.\n"
    "2. Scan all 4 views of the Edited Object. Compare them to the Original Object's structural logic.\n"
    "3. Determine if any unprompted changes are 'reasonable interpretations' (PASS) or 'illogical glitches' (FAIL).\n"
    "4. If the prompted change is not obvious, focus entirely on whether the rest of the object remained stable and logical.\n"
    "5. Return ONLY a valid JSON object without markdown formatting.\n\n"
    
    "### OUTPUT SCHEMA:\n"
    "{\n"
    "  \"evaluation_reasoning\": \"List spotted changes. Explain why they are either reasonable interpretations of the prompt or "
    "illogical/weird structural failures. Reference specific views (e.g., top-left) where issues occur.\",\n"
    "  \"passed\": true/false\n"
    "}"
)

chain_of_verification_prompt= (
    "You are a sophisticated evaluator specializing in human perception and 3D asset quality.\n\n"
    "### CONTEXT:\n"
    "- Input 1: Quad-view (4 camera angles) of an 'Original Object'.\n"
    "- Input 2: Quad-view (4 camera angles) of an 'Edited Object'.\n"
    "- Input 3: An 'Editing Prompt'.\n\n"
    "### YOUR GOAL:\n"
    "Evaluate if the edited object is a high-quality, logically coherent evolution of the original. "
    "You are checking for structural sanity and human preference, not strict adherence to isolation.\n\n"
    "### EVALUATION PROCESS (Internal Scratchpad):\n"
    "Before providing your final answer, you must internally:\n"
    "1. List all visual changes between the original and the edited object across all 4 views.\n"
    "2. For each change, determine if it results in a 'weird', broken, or illogical look (e.g., hollow voids, melted geometry, floating pieces, or nonsensical structural shifts).\n"
    "3. Ignore minor noise (slight texture blurring or pixel jitter). Only focus on changes that look 'wrong' or 'broken' to a human observer.\n\n"
    "### JUDGMENT RULES:\n"
    "- WEIRDNESS IS THE ONLY FAILURE: Only set `passed` to false if a change is structurally 'broken' or logically 'weird' (like a hole in a roof or a distorted limb).\n"
    "- QUALITY OVER ISOLATION: If the edit changed parts not mentioned in the prompt, but those parts still look high-quality and plausible, the object PASSES.\n"
    "- MULTI-VIEW CHECK: A structural break in any one of the 4 views constitutes an overall failure.\n\n"
    "### INSTRUCTIONS:\n"
    "1. Do not evaluate the background.\n"
    "2. Your 'reasoning' must start with a list of the spotted changes, followed by an evaluation of their structural logic.\n"
    "3. Return ONLY a valid JSON object without markdown formatting.\n\n"
    "### OUTPUT SCHEMA:\n"
    "{\n"
    "  \"passed\": true/false,\n"
    "  \"evaluation_reasoning\": \"[List of spotted changes] + [Evaluation of whether they are structurally logical or broken/weird].\"\n"
    "}"
)

def quality_and_change_control(ori_img_path: str, edited_img_path: str, editing_prompt: str) -> str:
    system_prompt = change_and_structure_system_prompt
    ori_b64 = _encode_image(ori_img_path)
    edited_b64 = _encode_image(edited_img_path)

    user_content = [        
        {"type": "text", "text": "Original Object:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{ori_b64}"}},
        {"type": "text", "text": "Edited Object:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{edited_b64}"}},
        {"type": "text", "text": f"Editing Prompt: '{editing_prompt}'"},
    ]

    resp = _client.chat.completions.create(
        model="gpt-5.2",
        temperature=0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "quality_and_change_control",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "evaluation_reasoning": {"type": "string"},
                        "passed": {"type": "boolean"},
                    },
                    "required": ["evaluation_reasoning", "passed"],
                },
            },
        },
    )
    return json.loads(resp.choices[0].message.content)


def select_most_representative_view(image_paths: List[str], model: str = "gpt-5.2", temperature: float = 0) -> dict:
    """Select the most representative camera view from multiple views of a 3D object.

    Args:
        image_paths: List of file paths to camera views (typically 5 views).
        model: OpenAI model name (must support vision).
        temperature: Sampling temperature.

    Returns:
        A dictionary containing:
        - selected_index: The 0-based index of the most representative view.
        - reasoning: Explanation for why this view was selected.
    """
    system_prompt = (
        "You are an expert 3D asset evaluator specializing in camera view selection.\n\n"
        "### CONTEXT:\n"
        "You will be provided with multiple camera views (typically 5) of the same 3D object.\n\n"
        "### YOUR TASK:\n"
        "Select the SINGLE most representative view that best captures the essence and key features of the 3D object.\n\n"
        "### EVALUATION CRITERIA:\n"
        "1. FEATURE VISIBILITY: The view should clearly show the most distinctive and important features of the object.\n"
        "2. OBJECT CLARITY: The view should provide a clear, unobstructed view of the object with minimal occlusion.\n"
        "3. INFORMATIVENESS: The view should convey the most information about the object's shape, structure, and appearance.\n"
        "4. TYPICAL VIEWING ANGLE: Prefer views that show the object from a natural, commonly used perspective (e.g., front-facing for characters, 3/4 view for vehicles).\n"
        "5. QUALITY: The view should be well-lit, properly rendered, and free from obvious artifacts.\n\n"
        "### INSTRUCTIONS:\n"
        "1. Carefully examine all provided views.\n"
        "2. Consider which single view would be most useful if someone could only see one image of this object.\n"
        "3. Return the 0-based index (0 for first image, 1 for second, etc.) of the most representative view.\n"
        "4. Provide clear reasoning for your selection.\n"
        "5. Return ONLY a valid JSON object without markdown formatting.\n\n"
        "### OUTPUT SCHEMA:\n"
        "{\n"
        "  \"selected_index\": <integer 0-based index>,\n"
        "  \"reasoning\": \"Explain why this specific view is most representative, referencing what makes it better than the other views.\"\n"
        "}"
    )

    # Build content with all images
    user_content = [{"type": "text", "text": f"Please analyze these {len(image_paths)} camera views of a 3D object and select the most representative one:"}]

    for idx, path in enumerate(image_paths):
        b64 = _encode_image(path)
        user_content.append({"type": "text", "text": f"View {idx}:"})
        user_content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})

    resp = _client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "view_selection",
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "selected_index": {"type": "integer"},
                        "reasoning": {"type": "string"},
                    },
                    "required": ["selected_index", "reasoning"],
                },
            },
        },
    )

    return json.loads(resp.choices[0].message.content)


def select_representative_views_for_directory(
    root_dir: str,
    out_dir: str = None,
    image_extensions: tuple = ('.png', '.jpg', '.jpeg'),
    model: str = "gpt-5.2",
    temperature: float = 0
) -> dict:
    """Process all subfolders and select the most representative view for each object.

    Args:
        root_dir: Root directory containing subfolders (each subfolder = one object).
        out_dir: Optional directory to copy selected views. Files are named using
                 the last underscore-separated part of the subfolder name.
        image_extensions: Tuple of valid image file extensions to consider.
        model: OpenAI model name (must support vision).
        temperature: Sampling temperature.

    Returns:
        A dictionary mapping subfolder names to their selection results:
        {
            "subfolder_name": {
                "selected_view": "path/to/selected/image.png",
                "selected_index": 2,
                "reasoning": "explanation...",
                "all_views": ["view0.png", "view1.png", ...]
            },
            ...
        }
    """
    results = {}

    # Create output directory if specified
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    # Get all subfolders
    subfolders = [f for f in os.listdir(root_dir) if os.path.isdir(os.path.join(root_dir, f))]

    print(f"Found {len(subfolders)} subfolders to process...")

    for idx, subfolder in enumerate(sorted(subfolders)):
        subfolder_path = os.path.join(root_dir, subfolder)

        # Get all image files in this subfolder
        image_files = sorted([
            f for f in os.listdir(subfolder_path)
            if f.lower().endswith(image_extensions)
        ])

        image_files = image_files[:5]

        if len(image_files) == 0:
            print(f"[{idx+1}/{len(subfolders)}] Skipping {subfolder}: No images found")
            results[subfolder] = {
                "error": "No images found in subfolder",
                "all_views": []
            }
            continue

        # Build full paths
        image_paths = [os.path.join(subfolder_path, f) for f in image_files]

        print(f"[{idx+1}/{len(subfolders)}] Processing {subfolder} with {len(image_files)} views...")

        try:
            # Select the most representative view
            selection_result = select_most_representative_view(
                image_paths, model=model, temperature=temperature
            )

            selected_idx = selection_result["selected_index"]
            selected_view = image_paths[selected_idx]

            results[subfolder] = {
                "selected_view": selected_view,
                "selected_index": selected_idx,
                "reasoning": selection_result["reasoning"],
                "all_views": image_files
            }

            print(f"  → Selected view {selected_idx}: {image_files[selected_idx]}")
            print(f"  → Reasoning: {selection_result['reasoning'][:100]}...")

            # Copy selected view to output directory with renamed file
            if out_dir:
                # Extract the last underscore-separated part of the subfolder name
                name_parts = subfolder.split('_')
                new_filename = name_parts[-1]

                # Preserve the file extension from the selected view
                _, ext = os.path.splitext(selected_view)
                if not new_filename.endswith(ext):
                    new_filename = f"{new_filename}{ext}"

                dest_path = os.path.join(out_dir, new_filename)
                shutil.copy2(selected_view, dest_path)
                print(f"  → Copied to: {dest_path}")

                results[subfolder]["copied_to"] = dest_path

        except Exception as e:
            print(f"  → Error processing {subfolder}: {str(e)}")
            results[subfolder] = {
                "error": str(e),
                "all_views": image_files
            }

    return results


def quality_and_change_control_gemini(ori_img_path: str, edited_img_path: str, editing_prompt: str, model: str = "gemini-2.5-flash") -> dict:
    system_prompt = change_and_structure_system_prompt

    ori_bytes = open(ori_img_path, "rb").read()
    edited_bytes = open(edited_img_path, "rb").read()

    resp = _gemini_client.models.generate_content(
        model=model,
        contents=[{
            "role": "user",
            "parts": [
                {"text": system_prompt},
                {"text": "Original Object:"},
                {"inline_data": {"data": ori_bytes, "mime_type": "image/png"}},
                {"text": "Edited Object:"},
                {"inline_data": {"data": edited_bytes, "mime_type": "image/png"}},
                {"text": f"Editing Prompt: '{editing_prompt}'"},
            ],
        }],
        config={
            "temperature": 0,
            "response_mime_type": "application/json",
            "response_schema": {
                "type": "OBJECT",
                "properties": {
                    "evaluation_reasoning": {"type": "STRING"},
                    "passed": {"type": "BOOLEAN"},
                },
                "required": ["evaluation_reasoning", "passed"],
            },
        },
    )
    return json.loads(resp.text)


if __name__ == "__main__":
    select_representative_views_for_directory(
        root_dir='/home/rwang/TRELLIS/validation/new_val_best_views_RM_edppv2_mv40_verify_gpt52',
        out_dir='/data/ru_data/sliders/representative_views',
    )


    