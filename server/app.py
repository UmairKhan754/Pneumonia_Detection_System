# ==============================================================================
#  PneumoScan AI – Flask Backend (v3.4 •  Heatmap)
# ================================================================================

import os
import io
import re
import base64
import time
import logging
from typing import Optional, Tuple

import numpy as np
import cv2
from PIL import Image

from flask import Flask, request, jsonify, g
from flask_cors import CORS

# TensorFlow / Keras
import tensorflow as tf
from tensorflow.keras.applications.efficientnet import preprocess_input
from tensorflow.keras.models import load_model

# PyTorch / CLIP
import torch
from transformers import CLIPProcessor, CLIPModel

# ---------------- CONFIG ----------------
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Max upload 64MB
MAX_UPLOAD_MB = 64

# Update these absolute paths for your machine:
STAGE1_MODEL_PATH = r"D:\PneumoniaWeb\server\model\efficientnetb0_stage1_norm_vs_pneu_fixed.keras"
STAGE2_MODEL_PATH = r"D:\PneumoniaWeb\server\model\New_efficientnetb0_stage2_bac_vs_vir.keras"

STAGE1_CLASSES = ["Normal", "Pneumonia"]
STAGE2_CLASSES = ["Bacterial Pneumonia", "Viral Pneumonia"]

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "bmp"}
IMG_SIZE = (224, 224)
CLIP_MODEL_NAME = "openai/clip-vit-base-patch32"

# Confidence thresholds
MIN_CONFIDENCE_STAGE1 = 60.0   # %
MIN_CONFIDENCE_STAGE2 = 55.0   # %

# ---------------- APP + LOGGING ----------------
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# CORS for local frontend
CORS(app, resources={r"/*": {"origins": [
    "http://127.0.0.1:5500",
    "http://localhost:5500"
]}})

# Logging: single-process (no reloader) + INFO level
LOG_FORMAT = "[%(asctime)s] %(levelname)s in %(module)s: %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
logger = logging.getLogger(__name__)
logging.getLogger("werkzeug").setLevel(logging.INFO)

def banner(title: str):
    """Print formatted banner for request tracking"""
    lines = "=" * 60
    print(f"\n{lines}\n{title}\n{lines}", flush=True)

@app.before_request
def _before():
    """Timing and request logging"""
    g._t0 = time.perf_counter()
    print(f"➡  {request.method} {request.path}  from {request.remote_addr}", flush=True)

@app.after_request
def _after(resp):
    """Response timing and logging"""
    dt = (time.perf_counter() - getattr(g, "_t0", time.perf_counter())) * 1000.0
    size = resp.calculate_content_length() or 0
    print(f"⬅  {resp.status_code} {request.path}  ({size}B, {dt:.1f} ms)", flush=True)
    return resp

# ---------------- Load CLIP once (global) ----------------
device = "cuda" if torch.cuda.is_available() else "cpu"
print(" Loading CLIP model once...", flush=True)
clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_NAME)
clip_model = CLIPModel.from_pretrained(CLIP_MODEL_NAME).to(device)
clip_model.eval()
print(" CLIP model ready.", flush=True)

# ---------------- Helpers: input decoding ----------------
DATAURL_RE = re.compile(r"^data:image/[^;]+;base64,(.*)$", re.IGNORECASE)

def allowed_file(filename: str) -> bool:
    """Check if file extension is allowed"""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def _b64_to_bytes(b64_str: str) -> bytes:
    """Convert base64 or dataURL to bytes"""
    m = DATAURL_RE.match(b64_str.strip())
    if m:
        b64_str = m.group(1)
    return base64.b64decode(b64_str)

def decode_from_request() -> Tuple[Optional[np.ndarray], Optional[Image.Image], str, Optional[str]]:
    """
    Accept:
      - multipart/form-data (file)
      - JSON with {'image_b64': '<base64 or dataURL>'}
    Returns: (img_bgr, pil_img, source_mode, error_msg)
    """
    try:
        if request.files and "file" in request.files:
            f = request.files["file"]
            if f.filename == "" or not allowed_file(f.filename):
                return None, None, "file", "Unsupported or empty file."
            img_bytes = f.read()
            source = "file"
        else:
            payload = None
            try:
                payload = request.get_json(force=True, silent=False)
            except Exception:
                pass
            if not payload or "image_b64" not in payload:
                return None, None, "json", "No file or image_b64 provided."
            img_bytes = _b64_to_bytes(payload["image_b64"])
            source = "json"

        np_arr = np.frombuffer(img_bytes, np.uint8)
        img_bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        pil_img = None
        try:
            pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        except Exception:
            pass

        if img_bgr is None:
            return None, None, source, "Cannot decode image."

        return img_bgr, pil_img, source, None
    except Exception as e:
        return None, None, "exception", f"Decode error: {e}"

def preprocess_for_model_from_bgr(bgr_img: np.ndarray) -> np.ndarray:
    """Resize -> RGB -> EfficientNet preprocess_input -> [1,H,W,C]"""
    img = cv2.resize(bgr_img, IMG_SIZE, interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    arr = np.expand_dims(rgb.astype(np.float32), axis=0)
    arr = preprocess_input(arr)
    return arr

# ---------------- Validator (UNCHANGED) ----------------
class ChestXRayValidator:
    """
    Same lenient validator as earlier:
      - Heuristic + Saturation must pass
      - CLIP modality: only hard-reject if strongly non-Xray (diff < -0.15)
      - CLIP body-part: only hard-reject non-chest if high score (> 0.45)
    """
    def __init__(self):
        self.min_mean = 10
        self.max_mean = 245
        self.min_var = 60
        self.edge_threshold = 0.0005
        self.min_size = 100
        self.sat_thresh = 60
        self.clip_modality_threshold = 0.25
        self.clip_strong_reject_margin = -0.15
        self.bodypart_reject_score = 0.45

    def compute_metrics(self, bgr):
        resized = cv2.resize(bgr, IMG_SIZE)
        mean_pix = float(np.mean(resized))
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        var = float(np.var(gray))
        edges = cv2.Canny(gray, 50, 150)
        edge_density = float(edges.sum() / (IMG_SIZE[0]*IMG_SIZE[1]*255.0))
        hsv = cv2.cvtColor(resized, cv2.COLOR_BGR2HSV)
        sat_mean = float(np.mean(hsv[:, :, 1]))
        return mean_pix, var, edge_density, sat_mean

    def heuristic_validate_from_array(self, image_array):
        try:
            img_bgr = image_array
            if img_bgr is None:
                return False, "File could not be read as image."
            if img_bgr.ndim == 2:
                img_bgr = cv2.cvtColor(img_bgr, cv2.COLOR_GRAY2BGR)
            h, w = img_bgr.shape[:2]
            if h < self.min_size or w < self.min_size:
                return False, f"Image too small ({w}x{h})."

            mean_pix, var, edge_density, sat_mean = self.compute_metrics(img_bgr)

            if not (self.min_mean <= mean_pix <= self.max_mean):
                return False, f"Brightness out of range (mean={mean_pix:.1f})."
            if var < self.min_var:
                return False, f"Low variance: {var:.1f}."
            if edge_density < self.edge_threshold:
                return False, f"Low edge density ({edge_density:.6f})."
            if sat_mean > self.sat_thresh:
                return False, f"Too colorful (sat={sat_mean:.1f})."

            return True, "Heuristic checks passed."
        except Exception as e:
            return False, f"Heuristic validation error: {e}"

    def clip_modality_check(self, pil_img: Image.Image):
        prompts = ["This is a chest X-ray image.", "This is a normal photograph."]
        try:
            inputs = clip_processor(text=prompts, images=pil_img, return_tensors="pt", padding=True).to(device)
            with torch.no_grad():
                outputs = clip_model(**inputs)
            logits = outputs.logits_per_image.softmax(dim=1).cpu().numpy()[0]
            score_xray = float(logits[0]); score_photo = float(logits[1])
            diff = score_xray - score_photo
            return True, (diff > self.clip_modality_threshold), diff, score_xray, score_photo
        except Exception:
            return False, False, 0.0, 0.0, 0.0

    def clip_bodypart_check(self, pil_img: Image.Image):
        prompts = [
            "This is a chest X-ray image.",
            "This is a foot X-ray image.",
            "This is a hand X-ray image.",
            "This is a dental X-ray image.",
            "This is a skull X-ray image."
        ]
        try:
            inputs = clip_processor(text=prompts, images=pil_img, return_tensors="pt", padding=True).to(device)
            with torch.no_grad():
                outputs = clip_model(**inputs)
            probs = outputs.logits_per_image.softmax(dim=1).cpu().numpy()[0]
            best_idx = int(np.argmax(probs))
            best_label = prompts[best_idx]
            best_score = float(probs[best_idx])
            return True, best_label, best_score
        except Exception:
            return False, "error", 0.0

    def validate_chest_xray_from_array(self, image_array):
        notes = []
        metrics = {}

        heur_ok, heur_msg = self.heuristic_validate_from_array(image_array)
        notes.append(heur_msg)

        try:
            mean_pix, var, edge_density, sat_mean = self.compute_metrics(image_array)
            metrics.update({
                "mean_pix": mean_pix,
                "variance": var,
                "edge_density": edge_density,
                "sat_mean": sat_mean
            })
        except Exception as e:
            notes.append(f"Metrics error: {e}")

        pil_img = None
        try:
            pil_img = Image.fromarray(cv2.cvtColor(image_array, cv2.COLOR_BGR2RGB)).convert("RGB")
        except Exception as e:
            notes.append(f"PIL conversion error: {e}")

        clip_checked, clip_is_xray, clip_diff, clip_xray_score, clip_photo_score = False, False, 0.0, 0.0, 0.0
        body_checked, body_label, body_score = False, "error", 0.0

        if pil_img is not None:
            clip_checked, clip_is_xray, clip_diff, clip_xray_score, clip_photo_score = self.clip_modality_check(pil_img)
            notes.append(f"CLIP modality: checked={clip_checked}, is_xray={clip_is_xray}, diff={clip_diff:.3f}, xray={clip_xray_score:.3f}, photo={clip_photo_score:.3f}")
            body_checked, body_label, body_score = self.clip_bodypart_check(pil_img)
            notes.append(f"CLIP bodypart: {body_label} (score={body_score:.3f})")

        validation_ok = bool(heur_ok)

        if clip_checked and (clip_diff < self.clip_strong_reject_margin):
            validation_ok = False
            notes.append("Rejected: CLIP strongly indicates NOT an X-ray.")

        if body_checked and ("chest" not in body_label.lower()) and (body_score > self.bodypart_reject_score):
            validation_ok = False
            notes.append(f"Rejected: Detected {body_label} with high score ({body_score:.2f}).")

        report = {
            "metrics": metrics,
            "clip_modality_checked": bool(clip_checked),
            "clip_modality_is_xray": bool(clip_is_xray),
            "clip_modality_diff": float(clip_diff),
            "clip_xray_score": float(clip_xray_score),
            "clip_photo_score": float(clip_photo_score),
            "clip_bodypart_checked": bool(body_checked),
            "clip_bodypart_label": body_label,
            "clip_bodypart_score": float(body_score),
            "final_decision": bool(validation_ok),
            "notes": notes
        }

        # Simple aggregated score for UI (unchanged)
        try:
            passed = 0
            total = 4
            if heur_ok: passed += 1
            if clip_checked and clip_is_xray: passed += 1
            if body_checked and "chest" in body_label.lower(): passed += 1
            mp = metrics.get("mean_pix", 0.0)
            passed += 1 if (self.min_mean <= mp <= self.max_mean) else 0
            rule_score = passed/total
        except Exception:
            rule_score = 0.5

        return validation_ok, float(rule_score), report

validator = ChestXRayValidator()

# ---------------- TF model loading ----------------
def tf_setup_and_load(model_path: str, model_name: str):
    """Configure TensorFlow and load model with sanity check"""
    try:
        import multiprocessing
        cores = multiprocessing.cpu_count()
        tf.config.threading.set_inter_op_parallelism_threads(max(1, cores // 2))
        tf.config.threading.set_intra_op_parallelism_threads(max(1, cores // 2))
    except Exception as e:
        print("TF threading config warning:", e, flush=True)

    gpus = tf.config.list_physical_devices('GPU')
    if gpus:
        try:
            for g in gpus:
                tf.config.experimental.set_memory_growth(g, True)
            print(f" GPU configured for {model_name}", flush=True)
        except Exception as e:
            print(f"GPU config warning for {model_name}: {e}", flush=True)

    try:
        print(f" Loading {model_name} from: {model_path}", flush=True)
        model = load_model(model_path)

        # quick sanity test
        dummy_input = np.random.rand(1, IMG_SIZE[0], IMG_SIZE[1], 3).astype(np.float32)
        dummy_pred = model.predict(dummy_input, verbose=0)
        max_prob = np.max(dummy_pred[0]); min_prob = np.min(dummy_pred[0])
        diversity = float(max_prob - min_prob)
        print(f" {model_name} output diversity: {diversity:.3f}", flush=True)
        if diversity < 0.1:
            print(f"  WARNING: {model_name} low diversity – double-check weights", flush=True)

        return model

    except Exception as e:
        print(f" Error loading {model_name}: {e}", flush=True)
        return None

print(" Loading TF classification models (startup)...", flush=True)
stage1_model = tf_setup_and_load(STAGE1_MODEL_PATH, "Stage1 Model")
stage2_model = tf_setup_and_load(STAGE2_MODEL_PATH, "Stage2 Model")

# ----------------  GRAD-CAM Helpers ----------------
def find_last_conv_layer(model):
    """Find last convolutional layer automatically"""
    for layer in reversed(model.layers):
        if isinstance(layer, tf.keras.layers.Conv2D):
            return layer.name
    return "top_conv"

def generate_gradcam_heatmap(model, img_array, pred_index=None):
    """
     Grad-CAM - Simple & Effective
    """
    try:
        # Find target layer automatically
        layer_name = find_last_conv_layer(model)
        
        grad_model = tf.keras.models.Model(
            inputs=model.inputs,
            outputs=[model.get_layer(layer_name).output, model.output]
        )

        with tf.GradientTape() as tape:
            conv_outputs, predictions = grad_model(img_array)
            if pred_index is None:
                pred_index = tf.argmax(predictions[0])
            loss = predictions[:, pred_index]

        # Compute gradients
        grads = tape.gradient(loss, conv_outputs)
        
        # Global average pooling
        pooled_grads = tf.reduce_mean(grads, axis=(0, 1, 2))
        
        # Generate heatmap 
        conv_outputs = conv_outputs[0]
        heatmap = conv_outputs * pooled_grads
        heatmap = tf.reduce_sum(heatmap, axis=-1)
        
        # ReLU and normalize
        heatmap = tf.maximum(heatmap, 0)
        heatmap = heatmap / (tf.reduce_max(heatmap) + 1e-10)
        
        print(f"  Grad-CAM generated from layer: {layer_name}", flush=True)
        return heatmap.numpy()

    except Exception as e:
        print(f" Grad-CAM generation error: {e}", flush=True)
        return None

def create_heatmap_overlay(original_img_bgr, heatmap, alpha=0.4):
    """
     Overlay - Clean & Simple with CORRECT COLORS
    """
    try:
        H, W = original_img_bgr.shape[:2]
        
        # Resize heatmap to original image size
        heatmap_resized = cv2.resize(heatmap, (W, H))
        
        # Convert to uint8 and apply colormap - CORRECT COLOR ORDER
        heatmap_uint8 = np.uint8(255 * heatmap_resized)
        
        # Apply JET colormap (Colab style - Red for high activation)
        heatmap_colored = cv2.applyColorMap(heatmap_uint8, cv2.COLORMAP_JET)
        # >>> FIX: convert to RGB before blending with RGB original <<<
        heatmap_colored = cv2.cvtColor(heatmap_colored, cv2.COLOR_BGR2RGB)
        
        # Convert original to RGB
        original_rgb = cv2.cvtColor(original_img_bgr, cv2.COLOR_BGR2RGB)
        
        # Simple weighted overlay (Colab style)
        superimposed = cv2.addWeighted(original_rgb, 1 - alpha, heatmap_colored, alpha, 0)
        
        # Convert back to BGR
        superimposed_bgr = cv2.cvtColor(superimposed, cv2.COLOR_RGB2BGR)
        
        print(" overlay applied - CORRECT COLORS (Red=High, Blue=Low)", flush=True)
        return superimposed_bgr
        
    except Exception as e:
        print(f" Overlay error: {e}", flush=True)
        return None

def create_blue_only_overlay(original_bgr, heatmap, alpha=0.4):
    """
    Returns BGR overlay image using a cool/blue map only (for Normal cases).
    No warm colors so Normal looks 'calm'.
    """
    try:
        H, W = original_bgr.shape[:2]
        hm = cv2.resize(heatmap, (W, H))

        # Clamp the heat to keep it cool (reduce intensity and remove hotspots)
        hm = np.clip(hm, 0.0, 0.35) / 0.35  # cap at 35% then normalize [0..1]
        hm8 = np.uint8(hm * 255)

        # Build a blue/cyan-ish map (B strong, G faint, R zero)
        B = hm8
        G = (hm8 // 3)
        R = np.zeros_like(hm8)
        blue_map = cv2.merge([B, G, R])  # BGR

        original_rgb = cv2.cvtColor(original_bgr, cv2.COLOR_BGR2RGB)
        overlay_rgb = cv2.addWeighted(original_rgb, 1 - alpha, cv2.cvtColor(blue_map, cv2.COLOR_BGR2RGB), alpha, 0)
        return cv2.cvtColor(overlay_rgb, cv2.COLOR_RGB2BGR)
    except Exception as e:
        print("Blue overlay error:", e, flush=True)
        return None

def image_to_base64(image_array_bgr):
    """Convert BGR image array to base64 data URL"""
    try:
        if image_array_bgr.dtype != np.uint8:
            image_array_bgr = np.clip(image_array_bgr, 0, 255).astype(np.uint8)
        pil_img = Image.fromarray(cv2.cvtColor(image_array_bgr, cv2.COLOR_BGR2RGB))
        buffer = io.BytesIO()
        pil_img.save(buffer, format='JPEG', quality=90)
        img_str = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/jpeg;base64,{img_str}"
    except Exception as e:
        print(f"Base64 conversion error: {e}", flush=True)
        return None

# ---------------- Comment helpers (formerly Caption) ----------------
def build_comment_text(stage1_label: str, stage2_label: Optional[str]) -> str:
    """
    CHANGED: Generate comment text based on diagnosis
    Updated terminology: "Comment" instead of "Caption"
    """
    if stage1_label == "Normal":
        return "This chest X-ray appears normal with clear lungs and no signs of pneumonia."
    if stage2_label is None:
        return "This chest X-ray shows abnormalities suggesting pneumonia."
    if "Bacterial" in stage2_label:
        return "This chest X-ray shows radiographic features consistent with bacterial pneumonia."
    if "Viral" in stage2_label:
        return "This chest X-ray shows radiographic features consistent with viral pneumonia."
    return "This chest X-ray demonstrates findings concerning for pneumonia."

def get_clip_comment_score(pil_img: Optional[Image.Image], prompt: str) -> Optional[float]:
    """Get CLIP score for comment relevance (unchanged functionality)"""
    try:
        if pil_img is None:
            return None
        inputs = clip_processor(text=[prompt], images=pil_img, return_tensors="pt", padding=True).to(device)
        with torch.no_grad():
            logits = clip_model(**inputs).logits_per_image.softmax(dim=1).cpu().numpy()[0]
        return float(logits[0])
    except Exception as e:
        print("CLIP comment error:", e, flush=True)
        return None

# ---------------- Health/Test ----------------
@app.route("/health", methods=["GET"])
def health_check():
    """Health check endpoint - unchanged"""
    models_loaded = {
        "stage1_model": stage1_model is not None,
        "stage2_model": stage2_model is not None,
        "clip_model": clip_model is not None
    }
    test_results = {}
    if stage1_model:
        try:
            dummy = np.random.rand(1, 224, 224, 3).astype(np.float32)
            pred = stage1_model.predict(dummy, verbose=0)
            test_results["stage1"] = "functional"
            test_results["stage1_output_sample"] = [float(x) for x in pred[0]]
        except Exception as e:
            test_results["stage1"] = f"error: {str(e)}"
    if stage2_model:
        try:
            dummy = np.random.rand(1, 224, 224, 3).astype(np.float32)
            pred = stage2_model.predict(dummy, verbose=0)
            test_results["stage2"] = "functional"
            test_results["stage2_output_sample"] = [float(x) for x in pred[0]]
        except Exception as e:
            test_results["stage2"] = f"error: {str(e)}"
    return jsonify({"status": "healthy", "models": models_loaded, "tests": test_results})

@app.route("/test-models", methods=["GET"])
def test_models():
    """Model testing endpoint - unchanged"""
    test_results = {}
    if stage1_model:
        try:
            test_images = [
                np.random.rand(1, 224, 224, 3).astype(np.float32),
                np.ones((1, 224, 224, 3)).astype(np.float32) * 0.5,
                np.zeros((1, 224, 224, 3)).astype(np.float32)
            ]
            stage1_results = []
            for i, test_img in enumerate(test_images):
                pred = stage1_model.predict(test_img, verbose=0)
                stage1_results.append({
                    f"test_{i}": {
                        "raw_outputs": [float(x) for x in pred[0]],
                        "probabilities": {STAGE1_CLASSES[j]: f"{float(p)*100:.1f}%" for j, p in enumerate(pred[0])},
                        "prediction": STAGE1_CLASSES[int(np.argmax(pred[0]))],
                        "confidence": float(np.max(pred[0]) * 100)
                    }
                })
            test_results["stage1"] = stage1_results
        except Exception as e:
            test_results["stage1"] = f"Error: {str(e)}"
    if stage2_model:
        try:
            test_img = np.random.rand(1, 224, 224, 3).astype(np.float32)
            pred = stage2_model.predict(test_img, verbose=0)
            test_results["stage2"] = {
                "raw_outputs": [float(x) for x in pred[0]],
                "probabilities": {STAGE2_CLASSES[j]: f"{float(p)*100:.1f}%" for j, p in enumerate(pred[0])},
                "prediction": STAGE2_CLASSES[int(np.argmax(pred[0]))],
                "confidence": float(np.max(pred[0]) * 100)
            }
        except Exception as e:
            test_results["stage2"] = f"Error: {str(e)}"
    return jsonify({"test_results": test_results})

# ---------------- Validate & Analyze ----------------
@app.route("/validateXray", methods=["POST"])
def validate_xray():
    """X-ray validation endpoint - unchanged"""
    banner(" VALIDATION REQUEST")
    img_bgr, pil_img, mode, err = decode_from_request()
    if img_bgr is None:
        print(" Decode failed:", err, flush=True)
        return jsonify({"success": False, "error": err, "mode": mode}), 400

    is_valid, confidence_like, report = validator.validate_chest_xray_from_array(img_bgr)
    print(f" Validation result: {is_valid}  (score≈{confidence_like:.2f})", flush=True)
    return jsonify({
        "success": True,
        "is_valid_chest_xray": bool(is_valid),
        "confidence_like": float(confidence_like),
        "report": report
    })

@app.route("/analyzeXray", methods=["POST"])
def analyze_xray():
    """
    INITIAL ANALYSIS ONLY (NO HEATMAP, NO COMMENT)
      - Stage1: Normal vs Pneumonia
      - If Pneumonia -> Stage2: Bacterial vs Viral
    """
    banner(" INITIAL ANALYSIS")
    img_bgr, pil_img, mode, err = decode_from_request()
    if img_bgr is None:
        print(" Decode failed:", err, flush=True)
        return jsonify({"success": False, "error": err, "mode": mode}), 400

    # 1) Validation (unchanged)
    is_valid, _, report = validator.validate_chest_xray_from_array(img_bgr)
    if not is_valid:
        print(" Validation failed", flush=True)
        return jsonify({"success": False, "error": "Invalid chest X-ray", "validation_report": report}), 400
    print(" Validation passed", flush=True)

    try:
        # 2) Preprocess
        x = preprocess_for_model_from_bgr(img_bgr)
        if stage1_model is None:
            return jsonify({"success": False, "error": "Stage1 model not loaded"}), 500

        # 3) Stage 1
        print(" Stage 1: Normal vs Pneumonia", flush=True)
        preds = stage1_model.predict(x, verbose=0)[0]
        idx = int(np.argmax(preds))
        conf1 = float(np.max(preds) * 100)
        stage1_label = STAGE1_CLASSES[idx]
        print(f" Stage 1 → {stage1_label} ({conf1:.1f}%)", flush=True)

        result = {"stage1": {"prediction": stage1_label, "confidence": conf1}, "stage2": None}

        # If Normal -> STOP here
        if stage1_label == "Normal":
            if conf1 < MIN_CONFIDENCE_STAGE1:
                stage1_label = f"Uncertain {stage1_label}"
            print(" Initial analysis complete (Normal).", flush=True)
            return jsonify({
                "success": True,
                "analysis": result,
                "final_prediction": stage1_label,
                "final_confidence": conf1,
                "validation_report": report
            })

        # If Pneumonia -> Stage 2
        if stage2_model is None:
            return jsonify({"success": False, "error": "Stage2 model not loaded"}), 500

        print(" Stage 2: Bacterial vs Viral", flush=True)
        preds2 = stage2_model.predict(x, verbose=0)[0]
        idx2 = int(np.argmax(preds2))
        conf2 = float(np.max(preds2) * 100)
        stage2_label = STAGE2_CLASSES[idx2]
        if conf2 < MIN_CONFIDENCE_STAGE2:
            stage2_label = f"Uncertain {stage2_label}"

        result["stage2"] = {"prediction": stage2_label, "confidence": conf2}
        print(f" Stage 2 → {stage2_label} ({conf2:.1f}%)", flush=True)
        print(" Initial analysis complete (Pneumonia).", flush=True)

        return jsonify({
            "success": True,
            "analysis": result,
            "final_prediction": stage2_label,
            "final_confidence": conf2,
            "validation_report": report
        })

    except Exception as e:
        print(f" Analysis error: {e}", flush=True)
        logger.exception("Analysis error")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/furtherAnalysis", methods=["POST"])
def further_analysis():
    """
    FURTHER ANALYSIS (user clicks "Further Analysis")
    NOW WITH  PERFECT HEATMAP
    """
    banner(" FURTHER ANALYSIS WITH  HEATMAP")
    img_bgr, pil_img, mode, err = decode_from_request()
    if img_bgr is None:
        print(" Decode failed:", err, flush=True)
        return jsonify({"success": False, "error": err, "mode": mode}), 400

    is_valid, _, report = validator.validate_chest_xray_from_array(img_bgr)
    if not is_valid:
        print(" Validation failed (further)", flush=True)
        return jsonify({"success": False, "error": "Invalid chest X-ray", "validation_report": report}), 400

    try:
        x = preprocess_for_model_from_bgr(img_bgr)
        if stage1_model is None:
            return jsonify({"success": False, "error": "Stage1 model not loaded"}), 500

        # Quick classify again to determine case type
        preds1 = stage1_model.predict(x, verbose=0)[0]
        idx1 = int(np.argmax(preds1))
        conf1 = float(np.max(preds1) * 100)
        stage1_label = STAGE1_CLASSES[idx1]
        print(f" (Further) Stage1 → {stage1_label} ({conf1:.1f}%)", flush=True)

        final_prediction = stage1_label
        final_confidence = conf1
        stage2_label: Optional[str] = None
        analyzed_xray_b64: Optional[str] = None

        if stage1_label == "Normal":
            print(" Normal case - skipping heatmap generation", flush=True)
            
            original_resized = cv2.resize(img_bgr, IMG_SIZE)
            analyzed_xray_b64 = image_to_base64(original_resized)
            print(" Normal case: Using original image as Analyzed X-Ray", flush=True)

        else:
            if stage2_model is None:
                return jsonify({"success": False, "error": "Stage2 model not loaded"}), 500
            preds2 = stage2_model.predict(x, verbose=0)[0]
            idx2 = int(np.argmax(preds2))
            conf2 = float(np.max(preds2) * 100)
            stage2_label = STAGE2_CLASSES[idx2]
            if conf2 < MIN_CONFIDENCE_STAGE2:
                stage2_label = f"Uncertain {stage2_label}"
            final_prediction = stage2_label
            final_confidence = conf2

            print(" (Further) Generating heatmap for Pneumonia case...", flush=True)
            
            # Use  Grad-CAM
            heatmap = generate_gradcam_heatmap(stage2_model, x, idx2)
            if heatmap is None:
                print("  Stage2 heatmap failed. Trying Stage1...", flush=True)
                heatmap = generate_gradcam_heatmap(stage1_model, x, idx1)

            if heatmap is not None:
                original_resized = cv2.resize(img_bgr, IMG_SIZE)
                
                # Use  overlay
                overlay_bgr = create_heatmap_overlay(original_resized, heatmap, alpha=0.4)
                
                if overlay_bgr is not None:
                    analyzed_xray_b64 = image_to_base64(overlay_bgr)
                    print(" (Further) PERFECT heatmap generated", flush=True)
                    print("   - Automatic layer detection", flush=True)
                    print("   - Clean weighted overlay", flush=True)
                    print("   - Professional medical visualization", flush=True)
                else:
                    # Fallback to original image if heatmap fails
                    analyzed_xray_b64 = image_to_base64(original_resized)
                    print(" (Further)  overlay failed, using original image", flush=True)
            else:
                original_resized = cv2.resize(img_bgr, IMG_SIZE)
                analyzed_xray_b64 = image_to_base64(original_resized)
                print(" (Further)  heatmap generation failed, using original image", flush=True)

        # Generate comment
        comment_text = build_comment_text(stage1_label, stage2_label)
        comment_score = get_clip_comment_score(pil_img, comment_text)
        print(f" Comment: {comment_text}", flush=True)
        print(f" CLIP score: {comment_score}", flush=True)

        return jsonify({
            "success": True,
            "final_prediction": final_prediction,
            "final_confidence": final_confidence,
            "heatmap": analyzed_xray_b64,
            "comment": {"text": comment_text, "score": comment_score},
            "validation_report": report
        })

    except Exception as e:
        print(f" Further analysis error: {e}", flush=True)
        logger.exception("Further analysis error")
        return jsonify({"success": False, "error": str(e)}), 500

# ---------------- RUN ----------------
if __name__ == "__main__":
    print("\n" + " " * 20)
    print("PneumoScan AI Backend (v3.4 -  Heatmap) Starting...")
    print(" " * 20)

    print("\n MODEL STATUS:")
    print(f" Stage 1 Model: {'LOADED' if stage1_model else 'FAILED'}")
    print(f" Stage 2 Model: {'LOADED' if stage2_model else 'FAILED'}")
    print(f" CLIP Model: LOADED")
    if not stage1_model or not stage2_model:
        print("\n⚠  WARNING: Some models failed to load. Check model paths and files.")
    
    print("\n   HEATMAP FEATURES:")
    print("    Automatic layer detection")
    print("    Simple & clean Grad-CAM")
    print("    Clean weighted overlay")
    print("    Professional medical visualization")
    print("    No color spill issues")
    
    print("\n Server at http://127.0.0.1:5000")
    print(" Endpoints:")
    print("   - GET  /health")
    print("   - GET  /test-models")
    print("   - POST /validateXray      (file OR JSON image_b64)")
    print("   - POST /analyzeXray       (initial only: stage1 [+stage2])")
    print("   - POST /furtherAnalysis   ( heatmap + comment)")

    # No reloader (avoids duplicate logs). Threaded for snappy local dev.
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False, threaded=True)
