FROM python:3.12-slim

# Pin a reviewed self-hosted release with atomic /api/jobs/{job_id}/cancel support.
ARG COMFYUI_REF=a99d1f9c14f4594fe1e9d7e17c1997bf104d89fb
WORKDIR /opt/comfyui
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates libgl1 libglib2.0-0 libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && git init . \
    && git remote add origin https://github.com/Comfy-Org/ComfyUI.git \
    && git fetch --depth 1 origin "$COMFYUI_REF" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$COMFYUI_REF"
RUN pip install --no-cache-dir \
      torch==2.9.1 torchvision==0.24.1 torchaudio==2.9.1 \
      --index-url https://download.pytorch.org/whl/cu128 \
    && pip install --no-cache-dir -r requirements.txt
RUN useradd --uid 1000 --create-home comfy \
    && mkdir -p models custom_nodes input output user \
    && chown -R comfy:comfy /opt/comfyui
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER comfy
EXPOSE 8188
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8188/system_stats', timeout=4).read()"]
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]
