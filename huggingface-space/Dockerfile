FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    ACCENTLAB_HF_SPACE=1 \
    SEED_VC_ROOT=/opt/seed-vc \
    SPACE_PORT=7860 \
    GRADIO_TEMP_DIR=/tmp/gradio \
    ACCENTLAB_OUTPUT_DIR=/tmp/accentlab_outputs \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt

COPY install_deps.py /app/install_deps.py
RUN python /app/install_deps.py

COPY app.py /app/app.py
EXPOSE 7860
CMD ["python", "/app/app.py"]
