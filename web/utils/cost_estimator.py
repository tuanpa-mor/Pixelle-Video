from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass
class CostEstimate:
    total_usd: float
    breakdown: list[dict]
    assumptions: list[str]


def _detect_llm_provider(base_url: str, model: str) -> str:
    host = (urlparse(base_url).hostname or "").lower()
    model_lower = (model or "").lower()

    if "deepseek" in host or model_lower.startswith("deepseek"):
        return "deepseek"
    if "dashscope" in host or model_lower.startswith("qwen"):
        return "dashscope"
    if "openai" in host or model_lower.startswith("gpt") or model_lower.startswith("o1") or model_lower.startswith("o3"):
        return "openai"
    if "volces" in host or "ark" in host or "seed" in model_lower:
        return "ark"
    if "googleapis" in host or "google" in host or "gemini" in model_lower:
        return "gemini"
    return "other"


def _estimate_llm_cost_usd(provider: str, text_length: int, n_scenes: int, mode: str) -> tuple[float, str]:
    estimated_input_tokens = max(300, int(text_length / 3))
    estimated_output_tokens = 900 if mode == "generate" else 700
    estimated_output_tokens += max(0, n_scenes - 5) * 90

    price_per_1k = {
        "deepseek": (0.0002, 0.0005),
        "dashscope": (0.0008, 0.0020),
        "openai": (0.0050, 0.0150),
        "ark": (0.0012, 0.0030),
        "gemini": (0.0008, 0.0025),
        "other": (0.0015, 0.0040),
    }
    input_rate, output_rate = price_per_1k.get(provider, price_per_1k["other"])
    total = (estimated_input_tokens / 1000.0) * input_rate + (estimated_output_tokens / 1000.0) * output_rate
    detail = f"LLM ~ {estimated_input_tokens} in / {estimated_output_tokens} out tokens via {provider}"
    return total, detail


def _estimate_tts_cost_usd(tts_mode: str, duration_seconds: float, tts_workflow: str | None) -> tuple[float, str]:
    if tts_mode == "local":
        return 0.0, "Local Edge-TTS"

    workflow = (tts_workflow or "").lower()
    chars = max(100, int(duration_seconds * 12))
    if workflow.startswith("runninghub/"):
        return max(0.003, duration_seconds * 0.0008), f"RunningHub TTS ~ {duration_seconds:.1f}s"

    total = (chars / 1000.0) * 0.004
    return total, f"Cloud/API TTS ~ {chars} chars"


def _estimate_media_cost_usd(media_workflow: str | None, frame_count: int, template_type: str, duration_seconds: float) -> tuple[float, str]:
    workflow = (media_workflow or "").lower()
    if template_type == "static" or not workflow:
        return 0.0, "No media generation"

    if template_type == "image":
        if workflow.startswith("runninghub/"):
            return frame_count * 0.015, f"RunningHub image x {frame_count}"
        if workflow.startswith("api/dashscope/"):
            return frame_count * 0.012, f"DashScope image x {frame_count}"
        if workflow.startswith("api/ark/"):
            return frame_count * 0.014, f"ARK image x {frame_count}"
        if workflow.startswith("api/openai/"):
            return frame_count * 0.040, f"OpenAI image x {frame_count}"
        return frame_count * 0.018, f"Image workflow x {frame_count}"

    avg_clip_duration = duration_seconds / max(frame_count, 1)
    if workflow.startswith("runninghub/"):
        return frame_count * max(0.03, avg_clip_duration * 0.012), f"RunningHub video x {frame_count}"
    if workflow.startswith("api/kling/"):
        return frame_count * max(0.05, avg_clip_duration * 0.018), f"Kling video x {frame_count}"
    if workflow.startswith("api/dashscope/"):
        return frame_count * max(0.04, avg_clip_duration * 0.014), f"DashScope video x {frame_count}"
    if workflow.startswith("api/ark/"):
        return frame_count * max(0.045, avg_clip_duration * 0.015), f"ARK video x {frame_count}"
    return frame_count * max(0.04, avg_clip_duration * 0.014), f"Video workflow x {frame_count}"


def estimate_video_cost(
    *,
    llm_base_url: str,
    llm_model: str,
    text_length: int,
    mode: str,
    frame_count: int,
    duration_seconds: float,
    tts_mode: str,
    tts_workflow: str | None,
    media_workflow: str | None,
    template_type: str,
) -> CostEstimate:
    provider = _detect_llm_provider(llm_base_url, llm_model)
    llm_cost, llm_detail = _estimate_llm_cost_usd(provider, text_length, frame_count, mode)
    tts_cost, tts_detail = _estimate_tts_cost_usd(tts_mode, duration_seconds, tts_workflow)
    media_cost, media_detail = _estimate_media_cost_usd(media_workflow, frame_count, template_type, duration_seconds)

    breakdown = [
        {"name": "LLM", "usd": llm_cost, "detail": llm_detail},
        {"name": "TTS", "usd": tts_cost, "detail": tts_detail},
        {"name": "Media", "usd": media_cost, "detail": media_detail},
    ]
    assumptions = [
        "This is a best-effort estimate, not actual provider billing.",
        "LLM cost is inferred from text length and typical token ratios.",
        "Media/TTS costs are approximated from workflow/provider families.",
    ]
    total = sum(item["usd"] for item in breakdown)
    return CostEstimate(total_usd=total, breakdown=breakdown, assumptions=assumptions)
